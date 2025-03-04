// workers/index.js
require('dotenv').config();
const { QueueScheduler } = require('bullmq');

// Import workers
require('./listen-events.worker');
require('./song-data.worker');
require('./match-calculation.worker');


// Set up queue schedulers (for handling delayed jobs and retries)
const listenQueueScheduler = new QueueScheduler('song-listen-queue', {
  connection: {
url: process.env.REDIS_URL
  }
});

const songDataQueueScheduler = new QueueScheduler('song-data-queue', {
  connection: {
url: process.env.REDIS_URL
  }
});

const matchCalculationQueueScheduler = new QueueScheduler('match-calculation-queue', {
  connection: {
    url: process.env.REDIS_URL
  }
});

// const notificationQueueScheduler = new QueueScheduler('notification-queue', {
//   connection: {
//     host: process.env.REDIS_HOST || 'localhost',
//     port: process.env.REDIS_PORT || 6379,
//     password: process.env.REDIS_PASSWORD
//   }
// });

// Handle process termination
async function shutdown() {
  console.log('Shutting down queue schedulers...');
  
  await Promise.all([
    listenQueueScheduler.close(),
    songDataQueueScheduler.close(),
    matchCalculationQueueScheduler.close(),
    // notificationQueueScheduler.close()
  ]);
  
  console.log('Queue schedulers shut down.');
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('Worker manager initialized all workers and schedulers');