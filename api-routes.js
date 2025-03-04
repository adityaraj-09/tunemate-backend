// api-routes.js
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const _ = require('lodash');

const { 
  redisGet, 
  redisSet, 
  redisDel,
  listenQueue,
  pubSubClient,
  CHANNELS
} = require('./redis-config');

const {
  getPopularSongs,
  getNewUserRecommendations,
  getSimilarSongs,
  isNewUser
} = require('./new-user-recommendations');

// PostgreSQL connection
const pgPool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'musicapp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Endpoint to get song recommendations for a user
router.get('/recommendations/songs/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;
    
    // Check Redis cache first
    const cacheKey = `recommendations:songs:${userId}`;
    const cachedRecommendations = await redisGet(cacheKey);
    
    if (cachedRecommendations) {
      return res.json(JSON.parse(cachedRecommendations));
    }
    
    // Check if user is new (has little or no listening history)
    const newUser = await isNewUser(userId);
    
    let recommendations = [];
    
    if (newUser) {
      // Get user's genre preferences if they've set them during onboarding
      const genrePrefsQuery = `
        SELECT genre
        FROM user_music_preferences
        WHERE user_id = $1 AND genre IS NOT NULL
      `;
      
      const genrePrefsResult = await pgPool.query(genrePrefsQuery, [userId]);
      const selectedGenres = genrePrefsResult.rows.map(row => row.genre);
      
      // Get recommendations for new user
      recommendations = await getNewUserRecommendations(userId, selectedGenres, parseInt(limit));
    } else {
      // For users with history, use collaborative and content-based recommendations
      
      // Get recommendations from collaborative filtering
      const collaborativeRecs = await getCollaborativeSongRecommendations(userId, Math.floor(parseInt(limit) / 2));
      
      // Get content-based recommendations
      const contentRecs = await getContentBasedSongRecommendations(userId, Math.floor(parseInt(limit) / 2));
      
      // Combine and deduplicate recommendations
      recommendations = [...collaborativeRecs, ...contentRecs];
      recommendations = _.uniqBy(recommendations, 'songId');
      recommendations = recommendations.slice(0, parseInt(limit));
      
      // If we still don't have enough recommendations, add some popular songs
      if (recommendations.length < parseInt(limit)) {
        const userSongsQuery = `
          SELECT song_id
          FROM user_music_history
          WHERE user_id = $1
        `;
        
        const userSongsResult = await pgPool.query(userSongsQuery, [userId]);
        const userSongIds = userSongsResult.rows.map(row => row.song_id);
        
        const popularRecs = await getPopularSongs(
          parseInt(limit) - recommendations.length,
          [...userSongIds, ...recommendations.map(rec => rec.songId)]
        );
        
        recommendations = [...recommendations, ...popularRecs];
      }
    }
    
    // Cache recommendations for 1 hour (new users) or 3 hours (existing users)
    await redisSet(
      cacheKey, 
      JSON.stringify(recommendations), 
      'EX', 
      newUser ? 3600 : 10800
    );
    
    res.json(recommendations);
    
  } catch (error) {
    console.error('Error getting song recommendations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get similar songs to a given song
router.get('/similar-songs/:songId', async (req, res) => {
  try {
    const { songId } = req.params;
    const { limit = 10 } = req.query;
    
    // Check Redis cache first
    const cacheKey = `similar:songs:${songId}`;
    const cachedSimilar = await redisGet(cacheKey);
    
    if (cachedSimilar) {
      return res.json(JSON.parse(cachedSimilar));
    }
    
    // Get similar songs
    const similarSongs = await getSimilarSongs(songId, parseInt(limit));
    
    // Cache similar songs for 1 day
    await redisSet(cacheKey, JSON.stringify(similarSongs), 'EX', 86400);
    
    res.json(similarSongs);
    
  } catch (error) {
    console.error('Error getting similar songs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get potential matches for a user
router.get('/matches/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20, minScore = 60 } = req.query;
    
    // Check Redis cache first
    const cacheKey = `matches:${userId}:${minScore}:${limit}`;
    const cachedMatches = await redisGet(cacheKey);
    
    if (cachedMatches) {
      return res.json(JSON.parse(cachedMatches));
    }
    
    // Get user's preferences
    const userPrefsQuery = 'SELECT preferred_gender, min_age, max_age, max_distance FROM user_preferences WHERE user_id = $1';
    const userPrefsResult = await pgPool.query(userPrefsQuery, [userId]);
    const userPrefs = userPrefsResult.rows[0] || { 
      preferred_gender: null, 
      min_age: 18, 
      max_age: 100, 
      max_distance: 100 
    };
    
    // Get user's location
    const locationQuery = 'SELECT latitude, longitude FROM user_locations WHERE user_id = $1';
    const locationResult = await pgPool.query(locationQuery, [userId]);
    
    if (locationResult.rows.length === 0) {
      return res.status(400).json({ error: 'User location not found' });
    }
    
    const { latitude, longitude } = locationResult.rows[0];
    
    // Find users based on preferences and location
    const potentialMatchesQuery = `
      WITH potential_users AS (
        SELECT 
          u.user_id,
          EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birth_date)) as age,
          (
            6371 * acos(
              cos(radians($1)) * 
              cos(radians(ul.latitude)) * 
              cos(radians(ul.longitude) - radians($2)) + 
              sin(radians($1)) * 
              sin(radians(ul.latitude))
            )
          ) as distance
        FROM users u
        JOIN user_locations ul ON u.user_id = ul.user_id
        JOIN user_preferences up ON u.user_id = up.user_id
        WHERE u.user_id != $3
          AND up.is_visible = TRUE
          AND ($4::VARCHAR IS NULL OR u.gender = $4)
          AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birth_date)) BETWEEN $5 AND $6
          AND (
            6371 * acos(
              cos(radians($1)) * 
              cos(radians(ul.latitude)) * 
              cos(radians(ul.longitude) - radians($2)) + 
              sin(radians($1)) * 
              sin(radians(ul.latitude))
            )
          ) <= $7
      )
      SELECT user_id, distance
      FROM potential_users
    `;
    
    const potentialMatches = await pgPool.query(potentialMatchesQuery, [
      latitude,
      longitude,
      userId,
      userPrefs.preferred_gender,
      userPrefs.min_age,
      userPrefs.max_age,
      userPrefs.max_distance
    ]);
    
    // Calculate music compatibility for each potential match
    const matchResults = [];
    
    for (const match of potentialMatches.rows) {
      // Check for cached score
      const scoreKey = `match:score:${userId}:${match.user_id}`;
      let matchScore = await redisGet(scoreKey);
      
      if (!matchScore) {
        // Calculate match score
        matchScore = await calculateMatchScore(userId, match.user_id);
        
        // Cache score for 24 hours
        await redisSet(scoreKey, matchScore.toString(), 'EX', 86400);
      } else {
        matchScore = parseFloat(matchScore);
      }
      
      if (matchScore >= minScore) {
        // Apply distance adjustment
        const proximityFactor = Math.max(0, 1 - (match.distance / userPrefs.max_distance));
        const adjustedScore = (matchScore * 0.8) + (proximityFactor * 100 * 0.2);
        
        matchResults.push({
          userId: match.user_id,
          score: adjustedScore,
          musicScore: matchScore,
          distance: match.distance
        });
      }
    }
    
    // Sort by score and limit results
    matchResults.sort((a, b) => b.score - a.score);
    const topMatches = matchResults.slice(0, limit);
    
    // Get user details for the matches
    const userIds = topMatches.map(match => match.userId);
    if (userIds.length > 0) {
      const userDetailsQuery = `
        SELECT 
          u.user_id,
          u.username,
          u.first_name,
          u.last_name,
          u.gender,
          u.profile_picture_url,
          u.bio,
          EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birth_date)) as age
        FROM 
          users u
        WHERE 
          u.user_id = ANY($1)
      `;
      
      const userDetailsResult = await pgPool.query(userDetailsQuery, [userIds]);
      const userDetails = {};
      
      userDetailsResult.rows.forEach(user => {
        userDetails[user.user_id] = {
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
          gender: user.gender,
          age: parseInt(user.age),
          profilePicture: user.profile_picture_url,
          bio: user.bio
        };
      });
      
      // Enrich match results with user details
      for (const match of topMatches) {
        match.userDetails = userDetails[match.userId] || {};
      }
    }
    
    // Cache results for 15 minutes
    await redisSet(cacheKey, JSON.stringify(topMatches), 'EX', 900);
    
    res.json(topMatches);
    
  } catch (error) {
    console.error('Error getting matches:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to record a song listen event
router.post('/listen', async (req, res) => {
  try {
    const { userId, songId, duration = 0 } = req.body;
    
    if (!userId || !songId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Add listen event to queue for processing
    await listenQueue.add(
      'process-listen',
      { userId, songId, duration },
      { 
        removeOnComplete: true,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000
        }
      }
    );
    
    // Publish event for real-time subscribers
    pubSubClient.publish(CHANNELS.SONG_LISTEN, JSON.stringify({
      userId, songId, timestamp: new Date().toISOString()
    }));
    
    res.json({ success: true, message: 'Listen event queued for processing' });
    
  } catch (error) {
    console.error('Error recording listen event:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
})
