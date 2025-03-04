// config/redis.js
const Redis = require('redis');
const dotenv = require('dotenv');
dotenv.config();

// Initialize clients
let cacheClient, pubClient, subClient;
let isInitialized = false;
let initPromise = null;

// Initialize Redis clients
const initRedis = async () => {
  if (isInitialized) return;
  
  try {
    // Standard Redis client for caching
    cacheClient = Redis.createClient({ url: process.env.REDIS_URL });
    
    // Dedicated clients for Pub/Sub
    pubClient = Redis.createClient({ url: process.env.REDIS_URL });
    subClient = Redis.createClient({ url: process.env.REDIS_URL });
    
    // Set up error handlers
    cacheClient.on('error', err => console.error('Redis Cache Error:', err));
    pubClient.on('error', err => console.error('Redis Pub Error:', err));
    subClient.on('error', err => console.error('Redis Sub Error:', err));
    
    // Connect all clients
    await Promise.all([
      cacheClient.connect(),
      pubClient.connect(),
      subClient.connect()
    ]);
    
    console.log('Redis connected at', process.env.REDIS_URL);
    isInitialized = true;
  } catch (error) {
    console.error('Error initializing Redis clients:', error);
    throw error;
  }
};

// Create a promise for initialization
if (!initPromise) {
  initPromise = initRedis();
}

// Channel names for Pub/Sub
const CHANNELS = {
  SONG_LISTEN: 'song:listen',
  USER_UPDATE: 'user:update',
  MATCH_UPDATE: 'match:update',
  CHAT_MESSAGE: 'chat:message'
};

// Redis client manager with methods that ensure Redis is initialized
const redisManager = {
  // Method to ensure Redis is initialized before performing operations
  ensureConnection: async () => {
    await initPromise;
    return isInitialized;
  },
  
  // Cache operations
  get: async (key) => {
    await redisManager.ensureConnection();
    return await cacheClient.get(key);
  },
  
  set: async (key, value, ex, seconds) => {
    await redisManager.ensureConnection();
    if (ex === 'EX') {
      return await cacheClient.set(key, value, { EX: seconds });
    }
    return await cacheClient.set(key, value);
  },
  
  del: async (key) => {
    await redisManager.ensureConnection();
    return await cacheClient.del(key);
  },
  
  sadd: async (key, ...members) => {
    await redisManager.ensureConnection();
    return await cacheClient.sAdd(key, members);
  },
  
  srem: async (key, ...members) => {
    await redisManager.ensureConnection();
    return await cacheClient.sRem(key, members);
  },
  
  smembers: async (key) => {
    await redisManager.ensureConnection();
    return await cacheClient.sMembers(key);
  },
  
  expire: async (key, seconds) => {
    await redisManager.ensureConnection();
    return await cacheClient.expire(key, seconds);
  },
  
  // Pub/Sub operations
  publish: async (channel, message) => {
    await redisManager.ensureConnection();
    const jsonMessage = JSON.stringify(message);
    return await pubClient.publish(channel, jsonMessage);
  },
  
  subscribe: async (channel, callback) => {
    await redisManager.ensureConnection();
    return await subClient.subscribe(channel, (message) => {
      try {
        const parsedMessage = JSON.parse(message);
        callback(parsedMessage);
      } catch (error) {
        console.error(`Error parsing message from channel ${channel}:`, error);
      }
    });
  },
  
  // Graceful shutdown
  closeConnections: async () => {
    if (isInitialized) {
      await Promise.all([
        cacheClient.quit(),
        pubClient.quit(),
        subClient.quit()
      ]);
      isInitialized = false;
    }
  }
};

// Setup graceful shutdown
process.on('SIGTERM', redisManager.closeConnections);
process.on('SIGINT', redisManager.closeConnections);

module.exports = {
  asyncRedis: redisManager,
  CHANNELS,
  isRedisReady: () => isInitialized
};