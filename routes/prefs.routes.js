// routes/preference.routes.js
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const UserPreference = require('../models/UserPreference');

const { publish, CHANNELS } = require('../config/redis');

/**
 * @route   GET /api/preferences
 * @desc    Get user's preferences
 * @access  Private
 */
router.get('/', async (req, res) => {
  try {
    const preferences = await UserPreference.findByUserId(req.user.id);
    
    res.json({ preferences: preferences || null });
  } catch (error) {
    console.error('Error fetching preferences:', error);
    res.status(500).json({ error: 'Server error fetching preferences' });
  }
});

/**
 * @route   POST /api/preferences
 * @desc    Create or update user preferences
 * @access  Private
 */
router.post('/', 
  [
  
    check('preferredGender', 'Preferred gender must be valid').optional(),
    check('minAge', 'Minimum age must be at least 18').optional().isInt({ min: 18 }),
    check('maxAge', 'Maximum age must be at most 100').optional().isInt({ max: 100 }),
    check('maxDistance', 'Maximum distance must be positive').optional().isInt({ min: 1 }),
    check('isVisible', 'Visibility must be a boolean').optional().isBoolean()
  ], 
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { preferredGender, minAge, maxAge, maxDistance, isVisible } = req.body;
      
      // Create or update preferences
      const preferences = await UserPreference.updateOrCreate(req.user.id, {
        preferredGender,
        minAge,
        maxAge,
        maxDistance,
        isVisible
      });
      
      // Publish event for real-time updates
      // publish(CHANNELS.USER_UPDATED, { 
      //   userId: req.user.id, 
      //   type: 'preferences_updated',
      //   data: preferences
      // });
      
      res.json({
        message: 'Preferences updated successfully',
        preferences
      });
    } catch (error) {
      console.error('Error updating preferences:', error);
      res.status(500).json({ error: 'Server error updating preferences' });
    }
  }
);

/**
 * @route   PUT /api/preferences
 * @desc    Update specific preference fields
 * @access  Private
 */
router.put('/', 
  [
  
    check('preferredGender', 'Preferred gender must be valid').optional(),
    check('minAge', 'Minimum age must be at least 18').optional().isInt({ min: 18 }),
    check('maxAge', 'Maximum age must be at most 100').optional().isInt({ max: 100 }),
    check('maxDistance', 'Maximum distance must be positive').optional().isInt({ min: 1 }),
    check('isVisible', 'Visibility must be a boolean').optional().isBoolean()
  ], 
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      // Check if at least one field is provided
      if (Object.keys(req.body).length === 0) {
        return res.status(400).json({ error: 'No update fields provided' });
      }
      
      // Update preferences
      const preferences = await UserPreference.update(req.user.id, req.body);
      
      // // Publish event for real-time updates
      // publish(CHANNELS.USER_UPDATED, { 
      //   userId: req.user.id, 
      //   type: 'preferences_updated',
      //   data: preferences
      // });
      
      res.json({
        message: 'Preferences updated successfully',
        preferences
      });
    } catch (error) {
      console.error('Error updating preferences:', error);
      
      if (error.message === 'User preferences not found') {
        return res.status(404).json({ error: 'Preferences not found. Create them first.' });
      }
      
      res.status(500).json({ error: 'Server error updating preferences' });
    }
  }
);

/**
 * @route   DELETE /api/preferences
 * @desc    Reset user preferences to defaults
 * @access  Private
 */
router.delete('/', async (req, res) => {
  try {
    const deleted = await UserPreference.delete(req.user.id);
    
    if (!deleted) {
      return res.status(404).json({ error: 'No preferences found to delete' });
    }
    
    // Create new default preferences
    const defaultPreferences = await UserPreference.create(req.user.id, {
      preferredGender: null, // Any gender
      minAge: 18,
      maxAge: 100,
      maxDistance: 100,
      isVisible: true
    });
    
    // Publish event for real-time updates
    // publish(CHANNELS.USER_UPDATED, { 
    //   userId: req.user.id, 
    //   type: 'preferences_reset',
    //   data: defaultPreferences
    // });
    
    res.json({
      message: 'Preferences reset to defaults',
      preferences: defaultPreferences
    });
  } catch (error) {
    console.error('Error resetting preferences:', error);
    res.status(500).json({ error: 'Server error resetting preferences' });
  }
});

/**
 * @route   GET /api/preferences/recommendations
 * @desc    Get recommended preference settings based on user's music taste
 * @access  Private
 */
router.get('/recommendations', async (req, res) => {
  try {
    // Get user's music history
    const musicHistory = await MusicHistory.getUserHistory(req.user.id, { limit: 100 });
    
    // If no history, return default recommendations
    if (!musicHistory || musicHistory.length === 0) {
      return res.json({
        recommendations: {
          preferredGender: null, // Keep current preference
          minAge: 18,
          maxAge: 35,
          maxDistance: 50
        },
        message: 'Default recommendations provided. Listen to more music for personalized recommendations.'
      });
    }
    
    // Calculate age range based on music preferences
    // This is a simplified example - in a real app, you might use more sophisticated analysis
    let minAge = 18;
    let maxAge = 100;
    let maxDistance = 50;
    
    // Example logic: analyze genres to determine demographic recommendations
    const genres = musicHistory
      .flatMap(item => item.song?.genre?.split(',') || [])
      .map(g => g.trim().toLowerCase())
      .filter(g => g);
    
    // Count genre occurrences
    const genreCounts = {};
    genres.forEach(genre => {
      genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    });
    
    // Sort genres by frequency
    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(entry => entry[0]);
    
    // Simple recommendation logic based on top genres
    // In a real app, you'd use more sophisticated analysis or ML models
    if (topGenres.some(g => ['pop', 'hip hop', 'rap', 'edm', 'dance'].includes(g))) {
      // Contemporary popular music suggests younger demographic
      minAge = 18;
      maxAge = 35;
    } else if (topGenres.some(g => ['rock', 'alternative', 'indie', 'metal'].includes(g))) {
      // Rock music spans wider age ranges
      minAge = 18;
      maxAge = 45;
    } else if (topGenres.some(g => ['classical', 'jazz', 'blues', 'folk'].includes(g))) {
      // Traditional genres suggest older demographic
      minAge = 25;
      maxAge = 65;
    }
    
    // Return recommendations
    res.json({
      recommendations: {
        preferredGender: null, // Keep current preference
        minAge,
        maxAge,
        maxDistance
      },
      topGenres,
      message: 'Recommendations based on your music taste'
    });
  } catch (error) {
    console.error('Error generating preference recommendations:', error);
    res.status(500).json({ error: 'Server error generating recommendations' });
  }
});

/**
 * @route   GET /api/preferences/compatibility/:userId
 * @desc    Get compatibility score with another user based on preferences
 * @access  Private
 */
router.get('/compatibility/:userId', 
  [

    check('userId', 'Valid user ID is required').isUUID()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const targetUserId = req.params.userId;
      
      // Check if target user exists
      const targetUser = await User.findById(targetUserId);
      if (!targetUser) {
        return res.status(404).json({ error: 'Target user not found' });
      }
      
      // Get both users' preferences
      const myPreferences = await UserPreference.findByUserId(req.user.id);
      const theirPreferences = await UserPreference.findByUserId(targetUserId);
      
      if (!myPreferences || !theirPreferences) {
        return res.status(400).json({ 
          error: 'Preferences not set for one or both users',
          myPreferencesSet: !!myPreferences,
          theirPreferencesSet: !!theirPreferences
        });
      }
      
      // Check if users match each other's gender preferences
      const myGenderMatches = !theirPreferences.preferredGender || 
                              theirPreferences.preferredGender === req.user.gender;
                              
      const theirGenderMatches = !myPreferences.preferredGender || 
                                myPreferences.preferredGender === targetUser.gender;
      
      // Check if users match each other's age preferences
      const myAgeMatches = (
        (!theirPreferences.minAge || req.user.age >= theirPreferences.minAge) &&
        (!theirPreferences.maxAge || req.user.age <= theirPreferences.maxAge)
      );
      
      const theirAgeMatches = (
        (!myPreferences.minAge || targetUser.age >= myPreferences.minAge) &&
        (!myPreferences.maxAge || targetUser.age <= myPreferences.maxAge)
      );
      
      // Calculate compatibility score
      const compatibilityScore = {
        overall: myGenderMatches && theirGenderMatches && myAgeMatches && theirAgeMatches ? 100 : 0,
        details: {
          genderCompatibility: {
            match: myGenderMatches && theirGenderMatches,
            myGenderMatchesTheirPreference: myGenderMatches,
            theirGenderMatchesMyPreference: theirGenderMatches
          },
          ageCompatibility: {
            match: myAgeMatches && theirAgeMatches,
            myAgeMatchesTheirPreference: myAgeMatches,
            theirAgeMatchesMyPreference: theirAgeMatches
          }
        }
      };
      
      res.json({
        compatibility: compatibilityScore,
        myPreferences,
        theirPreferences: {
          preferredGender: theirPreferences.preferredGender,
          minAge: theirPreferences.minAge,
          maxAge: theirPreferences.maxAge,
          // Don't expose other preference details
        }
      });
    } catch (error) {
      console.error('Error calculating compatibility:', error);
      res.status(500).json({ error: 'Server error calculating compatibility' });
    }
  }
);

module.exports = router;