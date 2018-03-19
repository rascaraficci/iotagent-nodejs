'use strict';

var config = {};

config.device_manager_address = process.env.DEVM_ADDRESS || "device-manager:5000"
config.auth_address = process.env.AUTH_ADDRESS || "auth:5000"
config.data_broker_address = process.env.DATA_BROKER_ADDRESS || "data-broker:80"
config.kafka_address = process.env.KAFKA_ADDRESS || "kafka:9092"

module.exports = config;
