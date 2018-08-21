"use strict";

var iotagent = require('../../lib/index');
var express = require('express');
var bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json()); // for parsing application/json

const iota = new iotagent.IoTAgent();


/* Initializes iotagent library, allowing us to receive notifications from dojot */
iota.init();

/*
  The following iota calls may be used for initializing the agent.
  Here, they do nothing but print existing device data
*/
iota.listTenants()
      .then((tenants) => {
        for (let t of tenants) {
          iota.listDevices(t, {}).then((devices) => {
            console.log('got device list for [%s]', t, devices);
            for (let d of devices) {
              iota.getDevice(d, t).then((deviceinfo) => {
                // console.log(' --- Device config for (%s)\n', d, deviceinfo);
              })
            }
          })
        }
      })
      .catch((error) => {console.error(error)});

/*
  The following exemplifies registering action callbacks from dojot (device manager).
  Again, this does nothing but print the id of the updated device.
*/
iota.on('device.create', (event) => {console.log('device [%s] created', event.data.id)});
iota.on('device.update', (event) => {console.log('device [%s] updated', event.data.id)});
iota.on('device.remove', (event) => {console.log('device [%s] removed', event.data.id)});

/* actual sample http/json iotagent implementation follows */

function handleData(req, res) {
  const tenant = req.get('x-tenant-id');
  const device = req.get('x-device-id');
  if ((tenant === undefined)|| (device === undefined)) {
    return res.status(400).send({message: 'missing device and tenant information'});
  }

  console.log('will update', tenant, device, req.body);
  iota.updateAttrs(device, tenant, req.body, {});
  return res.status(200).send();
}

app.put('/*', handleData)
app.post('/*', handleData)

app.listen(80, () => {console.log('--- iotagent running (port 80) ---')})
