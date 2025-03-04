// new-user-recommendations.js
const { Pool } = require('pg');
const axios = require('axios');
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

// Get popular songs as recommendations for new users
async function getPopularSongs(limit = 20, excludeSongIds = []) {
  try {
    // For new users, try to get trending songs from our database
    const query = `
      SELECT 
        s.song_id,
        s.song_name,
        s.album,
        s.primary_artists,
        s.image_url,
        s.media_url,
        COUNT(DISTINCT umh.user_id) AS listener_count
      FROM 
        songs s
      JOIN 
        user_music_history umh ON s.song_id = umh.song_id
      WHERE 
        s.song_id NOT IN (${excludeSongIds.map((_, i) => `$${i + 2}`).join(',') || 'NULL'})
      GROUP BY 
        s.song_id, s.song_name, s.album, s.primary_artists, s.image_url, s.media_url
      ORDER BY 
        listener_count DESC, s.song_name
      LIMIT $1
    `;
    
    const params = [limit, ...excludeSongIds];
    const result = await pgPool.query(query, params);
    
    // If we have enough trending songs in our database, use those
    if (result.rows.length >= limit / 2) {
      return result.rows.map(row => ({
        songId: row.song_id,
        songName: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url,
        score: parseInt(row.listener_count),
        recommendationType: 'popular'
      }));
    } 
    
    // Otherwise, fetch trending/featured songs from Saavn API
    const trendingResponse = await axios.get(`${MUSIC_API_BASE_URL}/api/trending`);
    
    if (!trendingResponse.data || !trendingResponse.data.songs || trendingResponse.data.songs.length === 0) {
      // If Saavn API doesn't return trending songs, use what we have in our database
      return result.rows.map(row => ({
        songId: row.song_id,
        songName: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url,
        score: parseInt(row.listener_count),
        recommendationType: 'popular'
      }));
    }
    
    // Process trending songs from Saavn
    const trendingSongs = trendingResponse.data.songs;
    
    // Queue these songs for processing in the background
    for (const song of trendingSongs) {
      await songDataQueue.add(
        'process-song',
        { songId: song.id, checkSimilar: false },
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
    
    // Return trending songs directly from Saavn API
    return trendingSongs.map(song => ({
      songId: song.id,
      songName: song.song,
      album: song.album,
      artists: song.primary_artists,
      imageUrl: song.image,
      mediaUrl: song.media_url,
      recommendationType: 'trending'
    }));
    
  } catch (error) {
    console.error('Error getting popular songs:', error);
    
    // If all else fails, return whatever we have in our database
    try {
      const fallbackQuery = `
        SELECT 
          song_id, song_name, album, primary_artists, image_url, media_url
        FROM 
          songs
        ORDER BY 
          RANDOM()
        LIMIT $1
      `;
      
      const fallbackResult = await pgPool.query(fallbackQuery, [limit]);
      
      return fallbackResult.rows.map(row => ({
        songId: row.song_id,
        songName: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url,
        recommendationType: 'random'
      }));
    } catch (fallbackError) {
      console.error('Error getting fallback recommendations:', fallbackError);
      return [];
    }
  }
}

// Get recommendations for new users based on their initial genre selections
async function getNewUserRecommendations(userId, selectedGenres = [], limit = 20) {
  try {
    // If user has selected genres during onboarding
    if (selectedGenres && selectedGenres.length > 0) {
      // Store user's initial genre preferences
      for (const genre of selectedGenres) {
        await pgPool.query(
          `INSERT INTO user_music_preferences 
           (preference_id, user_id, genre, preference_weight, created_at) 
           VALUES (
             uuid_generate_v4(), $1, $2, $3, NOW()
           )
           ON CONFLICT (user_id, genre) 
           DO NOTHING`,
          [userId, genre, 5] // Higher initial weight for explicitly selected genres
        );
      }
      
      // Get genre-based recommendations from Saavn
      const genreSongsResponse = await axios.get(
        `${MUSIC_API_BASE_URL}/api/genre-songs?genres=${selectedGenres.join(',')}&limit=${limit}`
      );
      
      if (genreSongsResponse.data && genreSongsResponse.data.songs && genreSongsResponse.data.songs.length > 0) {
        const genreSongs = genreSongsResponse.data.songs;
        
        // Queue these songs for processing in the background
        for (const song of genreSongs) {
          await songDataQueue.add(
            'process-song',
            { songId: song.id, checkSimilar: false },
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
        
        // Return genre-based songs
        return genreSongs.map(song => ({
          songId: song.id,
          songName: song.song,
          album: song.album,
          artists: song.primary_artists,
          imageUrl: song.image,
          mediaUrl: song.media_url,
          recommendationType: 'genre-based'
        }));
      }
    }
    
    // If no genres provided or no genre-based songs found, fall back to popular songs
    return await getPopularSongs(limit);
    
  } catch (error) {
    console.error(`Error getting new user recommendations for user ${userId}:`, error);
    // Fall back to popular songs
    return await getPopularSongs(limit);
  }
}

// Get similar songs for a given song
async function getSimilarSongs(songId, limit = 10) {
  try {
    // First check if song exists in our database
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
    
    // Try to get similar songs from our database first using artist and genre matching
    const similarFromDbQuery = `
      WITH song_info AS (
        SELECT 
          primary_artists, 
          genre
        FROM 
          songs
        WHERE 
          song_id = $1
      )
      SELECT 
        s.song_id,
        s.song_name,
        s.album,
        s.primary_artists,
        s.image_url,
        s.media_url,
        CASE 
          WHEN si.primary_artists IS NOT NULL AND 
               string_to_array(s.primary_artists, ',') && string_to_array(si.primary_artists, ',') 
          THEN 10
          ELSE 0
        END +
        CASE 
          WHEN s.genre = si.genre AND si.genre IS NOT NULL THEN 5
          ELSE 0
        END AS match_score
      FROM 
        songs s
      CROSS JOIN song_info si
      WHERE 
        s.song_id != $1
        AND (
          (si.primary_artists IS NOT NULL AND 
           string_to_array(s.primary_artists, ',') && string_to_array(si.primary_artists, ','))
          OR 
          (s.genre = si.genre AND si.genre IS NOT NULL)
        )
      ORDER BY 
        match_score DESC, s.song_name
      LIMIT $2
    `;
    
    const similarFromDb = await pgPool.query(similarFromDbQuery, [songId, limit]);
    
    // If we have enough similar songs in our database, use those
    if (similarFromDb.rows.length >= limit / 2) {
      return similarFromDb.rows.map(row => ({
        songId: row.song_id,
        songName: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url,
        score: parseFloat(row.match_score),
        recommendationType: 'similar'
      }));
    }
    
    // Otherwise, fetch similar songs from Saavn API
    const similarResponse = await axios.get(`${MUSIC_API_BASE_URL}/api/similar-songs/${songId}`);
    
    if (!similarResponse.data || !similarResponse.data.songs || similarResponse.data.songs.length === 0) {
      // If Saavn API doesn't return similar songs, use what we have from our database
      return similarFromDb.rows.map(row => ({
        songId: row.song_id,
        songName: row.song_name,
        album: row.album,
        artists: row.primary_artists,
        imageUrl: row.image_url,
        mediaUrl: row.media_url,
        score: parseFloat(row.match_score),
        recommendationType: 'similar-from-db'
      }));
    }
    
    // Process similar songs from Saavn
    const similarSongs = similarResponse.data.songs;
    
    // Queue these songs for processing in the background
    for (const song of similarSongs) {
      await songDataQueue.add(
        'process-song',
        { songId: song.id, checkSimilar: false },
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
    
    // Return similar songs from Saavn API
    return similarSongs.map(song => ({
      songId: song.id,
      songName: song.song,
      album: song.album,
      artists: song.primary_artists,
      imageUrl: song.image,
      mediaUrl: song.media_url,
      recommendationType: 'similar-from-api'
    }));
    
  } catch (error) {
    console.error(`Error getting similar songs for song ${songId}:`, error);
    return [];
  }
}

// Check if user is new (has little or no listening history)
async function isNewUser(userId) {
  try {
    const historyCountQuery = `
      SELECT COUNT(*) as listen_count
      FROM user_music_history
      WHERE user_id = $1
    `;
    
    const result = await pgPool.query(historyCountQuery, [userId]);
    const listenCount = parseInt(result.rows[0].listen_count);
    
    return listenCount < 5; // Consider user "new" if they have less than 5 listens
  } catch (error) {
    console.error(`Error checking if user ${userId} is new:`, error);
    return true; // Assume new user if there's an error
  }
}

module.exports = {
  getPopularSongs,
  getNewUserRecommendations,
  getSimilarSongs,
  isNewUser
};