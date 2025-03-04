// listen-worker.js
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const { 
  listenQueue, 
  matchCalculationQueue, 
  songDataQueue,
  redisSet,
  redisDel,
  redisSadd,
  redisExpire
} = require('./redis-config');

// PostgreSQL connection
const pgPool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'musicapp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Worker to process song listen events
const listenWorker = new Worker('song-listen-queue', async (job) => {
  const { userId, songId, duration } = job.data;
  
  try {
    // Check if song exists in our database, if not add it to the song data queue
    const songCheck = await pgPool.query('SELECT song_id FROM songs WHERE song_id = $1', [songId]);
    
    if (songCheck.rows.length === 0) {
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
    
    // Record listen event
    await pgPool.query(
      `INSERT INTO user_music_history (
         history_id, user_id, song_id, play_count, last_played, created_at
       )
       VALUES (
         uuid_generate_v4(), $1, $2, 1, NOW(), NOW()
       )
       ON CONFLICT (user_id, song_id)
       DO UPDATE SET
         play_count = user_music_history.play_count + 1,
         last_played = NOW()`,
      [userId, songId]
    );
    
    // Update user's music profile
    await updateUserMusicProfile(userId, songId, duration);
    
    // Queue match recalculation
    await queueMatchRecalculation(userId);
    
    // Invalidate recommendation caches
    await redisDel(`recommendations:songs:${userId}`);
    await redisDel(`recommendations:users:${userId}`);
    
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
    const songQuery = 'SELECT * FROM songs WHERE song_id = $1';
    const songResult = await pgPool.query(songQuery, [songId]);
    
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
        await pgPool.query(
          `INSERT INTO user_music_preferences 
           (preference_id, user_id, artist, preference_weight, created_at) 
           VALUES (
             uuid_generate_v4(), $1, $2, $3, NOW()
           )
           ON CONFLICT (user_id, artist) 
           DO UPDATE SET 
             preference_weight = user_music_preferences.preference_weight + $3,
             updated_at = NOW()`,
          [userId, artist, Math.min(duration / 30, 1)] // Weight based on listen duration
        );
      }
    }
    
    // Update genre preferences (if available)
    if (song.genre) {
      await pgPool.query(
        `INSERT INTO user_music_preferences 
         (preference_id, user_id, genre, preference_weight, created_at) 
         VALUES (
           uuid_generate_v4(), $1, $2, $3, NOW()
         )
         ON CONFLICT (user_id, genre) 
         DO UPDATE SET 
           preference_weight = user_music_preferences.preference_weight + $3,
           updated_at = NOW()`,
        [userId, song.genre, Math.min(duration / 30, 1)]
      );
    }
  } catch (error) {
    console.error(`Error updating music profile for user ${userId}:`, error);
    throw error;
  }
}

// Queue user for match recalculation
async function queueMatchRecalculation(userId) {
  // Add to Redis set of users needing match recalculation
  await redisSadd('match:recalculate', userId);
  
  // Set expiration to ensure we don't keep users in the queue forever
  await redisExpire('match:recalculate', 86400); // 24 hours
  
  // Queue a job to process match recalculations
  await matchCalculationQueue.add(
    'recalculate',
    { triggerUserId: userId },
    { 
      delay: 60000, // Wait 60 seconds to collect more changes
      removeOnComplete: true 
    }
  );
}

console.log('Listen events worker started');

module.exports = {
  listenWorker
};