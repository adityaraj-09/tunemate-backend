// routes/recommendation.routes.js
const express = require('express');
const router = express.Router();
const { asyncRedis } = require('../config/redis');
const Song = require('../models/Song');
const MusicHistory = require('../models/MusicHistory');
const MusicPreference = require('../models/MusicPreference');
const User = require('../models/User');
const Match = require('../models/Match');
const { songDataQueue } = require('../config/queue');
const UserLocation = require('../models/UserLocation');
const UserPreference = require('../models/UserPreference');

/**
 * @route   GET /api/recommendations/songs
 * @desc    Get song recommendations for user
 * @access  Private
 */
router.get('/songs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    // Check Redis cache first
    const cacheKey = `recommendations:songs:${req.user.id}`;
    const cachedRecommendations = await asyncRedis.get(cacheKey);
    
    if (cachedRecommendations) {
      return res.json(JSON.parse(cachedRecommendations));
    }
    
    // Check if user is new (has little or no listening history)
    const isNewUser = await MusicHistory.isNewUser(req.user.id);
    
    let recommendations = [];
    
    if (isNewUser) {
      // Get user's genre preferences if they've set them during onboarding
      const preferences = await MusicPreference.getPreferences(req.user.id);
      const genres = preferences?.genres || [];
      
      // Get recommendations for new user
      recommendations = await getNewUserRecommendations(req.user.id, genres, limit);
    } else {
      // For users with history, get collaborative and content-based recommendations
      // const collaborativeRecs = await getCollaborativeSongRecommendations(req.user.id, Math.floor(limit / 2));
      const contentRecs = await getContentBasedSongRecommendations(req.user.id, Math.floor(limit / 2));
      
      // Combine and deduplicate recommendations
      const combinedRecs = [ ...contentRecs];
      const uniqueRecs = [];
      const songIds = new Set();
      
      for (const rec of combinedRecs) {
        if (!songIds.has(rec.id)) {
          songIds.add(rec.id);
          uniqueRecs.push(rec);
          
          if (uniqueRecs.length >= limit) {
            break;
          }
        }
      }
      
      recommendations = uniqueRecs;
      
      // If we still don't have enough recommendations, add popular songs
      if (recommendations.length < limit) {
        // Get songs user has already heard
        const userSongs = await MusicHistory.getUserHistory(req.user.id);
        const userSongIds = userSongs.map(song => song.songId);
        // Get popular songs excluding ones user has already heard
        const popularSongs = await Song.getPopular(
          limit - recommendations.length,
          [...userSongIds, ...recommendations.map(rec => rec.id)]
        );
        
        recommendations = [...recommendations, ...popularSongs];
      }
    }
    
    // Cache recommendations
    await asyncRedis.set(
      cacheKey, 
      JSON.stringify({ recommendations }), 
      'EX', 
      isNewUser ? 3600 : 10800  // 1 hour for new users, 3 hours for existing users
    );
    
    res.json({ recommendations });
  } catch (error) {
    console.error('Error getting song recommendations:', error);
    res.status(500).json({ error: 'Server error fetching song recommendations' });
  }
});

/**
 * @route   GET /api/songs/discover
 * @desc    Search for songs by artist, year, and language
 * @access  Public
 */
router.get('/getQueue', async (req, res) => {
  try {
    // Extract search parameters from query string
    const { 
      artist = '',
      year = '',
      language = '',
      limit = 20
    } = req.query;
    
    // Validate that at least one search parameter is provided
    if (!artist && !year && !language) {
      return res.status(400).json({ 
        error: 'Please provide at least one parameter (artist, year, or language)' 
      });
    }
    
    // Build the search query for Saavn API by combining parameters
    let searchQuery = [];
    if (artist) searchQuery.push(artist);
    if (year) searchQuery.push(year);
    if (language) searchQuery.push(language);
    
    const finalQuery = searchQuery.join(' ');
    
    // Call the Saavn API through your FastAPI service
    const MUSIC_API_URL = process.env.MUSIC_API_URL || 'http://localhost:8000';
    const response = await axios.get(
      `${MUSIC_API_URL}/song/?query=${encodeURIComponent(finalQuery)}&songdata=true&limit=${limit}`
    );
    
    if (!response.data || !response.data.songs || response.data.songs.length === 0) {
      return res.status(404).json({ 
        error: 'No songs found matching these criteria',
        query: finalQuery
      });
    }
    
    // Format the song data
    const songs = response.data.songs
    // Queue songs for background processing
    try {
    
      for (const song of songs) {
        // Queue song data processing
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
    } catch (error) {
      console.warn('Could not queue songs for processing:', error);
      // Non-critical error, continue with response
    }
    
    // Return the results
    res.json({
      songs
    });
    
  } catch (error) {
    console.error('Error searching songs from Saavn:', error);
    
    if (error.response && error.response.status) {
      return res.status(error.response.status).json({ 
        error: 'Error from Saavn API', 
        details: error.message 
      });
    }
    
    res.status(500).json({ error: 'Server error when fetching songs' });
  }
});


/**
 * @route   GET /api/recommendations/users
 * @desc    Get user recommendations based on music taste
 * @access  Private
 */
router.get('/users', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    // Check Redis cache first
    const cacheKey = `recommendations:users:${req.user.id}`;
    const cachedRecommendations = await asyncRedis.get(cacheKey);
    
    if (cachedRecommendations) {
      return res.json(JSON.parse(cachedRecommendations));
    }
    
    // Get user's location
    const location = await UserLocation.findByUserId(req.user.id);
    
    if (!location) {
      return res.status(400).json({ error: 'User location not found' });
    }
    
    // Get user's preferences
    const preferences = await UserPreference.findByUserId(req.user.id);
    
    // Use preference defaults if not set
    const userPrefs = {
      preferredGender: preferences?.preferredGender || null,
      minAge: preferences?.minAge || 18,
      maxAge: preferences?.maxAge || 100,
      maxDistance: preferences?.maxDistance || 20 // Smaller distance for discovery
    };
    
    // Find nearby users with high match scores
    const userRecommendations = await getUserRecommendations(
      req.user.id, 
      location, 
      userPrefs, 
      limit
    );
    
    // Cache recommendations for 30 minutes
    await asyncRedis.set(cacheKey, JSON.stringify({ recommendations: userRecommendations }), 'EX', 1800);
    
    res.json({ recommendations: userRecommendations });
  } catch (error) {
    console.error('Error getting user recommendations:', error);
    res.status(500).json({ error: 'Server error fetching user recommendations' });
  }
});

/**
 * @route   GET /api/recommendations/refresh
 * @desc    Refresh recommendations by invalidating cache
 * @access  Private
 */
router.get('/refresh', async (req, res) => {
  try {
    // Invalidate recommendation caches
    await asyncRedis.del(`recommendations:songs:${req.user.id}`);
    await asyncRedis.del(`recommendations:users:${req.user.id}`);
    
    res.json({ message: 'Recommendations refreshed' });
  } catch (error) {
    console.error('Error refreshing recommendations:', error);
    res.status(500).json({ error: 'Server error refreshing recommendations' });
  }
});

/**
 * Get recommendations for new users
 * 
 * @param {string} userId - User ID
 * @param {Array<string>} genres - User's preferred genres
 * @param {number} limit - Maximum number of recommendations
 * @returns {Promise<Array<Object>>} Song recommendations
 */
async function getNewUserRecommendations(userId, genres, limit) {
  // If user has selected genres during onboarding, use them
  if (genres && genres.length > 0) {
    const recommendations = [];
    
    // Get songs for each genre
    for (const genre of genres) {
      const genreSongs = await Song.getByGenre(genre, Math.ceil(limit / genres.length));
      recommendations.push(...genreSongs);
      
      if (recommendations.length >= limit) {
        break;
      }
    }
    
    // Deduplicate
    const uniqueRecs = [];
    const songIds = new Set();
    
    for (const rec of recommendations) {
      if (!songIds.has(rec.id)) {
        songIds.add(rec.id);
        uniqueRecs.push(rec);
        
        if (uniqueRecs.length >= limit) {
          break;
        }
      }
    }
    
    if (uniqueRecs.length >= limit / 2) {
      return uniqueRecs.slice(0, limit);
    }
  }
  
  // Fallback to popular/trending songs
  try {
    // Try to get songs from Saavn API
    const MUSIC_API_URL = process.env.MUSIC_API_URL || 'http://localhost:8000';
    const response = await axios.get(`${MUSIC_API_URL}/api/trending?limit=${limit}`);
    
    if (response.data && response.data.songs && response.data.songs.length > 0) {
      return response.data.songs;
    }
  } catch (error) {
    console.warn('Error fetching trending songs from Saavn:', error);
    // Continue to fallback
  }
  
  // Final fallback: get popular songs from our database
  return await Song.getPopular(limit);
}

/**
 * Get collaborative filtering song recommendations
 * 
 * @param {string} userId - User ID
 * @param {number} limit - Maximum number of recommendations
 * @returns {Promise<Array<Object>>} Song recommendations
 */
async function getCollaborativeSongRecommendations(userId, limit) {
  // Get users with similar music taste
  const similarUsers = await Match.getSimilarUsers(userId, {
    minScore: 60,
    limit: 20
  });
  
  if (!similarUsers || similarUsers.length === 0) {
    return [];
  }
  
  // Get songs user hasn't listened to but similar users have
  const songs = await MusicHistory.getRecommendationsFromSimilarUsers(
    userId,
    similarUsers.map(u => u.userId),
    limit
  );
  
  return songs;
}

/**
 * Get content-based song recommendations
 * 
 * @param {string} userId - User ID
 * @param {number} limit - Maximum number of recommendations
 * @returns {Promise<Array<Object>>} Song recommendations
 */
async function getContentBasedSongRecommendations(userId, limit) {
  // Get user's artist and genre preferences
  const preferences = await MusicPreference.getPreferences(userId);
  
  if (!preferences || (!preferences.genres.length && !preferences.artists.length)) {
    return [];
  }
  
  // Get user's listening history
  const history = await MusicHistory.getUserSongIds(userId);
  
  // Find songs based on user's preferences
  const songs = await Song.getRecommendationsByPreferences(
    userId,
    preferences,
    history,
    limit
  );
  
  return songs;
}

/**
 * Get user recommendations based on music taste and location
 * 
 * @param {string} userId - User ID
 * @param {Object} location - User's location
 * @param {Object} preferences - User's preferences
 * @param {number} limit - Maximum number of recommendations
 * @returns {Promise<Array<Object>>} User recommendations
 */
async function getUserRecommendations(userId, location, preferences, limit) {
  // Find nearby users with high match scores
  const users = await Match.getNearbyUsers(
    userId,
    location,
    preferences,
    limit
  );
  
  // Enrich with user details
  const userIds = users.map(user => user.userId);
  
  if (userIds.length === 0) {
    return [];
  }
  
  const userDetails = await User.getUserDetailsByIds(userIds);
  
  // Combine data
  return users.map(user => ({
    ...user,
    ...userDetails[user.userId]
  }));
}

module.exports = router;