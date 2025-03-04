// redis-config.js
const Redis = require('redis');
const { Queue, Worker } = require('bullmq');
const { promisify } = require('util');
const { url } = require('inspector');
require('dotenv').config();

// Redis client for caching and pub/sub
const createRedisClient = () => {
  const client = Redis.createClient({
url: process.env.REDIS_URL 
  });

  client.on('error', (err) => {
    console.error('Redis Error:', err);
  });

  client.on('connect', () => {
    console.log('Connected to Redis');
  });

  return client;
};

// Create Redis clients
const cacheClient = createRedisClient();
const pubSubClient = createRedisClient();
const subscriberClient = createRedisClient();

// Promisify Redis commands for the cache client
const redisGet = promisify(cacheClient.get).bind(cacheClient);
const redisSet = promisify(cacheClient.set).bind(cacheClient);
const redisDel = promisify(cacheClient.del).bind(cacheClient);
const redisSadd = promisify(cacheClient.sadd).bind(cacheClient);
const redisSmembers = promisify(cacheClient.smembers).bind(cacheClient);
const redisSrem = promisify(cacheClient.srem).bind(cacheClient);
const redisExpire = promisify(cacheClient.expire).bind(cacheClient);

// Set up Pub/Sub channels
const CHANNELS = {
  SONG_LISTEN: 'song:listen',
  USER_UPDATE: 'user:update',
  MATCH_UPDATE: 'match:update'
};

// Subscribe to channels
subscriberClient.subscribe(CHANNELS.SONG_LISTEN);
subscriberClient.subscribe(CHANNELS.USER_UPDATE);

// Set up BullMQ queues for reliable background processing
const listenQueue = new Queue('song-listen-queue', {
  connection: {
  url: process.env.REDIS_URL 
  }
});

const matchCalculationQueue = new Queue('match-calculation-queue', {
  connection: {
  url: process.env.REDIS_URL
  }
});

const songDataQueue = new Queue('song-data-queue', {
  connection: {
    url: process.env.REDIS_URL 
  }
});

module.exports = {
  cacheClient,
  pubSubClient,
  subscriberClient,
  redisGet,
  redisSet,
  redisDel,
  redisSadd,
  redisSmembers,
  redisSrem,
  redisExpire,
  CHANNELS,
  listenQueue,
  matchCalculationQueue,
  songDataQueue
};