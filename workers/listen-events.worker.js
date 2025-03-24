// workers/listen-events.worker.js
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { asyncRedis } = require('../config/redis');
const { songDataQueue, matchCalculationQueue } = require('../config/queue');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
// PostgreSQL connection
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'musicapp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync(path.resolve(__dirname, "./ca.pem")).toString(),
  },
});

// Create worker to process song listen events
const listenWorker = new Worker('song-listen-queue', async (job) => {
  const { userId, song, duration = 0 } = job.data;
  
  console.log(`Processing listen event: User ${userId} listened to song ${song} for ${duration}s`);
  
  try {
    const songCheck = await pool.query('SELECT song_id FROM songs WHERE song_id = $1', [song]);
    if (songCheck.rows.length === 0) {
        // Fetch song data from Saavn API via our FastAPI service
    let songData=song;
  
    // Store song in database if it doesn't exist or update if it does
    const query = `
      INSERT INTO songs (
        song_id, song_name, album, primary_artists, singers, 
        image_url, media_url, lyrics, duration, release_year, 
        language, copyright_text, genre,album_url
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,$14)
      ON CONFLICT (song_id) 
      DO UPDATE SET
        song_name = EXCLUDED.song_name,
        album = EXCLUDED.album,
        primary_artists = EXCLUDED.primary_artists,
        singers = EXCLUDED.singers,
        image_url = EXCLUDED.image_url,
        media_url = EXCLUDED.media_url,
        lyrics = EXCLUDED.lyrics,
        duration = EXCLUDED.duration,
        release_year = EXCLUDED.release_year,
        language = EXCLUDED.language,
        copyright_text = EXCLUDED.copyright_text,
        genre = EXCLUDED.genre,
        album_url=EXCLUDED.album_url
        
    `;
    const values = [
      songData.id,
      songData.song,
      songData.album,
      songData.primary_artists,
      songData.singers,
      songData.image,
      songData.media_url,
      songData.lyrics,
      songData.duration,
      songData.year,
      songData.language,
      songData.copyright_text,
      
      songData.genre || inferGenreFromArtists(songData.primary_artists) // Try to infer genre if not provided
      ,songData.album_url ||"",
    ];
    
    await pool.query(query, values);
    
    console.log(`Stored song ${songData.id} in database`);
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
      [uuidv4(), userId, song.id]
    );
    
    console.log(`Recorded listen event for user ${userId}, song ${song.id}`);
    
    // Update user's music profile (artist and genre preferences)
    await updateUserMusicProfile(userId, song.id, duration);
    
    // // Queue match recalculation
    // await queueMatchRecalculation(userId);
    
    // Invalidate recommendation caches
    // await asyncRedis.del(`recommendations:songs:${userId}`);
    // await asyncRedis.del(`recommendations:users:${userId}`);
    
    return { success: true, userId, songId:song.id };
    
  } catch (error) {
    console.error(`Error processing listen event for user ${userId}, song ${song.id}:`, error);
    throw error;
  }
}, {
  connection: {
    url: process.env.REDIS_URL
  },
  concurrency: 10 // Process 10 listen events at a time
});
function inferGenreFromArtists(artistsString) {
  if (!artistsString) return null;
  
  const artists = artistsString.toLowerCase();
  
  // Very simplistic genre inference - in a real app, you'd use a more sophisticated approach
  const genreKeywords = {
    'rock': ['rock', 'metal', 'band', 'guitarist'],
    'pop': ['pop', 'boy band', 'girl band'],
    'hip hop': ['rap', 'hip hop', 'rapper', 'mc'],
    'r&b': ['r&b', 'rnb', 'soul'],
    'electronic': ['dj', 'electronic', 'edm', 'house', 'techno'],
    'classical': ['orchestra', 'classical', 'symphony'],
    'jazz': ['jazz', 'blues', 'saxophone'],
    'country': ['country', 'western']
  };
  
  for (const [genre, keywords] of Object.entries(genreKeywords)) {
    for (const keyword of keywords) {
      if (artists.includes(keyword)) {
        return genre;
      }
    }
  }
  
  return null; // No genre match
}
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