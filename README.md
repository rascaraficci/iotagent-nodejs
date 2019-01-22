# dojot IoT agent base library

This library contains all common operations that a IoT agent might need from
dojot. This includes receiving notifications related to device operations, such
as creation, deletion and updates, as well as methods for sending device
data to other components.

## How to install

Just execute

```bash
npm install @dojot/iotagent-nodejs
```

## How to use

This library has one main function, which is `updateAttr`. Furthermore, it
also generated events "device.create", "device.remove", "device.update",
and "device.configure" in "iotagent.device" subject. The `updateAttr` function
and all events are shown in the folloing code.

```javascript
var iotagentLib = require('@dojot/iotagent-nodejs');
var logger = require("@dojot/dojot-module-logger").logger;
var util = require("util");

logger.debug("Initializing IoT agent...");
var iotagent = new iotagentLib.IoTAgent();
iotagent.init().then(() => {
    logger.debug("... IoT agent was initialized");

    logger.debug("Registering callbacks for device events...");
    let deviceId = undefined;
    iotagent.on('iotagent.device', 'device.create', (tenant, event) => {
        logger.debug(`Got device creation message. Tenant is ${tenant}.`);
        logger.debug(`Data is: ${util.inspect(event)}`);
        logger.debug('Got configure event from Device Manager', event)
        // This is just to get one valid device ID to be used in
        // updateAttr sample.
        deviceId = event.data.id;
    });

    iotagent.on('iotagent.device', 'device.configure', (tenant, event) => {
        logger.debug(`Got device actuation message. Tenant is ${tenant}.`);
        logger.debug(`Data is: ${util.inspect(event)}`);
        logger.debug('Got configure event from Device Manager', event)
    });

    iotagent.on('iotagent.device', 'device.remove', (tenant, event) => {
        logger.debug(`Got device removal message. Tenant is ${tenant}.`);
        logger.debug(`Data is: ${util.inspect(event)}`);
        logger.debug('Got configure event from Device Manager', event)
    });

    iotagent.on('iotagent.device', 'device.update', (tenant, event) => {
        logger.debug(`Got device update message. Tenant is ${tenant}.`);
        logger.debug(`Data is: ${util.inspect(event)}`);
        logger.debug('Got configure event from Device Manager')
    });

    logger.debug("... callbacks for device events were registered.")

    // If there is any configured device, the callback associated to "device.create"
    // event will be called.
    logger.debug("Requesting library to generate event for each device...")
    iotagent.messenger.generateDeviceCreateEventForActiveDevices();
    logger.debug("... event generation was requested.")

    let i = 0;
    const sendMessage = () => {
      i++;
      let msg = {
          "attr1": `this is a sample reading: ${i}`,
      };
      let metadata = {

      };
      if (deviceId != undefined) {
        iotagent.updateAttrs(deviceId, "admin", msg, metadata);
      }
      setTimeout(() => {
        sendMessage();
      }, 2000);
    };

    sendMessage();
});
```

Device events have the following format:

- device.create:

```json
{
  "event": "create",
  "meta": {
    "service": "admin"
  },
  "data": {
    "id": "efac",
    "label" : "Device 1",
    "templates" : [ 1, 2, 3],
    "attrs" : {

    },
    "created" : "2018-02-06T10:43:40.890330+00:00"
  }
}
```

- device.update:

```json
{
  "event": "update",
  "meta": {
    "service": "admin"
  },
  "data": {
    "id": "efac",
    "label" : "Device 1",
    "templates" : [ 1, 2, 3],
    "attrs" : {

    },
    "created" : "2018-02-06T10:43:40.890330+00:00"
  }
}
```

- device.remove:

```json
{
  "event": "remove",
  "meta": {
    "service": "admin"
  },
  "data": {
    "id": "efac"
  }
}
```

- device.configure:

```json
{
  "event": "configure",
  "meta": {
    "service": "admin"
  },
  "data" : {
    "id" : "efac",
    "attrs": {
      "reset" : 1,
      "step-motor" : "+45"
    }
  }
}
```

In order to execute this code, the following environment variables can be set:

```bash
# These are the default values
export KAFKA_HOSTS="kafka:9092"
export KAFKA_GROUP_ID="iotagent"
export DATA_BROKER_URL="http://data-broker"
export AUTH_URL="http://auth:5000"
export DEVICE_MANAGER_URL="http://device-manager:5000"
```
It is important to notice that KAFKA_GROUP_ID variable must be set to something
different, as this is used by Kafka to select which clients will receive messages
from a particular topic. If not set, all services that uses the same ID will
be selected at random to receive messages, which is probably not what you want.
