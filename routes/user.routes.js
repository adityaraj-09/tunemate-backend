// routes/user.routes.js
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const User = require('../models/User');
const UserPreference = require('../models/UserPreference');
const UserLocation = require('../models/UserLocation');
const MusicHistory = require('../models/MusicHistory');
const MusicPreference = require('../models/MusicPreference');

// Set up multer for profile picture uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/profiles';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `profile-${req.user.id}-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    
    cb(new Error('Only image files are allowed'));
  }
});

/**
 * @route   GET /api/users/profile
 * @desc    Get user's profile
 * @access  Private
 */
router.get('/profile', async (req, res) => {
  try {
    // Get user from database
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user preferences
    const preferences = await UserPreference.findByUserId(req.user.id);
    
    // Get user location
    const location = await UserLocation.findByUserId(req.user.id);
    
    res.json({
      profile: {
        ...user,
        preferences: preferences || null,
        location: location || null
      }
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

/**
 * @route   PUT /api/users/profile
 * @desc    Update user profile
 * @access  Private
 */
router.put(
  '/profile',
  [
    check('firstName', 'First name cannot be empty if provided').optional().notEmpty(),
    check('lastName', 'Last name cannot be empty if provided').optional().notEmpty(),
    check('bio', 'Bio cannot exceed 500 characters').optional().isLength({ max: 500 })
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { firstName, lastName, bio } = req.body;
      
      // Update user in database
      const updatedUser = await User.update(req.user.id, {
        firstName,
        lastName,
        bio
      });
      
      res.json({
        message: 'Profile updated successfully',
        profile: updatedUser
      });
    } catch (error) {
      console.error('Error updating profile:', error);
      res.status(500).json({ error: 'Server error updating profile' });
    }
  }
);

/**
 * @route   POST /api/users/profile/picture
 * @desc    Upload profile picture
 * @access  Private
 */
router.post('/profile/picture', upload.single('profilePicture'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // File was uploaded successfully, update user's profile
    const profilePicturePath = `/uploads/profiles/${req.file.filename}`;
    
    // Update user in database
    const updatedUser = await User.update(req.user.id, {
      profilePicture: profilePicturePath
    });
    
    res.json({
      message: 'Profile picture uploaded successfully',
      profilePicture: profilePicturePath
    });
  } catch (error) {
    console.error('Error uploading profile picture:', error);
    res.status(500).json({ error: 'Server error uploading profile picture' });
  }
});

/**
 * @route   PUT /api/users/preferences
 * @desc    Update user preferences
 * @access  Private
 */
router.put(
  '/preferences',
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
      
      // Update preferences in database
      const updatedPreferences = await UserPreference.updateOrCreate(req.user.id, {
        preferredGender,
        minAge,
        maxAge,
        maxDistance,
        isVisible
      });
      
      res.json({
        message: 'Preferences updated successfully',
        preferences: updatedPreferences
      });
    } catch (error) {
      console.error('Error updating preferences:', error);
      res.status(500).json({ error: 'Server error updating preferences' });
    }
  }
);

/**
 * @route   PUT /api/users/location
 * @desc    Update user location
 * @access  Private
 */
router.put(
  '/location',
  [
    check('latitude', 'Latitude is required').isFloat({ min: -90, max: 90 }),
    check('longitude', 'Longitude is required').isFloat({ min: -180, max: 180 }),
    check('city', 'City cannot be empty if provided').optional().notEmpty(),
    check('state', 'State cannot be empty if provided').optional().notEmpty(),
    check('country', 'Country cannot be empty if provided').optional().notEmpty()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { latitude, longitude, city, state, country } = req.body;
      
      // Update location in database
      const updatedLocation = await UserLocation.updateOrCreate(req.user.id, {
        latitude,
        longitude,
        city,
        state,
        country
      });
      
      res.json({
        message: 'Location updated successfully',
        location: updatedLocation
      });
    } catch (error) {
      console.error('Error updating location:', error);
      res.status(500).json({ error: 'Server error updating location' });
    }
  }
);

/**
 * @route   GET /api/users/music/history
 * @desc    Get user's music listening history
 * @access  Private
 */
router.get('/music/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    // Get user's history from database
    const history = await MusicHistory.getUserHistory(req.user.id, { limit, offset });
    
    // Get total count for pagination
    const total = await MusicHistory.getTotalCount(req.user.id);
    
    res.json({
      history,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total
      }
    });
  } catch (error) {
    console.error('Error fetching music history:', error);
    res.status(500).json({ error: 'Server error fetching music history' });
  }
});

/**
 * @route   GET /api/users/music/favorites
 * @desc    Get user's favorite songs
 * @access  Private
 */
router.get('/music/favorites', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    // Get user's favorites from database
    const favorites = await MusicHistory.getFavorites(req.user.id, { limit, offset });
    
    res.json({ favorites });
  } catch (error) {
    console.error('Error fetching favorites:', error);
    res.status(500).json({ error: 'Server error fetching favorites' });
  }
});

/**
 * @route   POST /api/users/music/favorite
 * @desc    Toggle favorite status for a song
 * @access  Private
 */
router.post(
  '/music/favorite',
  [
    check('songId', 'Song ID is required').not().isEmpty(),
    check('isFavorite', 'Favorite status must be a boolean').isBoolean()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { songId, isFavorite } = req.body;
      
      // Toggle favorite status
      const result = await MusicHistory.toggleFavorite(req.user.id, songId, isFavorite);
      
      res.json({
        message: isFavorite ? 'Song added to favorites' : 'Song removed from favorites',
        songId,
        isFavorite
      });
    } catch (error) {
      console.error('Error toggling favorite:', error);
      res.status(500).json({ error: 'Server error toggling favorite' });
    }
  }
);

/**
 * @route   POST /api/users/music/preferences
 * @desc    Update music preferences
 * @access  Private
 */
router.post(
  '/music/preferences',
  [
    check('genres', 'Genres must be an array').optional().isArray(),
    check('artists', 'Artists must be an array').optional().isArray()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { genres = [], artists = [] } = req.body;
      
      if (genres.length === 0 && artists.length === 0) {
        return res.status(400).json({ error: 'At least one genre or artist is required' });
      }
      
      // Update preferences
      await MusicPreference.updatePreferences(req.user.id, { genres, artists });
      
      res.json({
        message: 'Music preferences updated successfully',
        preferences: {
          genres,
          artists
        }
      });
    } catch (error) {
      console.error('Error updating music preferences:', error);
      res.status(500).json({ error: 'Server error updating music preferences' });
    }
  }
);

/**
 * @route   GET /api/users/music/preferences
 * @desc    Get user's music preferences
 * @access  Private
 */
router.get('/music/preferences', async (req, res) => {
  try {
    // Get user's music preferences
    const preferences = await MusicPreference.getPreferences(req.user.id);
    
    res.json({ preferences });
  } catch (error) {
    console.error('Error fetching music preferences:', error);
    res.status(500).json({ error: 'Server error fetching music preferences' });
  }
});

/**
 * @route   PUT /api/users/password
 * @desc    Update user password
 * @access  Private
 */
router.put(
  '/password',
  [
    check('currentPassword', 'Current password is required').not().isEmpty(),
    check('newPassword', 'New password must be at least 6 characters').isLength({ min: 6 })
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { currentPassword, newPassword } = req.body;
      
      // Verify current password
      const user = await User.findByUsername(req.user.username);
      const isValidPassword = await User.authenticate(req.user.username, currentPassword);
      
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      
      // Update password
      await User.updatePassword(req.user.id, newPassword);
      
      res.json({ message: 'Password updated successfully' });
    } catch (error) {
      console.error('Error updating password:', error);
      res.status(500).json({ error: 'Server error updating password' });
    }
  }
);

module.exports = router;