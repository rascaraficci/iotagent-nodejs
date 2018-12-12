"use strict";
var config = require('./config');
var dojotModule = require("@dojot/dojot-module");
var logger = require("@dojot/dojot-module-logger").logger;
var util = require("util");
var axios = require("axios")

var dojotConfig = dojotModule.Config;

class UnknownDeviceError extends Error {}
class UnknownTenantError extends Error {}

class InitializationError extends Error {}

class IoTAgent {

  /**
   * Constructor
   *
   * @throws {{InitializationError}}
   */
  constructor() {

    // list of implementation required callbacks.
    this.messenger = new dojotModule.Messenger("iotagent");
  }

  /**
   * Initialize all required kafka listeners and producers
   */
  init() {
    // Prepare this topic to allow message publishing
    logger.debug("Initializing IoT agent messenger...");
    return this.messenger.init().then(() => {
      logger.debug("... IoT agent messenger was successfully initialized.");
      logger.debug("Creating channel for device-data subject...");
      this.messenger.createChannel(dojotConfig.dojot.subjects.deviceData, "w");
      logger.debug("... channel for device-data was created.");
  
      logger.debug("Registering callback for DeviceManager device subject...");
      this.messenger.on(dojotConfig.dojot.subjects.devices, "message", (tenant, msg) => {
        let parsed = null;
        try {
          parsed = JSON.parse(msg);
        } catch (e) {
          console.error("[iota] Device event is not valid json. Ignoring.");
          return Promise.reject();
        }
        let eventType = `device.${parsed.event}`;
        this.messenger.emit("iotagent.device", tenant, eventType, parsed);
      });
      logger.debug("... callbacks for DeviceManager devices registered.");
      return Promise.resolve();
    }).catch((error) => {
      logger.debug("... failed to initialize the IoT agent messenger. Error: %s",
        error.toString());
      return Promise.reject();
    });
  }

  /**
   * Subscribes to an event from a subject. 
   * @param {string} subject The subject
   * @param {string} event The event
   * @param {function} callback The callback to be executed. It should have
   * two parameters, the tenant (a string) and data (a JSON).
   */
  on(subject, event, callback) {
    this.messenger.on(subject, event, callback)
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
        logger.info(`Getting device from ${config.deviceManager.host}/device/${deviceid}`);
        let url = `${config.deviceManager.host}/device/${deviceid}`;
        let headers = { authorization: `Bearer ${dojotModule.Auth.getManagementToken(tenant)}` };
        let method = "get";
        logger.info(`Parameters are: url: ${url}, headers: ${util.inspect(headers, { depth: null})}, method: ${method}`)
        return axios({url, headers, method})
        .then(response => {
          // logger.error(`requrestdds devices ${util.inspect(response, {depth: null})}`);
          return response.data;
        })
        .catch(error => {
          if (error.response.status == 404) {
            // make device "invalid" for 5 minutes.
            // Notice that if user creates a matching device within the "invalid" time, the device
            // is updated regardless of its validity state.

            throw new UnknownDeviceError();
          }
          logger.error(`error requqestint devices ${util.inspect(error, {depth: null})}`);
          throw error;
        });
      });
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
    };

    let msg = JSON.stringify(event);
    this.messenger.publish(dojotConfig.dojot.subjects.deviceData, tenant, msg);
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
    let meta = {};
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
