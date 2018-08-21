"use strict";
var axios = require("axios");

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
   * Initialize all required kafka listeners and producers
   */
  init(retry) {
    this.initConsumer(retry);
    this.initProducer();
  }

  /**
   * Initialize iotagent kafka consumers (for tenant and device events)
   * @return {[undefined]}
   */
  initConsumer(retry=true) {
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

      function existing_bootstrap(agent) {
        agent.listTenants().then((tenants) => {
          for (let t of tenants) {
            agent.bootstrapTenant(t);
          }

          console.log('[iota] Tenancy context management initialized');
          agent.consumers['tenancy'] = true;
        }).catch((error) => {
          const message = "Failed to acquire existing tenancy contexts."
          console.error(`[iota] ${message} ${retry ? "Retrying." : ""}`);
          if (retry)
            setTimeout(() => {existing_bootstrap(agent)}, 2500);
        })
      }

      if (!this.consumers.hasOwnProperty('tenancy')){
        // console.log('got connect event - tenancy');
        existing_bootstrap(this);
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

      let eventType = `device.${parsed.event}`;

      if (this.registered.hasOwnProperty(eventType)){
        for (let callback of this.registered[eventType]) {
          callback(parsed);
        }
      }
    })

    consumer.on('error', (error) => {
      console.error('[iota:kafka] Consumer for tenant "%s" is errored.', tenant, error);
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
    return Promise
      .resolve()
      .then(() => {
        return axios({
          url: `${this.devm.manager}/internal/device/${deviceid}`,
          headers: { authorization: `Bearer ${getToken(tenant)}` },
          method: 'get'
        })
        .then(response => {
          return response.data;
        })
        .catch(error => {
          if (error.response.status == 404) {
            // make device "invalid" for 5 minutes.
            // Notice that if user creates a matching device within the "invalid" time, the device
            // is updated regardless of its validity state.

            throw new UnknownDeviceError();
          }

          throw error;
        });
      });
  }

  /**
   * Retrieves a list of devices (device id only) which match a certain criteria
   *
   * @param  {[string]}    tenant    Tenant id whose devices are to be retrieved
   * @return {[Promise]}             List of ids of known devices in the platform, for the given tenant
   */
  listDevices(tenant) {
    // for now this ignores the query parameter
    // TODO implement query filtering
    return axios({
      url: `${this.devm.manager}/device?idsOnly`,
      headers: { authorization: `Bearer ${getToken(tenant)}`},
      method: 'get'
    })
    .then(response => response.data);
  }

  /**
   * Lists current known tenants in the platform
   * @return {[Promise]}  List of known tenants in the platform
   */
  listTenants() {
    return axios({
      url: `${this.auth.manager}/admin/tenants`
    })
    .then(response => response.data.tenants);
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
    if (!metadata) {
      console.error(`Failed to vadidate event. Device metadata must be passed to the function`);
      return;
    }

    if (!metadata.hasOwnProperty('deviceid')) {
      metadata.deviceid = deviceid;
    }

    if (!metadata.hasOwnProperty('tenant')) {
      metadata.tenant = tenant;
    }

    if (!metadata.hasOwnProperty('timestamp')) {
      metadata.timestamp = Date.now();
    }
    return metadata;
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
    let event = {
      "metadata": this.checkCompleteMetaFields(deviceid, tenant, metadata),
      "attrs": attrs
    }
    this.producer.sendEvent(tenant, this.iota.subject, event)
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

module.exports = {
  IoTAgent: IoTAgent,
  UnknownDeviceError: UnknownDeviceError,
  UnknownTenantError: UnknownTenantError,
  InitializationError: InitializationError
};
