// workers/listen-events.worker.js
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { asyncRedis } = require('../config/redis');
const { songDataQueue, matchCalculationQueue } = require('../config/queue');

require('dotenv').config();
// PostgreSQL connection
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'musicapp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Create worker to process song listen events
const listenWorker = new Worker('song-listen-queue', async (job) => {
  const { userId, songId, duration = 0 } = job.data;
  
  console.log(`Processing listen event: User ${userId} listened to song ${songId} for ${duration}s`);
  
  try {
    // Check if song exists in our database, if not add it to the song data queue
    const songCheck = await pool.query('SELECT song_id FROM songs WHERE song_id = $1', [songId]);
    
    if (songCheck.rows.length === 0) {
      console.log(`Song ${songId} not found in database, queueing for processing`);
      
      // Queue song for processing and retrieving from Saavn
      await songDataQueue.add(
        'process-song',
        { songId, checkSimilar: true },
        { 
          removeOnComplete: true,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000
          }
        }
      );
    }
    
    // Record listen event in database
    await pool.query(
      `INSERT INTO user_music_history (
         history_id, user_id, song_id, play_count, last_played, created_at
       )
       VALUES (
         $1, $2, $3, 1, NOW(), NOW()
       )
       ON CONFLICT (user_id, song_id)
       DO UPDATE SET
         play_count = user_music_history.play_count + 1,
         last_played = NOW()`,
      [uuidv4(), userId, songId]
    );
    
    console.log(`Recorded listen event for user ${userId}, song ${songId}`);
    
    // Update user's music profile (artist and genre preferences)
    await updateUserMusicProfile(userId, songId, duration);
    
    // Queue match recalculation
    await queueMatchRecalculation(userId);
    
    // Invalidate recommendation caches
    await asyncRedis.del(`recommendations:songs:${userId}`);
    await asyncRedis.del(`recommendations:users:${userId}`);
    
    return { success: true, userId, songId };
    
  } catch (error) {
    console.error(`Error processing listen event for user ${userId}, song ${songId}:`, error);
    throw error;
  }
}, {
  connection: {
    url: process.env.REDIS_URL
  },
  concurrency: 10 // Process 10 listen events at a time
});

// Update user's music profile based on listening
async function updateUserMusicProfile(userId, songId, duration) {
  try {
    // Get song details
    const songQuery = 'SELECT primary_artists, genre FROM songs WHERE song_id = $1';
    const songResult = await pool.query(songQuery, [songId]);
    
    if (songResult.rows.length === 0) {
      console.warn(`Song ${songId} not found in database for profile update`);
      return;
    }
    
    const song = songResult.rows[0];
    
    // Parse artists (they might be comma-separated)
    const artists = song.primary_artists ? 
      song.primary_artists.split(',').map(artist => artist.trim()) : 
      [];
    
    // Update artist preferences
    for (const artist of artists) {
      if (artist) {
        await pool.query(
          `INSERT INTO user_music_preferences 
           (preference_id, user_id, artist, preference_weight, created_at) 
           VALUES (
             $1, $2, $3, $4, NOW()
           )
           ON CONFLICT (user_id, artist) 
           DO UPDATE SET 
             preference_weight = user_music_preferences.preference_weight + $4,
             updated_at = NOW()`,
          [uuidv4(), userId, artist, Math.min(duration / 30, 1)] // Weight based on listen duration
        );
      }
    }
    
    // Update genre preferences (if available)
    if (song.genre) {
      await pool.query(
        `INSERT INTO user_music_preferences 
         (preference_id, user_id, genre, preference_weight, created_at) 
         VALUES (
           $1, $2, $3, $4, NOW()
         )
         ON CONFLICT (user_id, genre) 
         DO UPDATE SET 
           preference_weight = user_music_preferences.preference_weight + $4,
           updated_at = NOW()`,
        [uuidv4(), userId, song.genre, Math.min(duration / 30, 1)]
      );
    }
    
    console.log(`Updated music preferences for user ${userId}`);
  } catch (error) {
    console.error(`Error updating music profile for user ${userId}:`, error);
    throw error;
  }
}

// Queue user for match recalculation
async function queueMatchRecalculation(userId) {
  try {
    // Add to Redis set of users needing match recalculation
    await asyncRedis.sadd('match:recalculate', userId);
    
    // Set expiration to ensure we don't keep users in the queue forever
    await asyncRedis.expire('match:recalculate', 86400); // 24 hours
    
    // Queue a job to process match recalculations, with some delay to batch requests
    await matchCalculationQueue.add(
      'recalculate-matches',
      { triggerUserId: userId },
      { 
        delay: 60000, // Wait 60 seconds to collect more changes
        removeOnComplete: true,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000
        }
      }
    );
    
    console.log(`Queued match recalculation for user ${userId}`);
  } catch (error) {
    console.error(`Error queueing match recalculation for user ${userId}:`, error);
    throw error;
  }
}

// Handle worker events
listenWorker.on('completed', job => {
  console.log(`Job ${job.id} completed successfully`);
});

listenWorker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed with error:`, err);
});

console.log('Song listen worker started');