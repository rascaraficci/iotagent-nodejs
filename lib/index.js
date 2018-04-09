"use strict";
var axios = require("axios");
var Cache = require('ttl-mem-cache');

var kafka = require('./kafka');
var getToken = require('./auth');

var config = require('./config');

class UnknownDeviceError extends Error {}
class UnknownTenantError extends Error {}

class InitializationError extends Error {}


const DEVICE_MANAGER_DEFAULTS = {
  "subject": "dojot.device-manager.device",
  "manager": "http://" + config.device_manager_address
}

const TENANCY_MANAGER_DEFAULTS = {
  "subject": "dojot.tenancy",
  "manager": "http://" + config.auth_address
}

const IOTAGENT_DEFAULTS = {
  "subject": "device-data"
}

const KAFKA_DEFAULTS = {
  "manager": "http://" + config.data_broker_address,
  "kafkaHost": config.kafka_address,
  "sessionTimeout": "15000",
  "groupId": 'iotagent-' + Math.floor(Math.random() * 10000)
}

class IoTAgent {

  /**
   * Constructor
   *
   * @param {[object]}    config      IoT agent basic configuration object.
   * @throws {{InitializationError}}
   */
  constructor(config) {
    this.parseConfig(config);

    // list of implementation required callbacks.
    this.registered = {};

    /*
     * For some reason a kafka consumer connection will trigger "connect" event for all
     * ConsumerGroups in this process (regardless of groupId). This is used for bookkeeping
     * already initialized consumers, so we don't enter an infinite loop.
     *
     * TODO check why 'connection' event is broadcast.
     */
    this.consumers = {};

    this.ttl = 1 * 60 * 1000; // a minute
    this.cache = new Cache({'ttl': this.ttl});
    this.cacheCleaner = setInterval(() => {
      const before = this.cache.length();
      this.cache.prune();
      const after = this.cache.length();
      console.log('[iota] Cache cleanup done: %d entries evicted', before - after);
    }, this.ttl / 3);
  }

  parseConfig(config) {

    function getValues(defaults, given, fields) {
      let updated = given || {};
      for (let f of fields) {
        if ((given === undefined) || !given.hasOwnProperty(f)) {
          updated[f] = defaults[f];
        }
      }
      return updated;
    }

    const given = config || {};
    this.devm = getValues(DEVICE_MANAGER_DEFAULTS, given['device-manager'], ['subject', 'manager']);
    this.auth = getValues(TENANCY_MANAGER_DEFAULTS, given['auth'], ['subject', 'manager']);
    this.iota = getValues(IOTAGENT_DEFAULTS, given['iota'], ['subject']);

  }

  /**
   * Returns normalized cache key
   * @param  {[string]} tenant Tenant id used to compose the key
   * @param  {[string]} device Device id used to compose the key
   * @return {[string]}        Generated key
   */
  getCacheKey(tenant, device) {
    return "device:" + tenant + ":" + device;
  }

  /**
   * Initialize all required kafka listeners and producers
   */
  init() {
    this.initConsumer();
    this.initProducer();
  }

  /**
   * Initialize iotagent kafka consumers (for tenant and device events)
   * @return {[undefined]}
   */
  initConsumer() {
    let consumer = new kafka.Consumer('internal', TENANCY_MANAGER_DEFAULTS.subject, true);

    consumer.on('message', (data) => {
      let parsed = null;
      try {
        parsed = JSON.parse(data.value.toString());
      } catch (e) {
        console.error('Received tenancy event is not valid json. Ignoring.');
        return;
      }

      this.bootstrapTenant(parsed.tenant);
    });

    consumer.on('connect', () => {
      if (!this.consumers.hasOwnProperty('tenancy')){
        // console.log('got connect event - tenancy');
        this.listTenants().then((tenants) => {
          for (let t of tenants) {
            this.bootstrapTenant(t);
          }
        }).catch((error) => {
          const message = "Failed to acquire existing tenancy contexts"
          console.error("[iota] %s\n", message, error);
          throw new InitializationError(message);
        })
        console.log('[iota] Tenancy context management initialized');
        this.consumers['tenancy'] = true;
      } else {
        console.log('[iota:kafka] Tenancy subscription rebalanced')
      }
    })
  }

  /**
   * Given a tenant, initialize the related device event stream ingestor.
   * This usually should not be called by the implementation.
   *
   * @param  {[string]} tenant tenant which ingestion stream is to be initialized
   */
  bootstrapTenant(tenant) {
    const consumerid = tenant + ".device";
    if (this.consumers.hasOwnProperty(consumerid)){
      console.log('[iota] Attempted to re-init device consumer for tenant:', tenant);
      return;
    }

    let consumer = new kafka.Consumer(tenant, this.devm.subject);
    this.consumers[consumerid] = true;

    consumer.on('connect', () => {
      console.log('[iota] Device consumer ready for tenant:', tenant);
    })

    consumer.on('message', (data) => {
      let parsed = null;
      try {
        parsed = JSON.parse(data.value.toString());
      } catch (e) {
        console.error("[iota] Device event is not valid json. Ignoring.");
        return;
      }

      let eventType = ""
      if (parsed.event !== "template.update") {
        eventType = 'device.' + parsed.event;
        const key = this.getCacheKey(tenant, parsed.data.id);
        console.log('[iota] updating device cache for', parsed.data.id)
        switch (parsed.event) {
          case 'create':
          case 'update':
            this.cache.set(key, parsed.data, this.ttl);
            break;
          case 'remove':
            this.cache.del(key);
            break;
        }
      } else {
        eventType = parsed.event;
        // Update device information for all affected devices
        for (let id of parsed.affected) {
          console.log('[iota] updating device cache for', id);
          this.cache.del(this.getCacheKey(tenant, id));
        }
      }

      if (this.registered.hasOwnProperty(eventType)){
        for (let callback of this.registered[eventType]) {
          callback(parsed);
        }
      }
    })

    consumer.on('error', (error) => {
      console.error('[iota:kafka] Consumer for tenant "%s" is errored.', tenant);
    })
  }

  /**
   * Initializes the kafka producer used to send update events to dojot
   */
  initProducer() {
    this.producer = new kafka.Producer();
  }

  /**
   * Given a device id and its associated tenant, retrieve its full configuration.
   *
   * @param  {[string]} deviceid        Device id of the device which configuration is to be retrieved
   * @param  {[string]} tenant          Tenant to whom the given device belongs to
   *
   * @return {[Promise]}                Device configuration data, as available at device-manager
   */
  getDevice(deviceid, tenant) {
    return new Promise((resolve, reject) => {
      const key = this.getCacheKey(tenant, deviceid);
      const cached = this.cache.get(key);
      if (cached) {
        // cache optimization - avoid triggering device query if device is known to be invalid
        if (cached.hasOwnProperty('invalid') && (cached.invalid == true)) {
          return reject(new UnknownDeviceError());
        }

        // cache is to work as an LRU cache
        this.cache.set(key, cached, this.ttl);
        return resolve(cached);
      }

      axios({
        'url': this.devm.manager + '/device/' + deviceid,
        'headers': {'authorization': 'Bearer ' + getToken(tenant)},
        'method': 'get'
      }).then((response) => {
        let value = {'meta': {'service': tenant}, 'data': response.data }
        this.cache.set(key, response.data, this.ttl);
        resolve(response.data);
      }).catch((error) => {
        if (error.response.status == 404) {
          // make device "invalid" for 5 minutes.
          // Notice that if user creates a matching device within the "invalid" time, the device
          // is updated regardless of its validity state.
          this.cache.set(key, {invalid: true}, 5 * 60 * 1000);
          return reject(new UnknownDeviceError());
        }
        reject(error);
      })
    })
  }

  /**
   * Retrieves a list of devices (device id only) which match a certain criteria
   *
   * @param  {[string]}    tenant    Tenant id whose devices are to be retrieved
   * @param  {[object]}    query     Custom query definition object. Devices returned will have to
   *                                 match given criteria (only attribute equality supported)
   * @return {[Promise]}             List of ids of known devices in the platform, for the given tenant
   */
  listDevices(tenant, query) {
    // for now this ignores the query parameter
    // TODO implement query filtering
    return new Promise((resolve, reject) => {
      axios({
        'url': this.devm.manager + '/device?idsOnly',
        'headers': {'authorization': 'Bearer ' + getToken(tenant)},
        'method': 'get'
      }).then((response) => {
        resolve(response.data)
      }).catch((error) => {
        reject(error);
      });
    })
  }

  /**
   * Lists current known tenants in the platform
   * @return {[Promise]}  List of known tenants in the platform
   */
  listTenants() {
    return new Promise((resolve, reject) => {
      axios({
        'url': this.auth.manager + '/admin/tenants'
      }).then((response) => {
        resolve(response.data.tenants);
      }).catch((error) => {
        reject(error);
      })
    })
  }

  /**
   * Register an event handler for a named event.
   *
   * Supported events are:
   *   - device.create
   *   - device.update
   *   - device.remove
   *   - device.command
   *
   * Callback signature is as follows:
   * function callback(error, ctx, eventData)
   *  -
   * @param  {[string]}     event       Event to be watched
   * @param  {Function}     callback    Callback to be invoked on event
   */
  on(event, callback) {
    let registered = [];
    if (this.registered.hasOwnProperty(event)) {
      registered = this.registered[event];
    }

    registered.push(callback);
    this.registered[event] = registered;
  }

  /**
   * Internal method used to fill up required fields when informing updates to dojot
   * @param  {[string]} deviceid Device to be updated
   * @param  {[string]} tenant   Tenant which device belongs to
   * @param  {[object]} metadata Device metadata that accompanies the event
   * @return {[object]}          Updated metadata (if fields were missing)
   */
  checkCompleteMetaFields(deviceid, tenant, metadata) {
    return new Promise((resolve, reject) => {

      if (!metadata.hasOwnProperty('deviceid')) {
        metadata["deviceid"] = deviceid;
      }

      if (!metadata.hasOwnProperty('tenant')) {
        metadata['tenant'] = tenant;
      }

      if (!metadata.hasOwnProperty('timestamp')) {
        metadata['timestamp'] = Date.now();
      }

      if (!metadata.hasOwnProperty('templates')) {
        this.getDevice(deviceid, tenant).then((info) => {
          metadata.templates = info.templates;
          resolve(metadata);
        }).catch((error) => {
          reject(error);
        })
      } else {
        resolve(metadata);
      }
    })
  }

  /**
   * Send an attribute update request to dojot
   *
   * @param  {[string]}     deviceid  device to be updated
   * @param  {[string]}     tenant    tenant from which device is to be updated
   * @param  {[object]}     attrs     set of attributes to update for device in dojot
   */
  updateAttrs(deviceid, tenant, attrs, metadata) {

    // check mandatory fields
    this.checkCompleteMetaFields(deviceid, tenant, metadata).then((meta) => {
      let event = {
        "metadata": meta,
        "attrs": attrs
      }
      this.producer.sendEvent(tenant, this.iota.subject, event)
    }).catch((error) => {
      console.error(`Failed to vadidate event. Ignoring\n${error}`);
    })
  }

  /**
   * Forcefully mark this device as online within the platform
   *
   * @param {[string]}     deviceid  device to be updated
   * @param {[string]}     tenant    tenant from which device is to be updated
   * @param {[timestamp]}  expires   For how long the status update is valid - if none is given,
   *                                 device becomes offline immediately
   */
  setOnline(deviceid, tenant, expires) {
    const expiresAt = expires || Date.now();
    let meta = {}
    this.checkCompleteMetaFields(deviceid, tenant, meta);
    meta['status'] = {'value': 'online', 'expires': expiresAt}
    this.producer.sendEvent(tenant, this.iota.subject, {"metadata": meta});
  }

  /**
   * Forcefully mark this device as offline within the platform
   *
   * @param {[string]} deviceid device to be updated
   * @param {[string]} tenant   tenant from which device is to be updated
   */
  setOffline(deviceid, tenant) {
    this.setOnline(deviceid, tenant);
  }
}

module.exports = {IoTAgent: IoTAgent, UnknownDeviceError: UnknownDeviceError};
