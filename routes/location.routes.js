// routes/location.routes.js
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const UserLocation = require('../models/UserLocation');
const auth = require('../middleware/auth.middleware');

/**
 * @route   GET /api/location
 * @desc    Get user's location
 * @access  Private
 */
router.get('/', async (req, res) => {
  try {
    const location = await UserLocation.findByUserId(req.user.id);
    
    if (!location) {
      return res.status(404).json({ message: 'Location not found for this user' });
    }
    
    res.json({ location });
  } catch (error) {
    console.error('Error fetching location:', error);
    res.status(500).json({ error: 'Server error fetching location' });
  }
});

/**
 * @route   POST /api/location
 * @desc    Create or update user location
 * @access  Private
 */
router.post('/', 
  [
    
    check('latitude', 'Latitude is required and must be between -90 and 90')
      .isFloat({ min: -90, max: 90 }),
    check('longitude', 'Longitude is required and must be between -180 and 180')
      .isFloat({ min: -180, max: 180 }),
    check('city', 'City cannot be empty if provided')
      .optional().notEmpty(),
    check('state', 'State cannot be empty if provided')
      .optional().notEmpty(),
    check('country', 'Country cannot be empty if provided')
      .optional().notEmpty()
  ], 
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { latitude, longitude, city, state, country } = req.body;
      
      const location = await UserLocation.updateOrCreate(req.user.id, {
        latitude,
        longitude,
        city,
        state,
        country
      });
      
      res.json({
        message: 'Location updated successfully',
        location
      });
    } catch (error) {
      console.error('Error updating location:', error);
      res.status(500).json({ error: 'Server error updating location' });
    }
  }
);

/**
 * @route   PUT /api/location
 * @desc    Update user location
 * @access  Private
 */
router.put('/',
  [

    check('latitude', 'Latitude must be between -90 and 90')
      .optional().isFloat({ min: -90, max: 90 }),
    check('longitude', 'Longitude must be between -180 and 180')
      .optional().isFloat({ min: -180, max: 180 }),
    check('city', 'City cannot be empty if provided')
      .optional().notEmpty(),
    check('state', 'State cannot be empty if provided')
      .optional().notEmpty(),
    check('country', 'Country cannot be empty if provided')
      .optional().notEmpty()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const locationData = req.body;
      
      // Check if at least one field is provided for update
      if (Object.keys(locationData).length === 0) {
        return res.status(400).json({ error: 'At least one location field must be provided' });
      }
      
      // Update location
      const location = await UserLocation.update(req.user.id, locationData);
      
      res.json({
        message: 'Location updated successfully',
        location
      });
    } catch (error) {
      console.error('Error updating location:', error);
      
      if (error.message === 'User location not found') {
        return res.status(404).json({ error: 'Location not found for this user' });
      }
      
      res.status(500).json({ error: 'Server error updating location' });
    }
  }
);

/**
 * @route   DELETE /api/location
 * @desc    Delete user location
 * @access  Private
 */
router.delete('/', async (req, res) => {
  try {
    const deleted = await UserLocation.delete(req.user.id);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Location not found for this user' });
    }
    
    res.json({ message: 'Location deleted successfully' });
  } catch (error) {
    console.error('Error deleting location:', error);
    res.status(500).json({ error: 'Server error deleting location' });
  }
});

/**
 * @route   GET /api/location/nearby
 * @desc    Get nearby users based on current user's location
 * @access  Private
 */
router.get('/nearby', 
  [
    
    check('radius', 'Radius must be a positive number')
      .optional().isFloat({ min: 0 }),
    check('latitude', 'Latitude is required and must be between -90 and 90')
      .optional().isFloat({ min: -90, max: 90 }),
    check('longitude', 'Longitude is required and must be between -180 and 180')
      .optional().isFloat({ min: -180, max: 180 })
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      let { radius = 50, latitude, longitude } = req.query;
      radius = parseFloat(radius);
      
      // If latitude and longitude are not provided, use user's current location
      if (!latitude || !longitude) {
        const userLocation = await UserLocation.findByUserId(req.user.id);
        
        if (!userLocation) {
          return res.status(400).json({ 
            error: 'User location not found. Please provide latitude and longitude or update your location.' 
          });
        }
        
        latitude = userLocation.latitude;
        longitude = userLocation.longitude;
      } else {
        latitude = parseFloat(latitude);
        longitude = parseFloat(longitude);
      }
      
      const nearbyUsers = await UserLocation.findNearby(
        latitude,
        longitude,
        radius,
        req.user.id // Exclude current user
      );
      
      res.json({
        count: nearbyUsers.length,
        radius,
        users: nearbyUsers
      });
    } catch (error) {
      console.error('Error finding nearby users:', error);
      res.status(500).json({ error: 'Server error finding nearby users' });
    }
  }
);

/**
 * @route   GET /api/location/distance
 * @desc    Calculate distance between two users
 * @access  Private
 */
router.get('/distance/:userId',
  [

    check('userId', 'A valid user ID is required').isUUID()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { userId } = req.params;
      
      // Get current user's location
      const userLocation = await UserLocation.findByUserId(req.user.id);
      if (!userLocation) {
        return res.status(400).json({ error: 'Your location is not available' });
      }
      
      // Get target user's location
      const targetLocation = await UserLocation.findByUserId(userId);
      if (!targetLocation) {
        return res.status(404).json({ error: 'Target user location not found' });
      }
      
      // Calculate distance
      const distance = UserLocation.getDistance(
        userLocation.latitude,
        userLocation.longitude,
        targetLocation.latitude,
        targetLocation.longitude
      );
      
      res.json({
        distance: parseFloat(distance.toFixed(1)), // Round to 1 decimal place
        units: 'kilometers',
        yourLocation: {
          latitude: userLocation.latitude,
          longitude: userLocation.longitude,
          city: userLocation.city,
          state: userLocation.state,
          country: userLocation.country
        },
        theirLocation: {
          latitude: targetLocation.latitude,
          longitude: targetLocation.longitude,
          city: targetLocation.city,
          state: targetLocation.state,
          country: targetLocation.country
        }
      });
    } catch (error) {
      console.error('Error calculating distance:', error);
      res.status(500).json({ error: 'Server error calculating distance' });
    }
  }
);

module.exports = router;