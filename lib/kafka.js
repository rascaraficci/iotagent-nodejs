var axios = require("axios");
var {KafkaConsumer, KafkaProducer} = require('dojot-libs');

var getToken = require('./auth.js')
var config = require('./config');

function getRandom() {
  return Math.floor(Math.random() * 10000);
}

const KAFKA_PRODUCER = {
  "metadata.broker.list": config.kafka_address,
  "group.id": 'iotagent-' + getRandom(),
  "request.required.acks":1
}

const KAFKA_CONSUMER = {
  "metadata.broker.list": config.kafka_address,
  "group.id": 'iotagent-' + getRandom()
}

const DATA_BROKER_DEFAULT = "http://" + config.data_broker_address;


class TopicManager {
  constructor() {
    this.topics = {};
  }

  getTopic(subject, tenant, broker, global) {
    const key = tenant + ':' + subject;
    
    if (this.topics.hasOwnProperty(key)) {
      return Promise.resolve(this.topics[key]);
    }

    const querystring = global ? "?global=true" : "";
    const url = `${broker}/topic/${subject + querystring}`

    return axios({
      url,
      method: 'get',
      headers: { authorization: `Bearer ${getToken(tenant)}`}
    })
    .then((response) => {
      this.topics[key] = response.data.topic;
      
      return response.data.topic
    });
  }
}

var tm = new TopicManager();


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
  }

  connectConsumer() {

    return new Promise((resolve, reject) => {
      tm.getTopic(this.subject, this.tenant, this.brokerManager, this.global).then((topic) => {

        let config = KAFKA_CONSUMER;
  
        this.consumer = new KafkaConsumer(KAFKA_CONSUMER);
  
        this.consumer.connect().then(() => {
          this.consumer.subscribe(topic);
          console.log('[iota:kafka] Created consumer (%s)[%s : %s]', config["group.id"], this.subject, topic)
          resolve();
  
        }).catch(() => {
          reject();
        });
  
      }).catch((error) => {
        console.error("[iota:kafka] Failed to acquire topic to subscribe from (device events)\n", error);
        reject();
      });
    });

  }

  onMessage(callback) {
    this.consumer.onMessageListener(callback);
  }

}

class Producer {
  constructor(brokerManager) {
    this.buffer = [];
    this.topics = {};

    this.brokerManager = brokerManager || DATA_BROKER_DEFAULT;

    this.isReady = false;


    this.producer = new KafkaProducer(KAFKA_PRODUCER);
    this.scheduled = null;
    this.registeredSubjects = {};

    this.initProducer();
  }

  initProducer() {

    this.producer.connect().then(() => {

      this.isReady = true;
      
      for(let data of this.buffer) {
        this.sendEvent(data.tenant, data.subject, data.eventData);
      }
      
    }).catch(() => {
      if (this.scheduled) {
        console.log("[iota:kafka] An operation was already scheduled. No need to do it again.");
        return;
      }

      this.producer.disconnect().then(() => {
        console.log("[iota:kafka] Will attempt to reconnect in a few seconds.");
        this.scheduled = setTimeout(() => {
            this.initProducer();
        }, 20000);
      }).catch(() => {
        console.log("[iota:kafka] Error in disconnecting the producer.");
      });
    });
  }

  registerSubject(subject, tenant) {
    return tm.getTopic(subject, tenant, this.brokerManager, false).then((topic) => {
      let key = `${tenant}:${subject}`;
      console.log(`key is: ${key}, topic is ${topic}`)
      this.registeredSubjects[key] = topic;

    });
  }

  /**
   * Sends an event to a given subject of a tenant
   * @param  {[type]} tenant    Tenant to whom event is concerned
   * @param  {[type]} subject   Subject which event belongs to
   * @param  {[type]} eventData Event to be sent
   */
  sendEvent(tenant, subject, eventData) {
    if (this.isReady == false) {
      console.log('[iota:kafka] Producer is not ready yet');
      this.buffer.push({tenant, subject, eventData});
      return;
    }

    let key = `${tenant}:${subject}`;
    let topic = this.registeredSubjects[key];

    let message = {
      "topic": topic,
      "messages": JSON.stringify(eventData)
    };

    // console.log(`publishin - topic: ${topic} -`);
    this.producer.produce(message.topic, message.messages).then(() => {
      // console.log(`Message published - topic: ${topic} -`);
    }).catch( () => {
        console.error("[iota:kafka] Failed to publish data");
        this.producer.disconnect().then(() => {
          this.initProducer();
        });
    });
  }
}

module.exports = {'Consumer': Consumer, 'Producer': Producer};
