'use strict';

var config = {
    deviceManager: {
        host: process.env.DEVICE_MANAGER_URL || "http://device-manager:5000"
    },
};


module.exports = config;
