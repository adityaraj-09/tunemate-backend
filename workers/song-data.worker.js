// workers/song-data.worker.js
const { Worker } = require('bullmq');
const { Pool } = require('pg');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
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

// FastAPI endpoint for retrieving song data from Saavn
const MUSIC_API_URL = process.env.MUSIC_API_URL || 'http://localhost:8000';

// Create worker to process song data
const songDataWorker = new Worker('song-data-queue', async (job) => {
  const { songId, checkSimilar = false,song } = job.data;
  
  console.log(`Processing song data for ${songId}, checkSimilar: ${checkSimilar}`);
  
  try {
    // First check if song already exists in our database
    const existingCheck = await pool.query('SELECT song_id FROM songs WHERE song_id = $1', [songId]);
    
    if (existingCheck.rows.length > 0) {
      console.log(`Song ${songId} already exists in database`);
      
      // If we don't need to check for similar songs, we're done
      if (!checkSimilar) {
        return { success: true, songId, exists: true };
      }
    }

    
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
    
    console.log(`Stored song ${songId} in database`);
    
    // If we need to check for similar songs
    if (checkSimilar) {
      console.log(`Fetching similar songs for ${songId}`);
      
      try {
        // Call Saavn API to get similar songs
        const similarResponse = await axios.get(
          `${MUSIC_API_URL}/api/similar-songs/${songId}`
        );
        
        if (similarResponse.data && similarResponse.data.songs) {
          const similarSongs = similarResponse.data.songs;
          console.log(`Found ${similarSongs.length} similar songs for ${songId}`);
          
          // Queue these songs for processing (but don't check for similar to avoid infinite loop)
          for (const similarSong of similarSongs) {
            await job.queue.add(
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
      } catch (error) {
        // Just log the error but don't fail the job
        console.error(`Error fetching similar songs for ${songId}:`, error);
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
  concurrency: 5 // Process 5 songs at a time to avoid overwhelming the Saavn API
});

// Helper function to infer genre from artist names (very basic)
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

// Handle worker events
songDataWorker.on('completed', job => {
  console.log(`Job ${job.id} completed successfully`);
});

songDataWorker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed with error:`, err);
});

console.log('Song data worker started');