var kafka = require("kafka-node");
var axios = require("axios");
var uuid = require("uuid/v4");

var getToken = require('./auth.js')

function getRandom() {
  return Math.floor(Math.random() * 10000);
}

const KAFKA_DEFAULTS = {
  "kafkaHost": "kafka:9092",
  "sessionTimeout": "15000",
  "groupId": 'iotagent-' + getRandom()
}

const DATA_BROKER_DEFAULT = "http://data-broker:80";

function getTopic(subject, tenant, broker, global) {
  return new Promise((resolve, reject) => {
    axios({
      'url': broker + '/topic/' + subject + (global ? "?global=true" : ""),
      'method': 'get',
      'headers': {'authorization': 'Bearer ' + getToken(tenant)}
    }).then((response) => {
      resolve(response.data.topic);
    }).catch((error) => {
      reject(error);
    })
  })
}

class Consumer {
  /**
   * [constructor description]
   * @param {[string]} tenant        Tenant which devices will be monitored
   * @param {[string]} brokerManager If omitted takes the default "http://data-broker:80"
   * @param {[string]} subject       If omitted takes the default "dojot.device-manager.device"
   */
  constructor(tenant, subject, global, brokerManager){
    this.tenant = tenant;
    this.subject = subject;
    this.global = global || false;
    this.brokerManager = brokerManager || DATA_BROKER_DEFAULT;
    this.callbacks = [];

    getTopic(this.subject, this.tenant, this.brokerManager, this.global).then((topic) => {
      // TODO kafka params should come from config
      let config = KAFKA_DEFAULTS;
      // config.groupId = uuid();
      this.consumer = new kafka.ConsumerGroup(KAFKA_DEFAULTS, topic);
      let cb = this.callbacks.pop();
      while(cb) {
        this.on(cb.event, cb.callback);
        cb = this.callbacks.pop();
      }
      console.log('[iota:kafka] Created consumer (%s)[%s : %s]', config.groupId, this.subject, topic)

    }).catch((error) => {
      console.error("[iota:kafka] Failed to acquire topic to subscribe from (device events)\n", error);
      process.exit(1);
    })
  }

  on(event, callback) {
    if (this.consumer) {
      this.consumer.on(event, callback);
    } else {
      // consumer was not ready yet when call was issued
      this.callbacks.push({'event': event, 'callback': callback});
    }
  }
}

class Producer {
  constructor(brokerManager, broker) {
    this.topics = {};

    this.broker = broker || KAFKA_DEFAULTS.kafkaHost;
    this.brokerManager = brokerManager || DATA_BROKER_DEFAULT;

    this.getTopic.bind(this);

    this.isReady = false;
    this.initProducer();
  }

  initProducer() {
    let client = kafka.Client(this.broker, "iotagent-producer-" + getRandom());
    this.producer = new kafka.HighLevelProducer(client, { requireAcks: 1 });

    this.producer.on('ready', () => {
      this.isReady = true;
    });

    let scheduled = null;
    this.producer.on("error", (e) => {
      if (scheduled) {
        console.log("[iota:kafka] An operation was already scheduled. No need to do it again.");
        return;
      }

      this.producer.close();
      console.error("[iota:kafka] Producer error: ", e);
      console.log("[iota:kafka] Will attempt to reconnect in a few seconds.");
      scheduled = setTimeout(() => {
          this.initDataProducer();
      }, 10000);
    });
  }

  getTopic(tenant, subject) {
    return new Promise((resolve, reject) => {
      if (this.topics.hasOwnProperty(tenant)) {
        if (this.topics[tenant].hasOwnProperty(subject)) {
          return resolve(this.topics[tenant][subject]);
        }
      }

      getTopic(subject, tenant, this.brokerManager, false).then((topic) => {
        if (!this.topics.hasOwnProperty(tenant)) {
          this.topics[tenant] = {};
        }

        this.topics[tenant][subject] = topic;
        return resolve(topic);
      }).catch((error) => {
        reject(error);
      })
    })
  }

  /**
   * Sends an event to a given subject of a tenant
   * @param  {[type]} tenant    Tenant to whom event is concerned
   * @param  {[type]} subject   Subject which event belongs to
   * @param  {[type]} eventData Event to be sent
   */
  sendEvent(tenant, subject, eventData) {
    if (this.isReady == false) {
      console.error('[iota:kafka] Producer is not ready yet');
      return;
    }

    this.getTopic(subject, tenant, this.brokerManager, false).then((topic) => {
      let message = {
        "topic": topic,
        "messages": [JSON.stringify(updateData)]
      };

      this.producer.send([message], (err, result) => {
        if (err) {
          console.error("[iota:kafka] Failed to publish data");
        }
      });
    }).catch((error) => {
      console.error("[iota] Failed to ascertain topic for event")
    })
  }
}

module.exports = {'Consumer': Consumer, 'Producer': Producer};
