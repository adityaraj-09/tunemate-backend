// song-worker.js
const { Worker } = require('bullmq');
const axios = require('axios');
const { Pool } = require('pg');
const { songDataQueue } = require('./redis-config');

// PostgreSQL connection
const pgPool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'musicapp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// FastAPI endpoint for retrieving song data from Saavn
const MUSIC_API_BASE_URL = process.env.MUSIC_API_URL || 'http://fastapi-service:8000';

// Worker to process song data
const songDataWorker = new Worker('song-data-queue', async (job) => {
  const { songId, checkSimilar } = job.data;
  
  try {
    // First check if song already exists in our database
    const existingCheck = await pgPool.query('SELECT song_id FROM songs WHERE song_id = $1', [songId]);
    
    if (existingCheck.rows.length > 0) {
      console.log(`Song ${songId} already exists in database`);
      
      // If we need to find similar songs, proceed even if the song exists
      if (!checkSimilar) {
        return { success: true, songId, exists: true };
      }
    }
    
    // Fetch song data from Saavn API via our FastAPI service
    const songResponse = await axios.get(`${MUSIC_API_BASE_URL}/api/songs/${songId}`);
    
    if (!songResponse.data) {
      throw new Error(`Failed to get data for song ${songId}`);
    }
    
    const songData = songResponse.data;
    
    // Store song in database if it doesn't exist
    if (existingCheck.rows.length === 0) {
      await pgPool.query(
        `INSERT INTO songs (
          song_id, song_name, album, primary_artists, singers, 
          image_url, media_url, lyrics, duration, release_year, 
          language, copyright_text, genre
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (song_id) DO NOTHING`,
        [
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
          songData.genre || null // This might come from genre mapping
        ]
      );
      
      console.log(`Stored song ${songId} in database`);
    }
    
    // If we need to check for similar songs
    if (checkSimilar) {
      // Call Saavn API to get similar songs/playlist
      const similarResponse = await axios.get(
        `${MUSIC_API_BASE_URL}/api/similar-songs/${songId}`
      );
      
      if (similarResponse.data && similarResponse.data.songs) {
        const similarSongs = similarResponse.data.songs;
        
        // Queue these songs for processing (but don't check for similar to avoid infinite loop)
        for (const similarSong of similarSongs) {
          await songDataQueue.add(
            'process-song',
            { songId: similarSong.id, checkSimilar: false },
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
        
        return { 
          success: true, 
          songId, 
          similarSongsCount: similarSongs.length 
        };
      }
    }
    
    return { success: true, songId };
    
  } catch (error) {
    console.error(`Error processing song ${songId}:`, error);
    throw error;
  }
}, {
  connection: {
  url: process.env.REDIS_URL
  },
  concurrency: 5 // Process 5 songs at a time
});

console.log('Song data worker started');

module.exports = {
  songDataWorker
};