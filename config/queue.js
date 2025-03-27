// config/queue.js
const { Queue } = require('bullmq');

require('dotenv').config();
/**
 * Create and configure BullMQ queue
 * 
 * @param {string} name - Queue name
 * @param {Object} options - Additional queue options
 * @returns {Queue} Configured BullMQ queue
 */
const createQueue = (name, options = {}) => {
  return new Queue(name, {
    connection: {
    url: process.env.REDIS_URL
    },
    
    defaultJobOptions: {
      attempts: 3,
    
      
      removeOnComplete: true,
      removeOnFail: 1000, // Keep last 1000 failed jobs
      backoff: {
        type: 'exponential',
        delay: 1000
      }
    },
    ...options
  });
};

// Create queues
const listenQueue = createQueue('song-listen-queue');
const songDataQueue = createQueue('song-data-queue');
const matchCalculationQueue = createQueue('match-calculation-queue');
const notificationQueue = createQueue('notification-queue');

module.exports = {
  listenQueue,
  songDataQueue,
  matchCalculationQueue,
  notificationQueue
};