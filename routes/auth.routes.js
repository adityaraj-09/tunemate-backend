// routes/auth.routes.js
const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const User = require('../models/User');
const { 
  generateAccessToken, 
  generateRefreshToken, 
  verifyRefreshToken,
  revokeRefreshToken,
  blacklistToken
} = require('../config/jwt');
const { authenticateToken } = require('../middleware/auth.middleware');

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user
 * @access  Public
 */
router.post(
  '/register',
  [
    check('username', 'Username is required').not().isEmpty(),
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Password must be at least 6 characters').isLength({ min: 6 })
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      // Create user
      const user = await User.create(req.body);

      // Generate tokens
      const accessToken = generateAccessToken(user);
      const refreshToken = await generateRefreshToken(user);

      res.status(201).json({
        message: 'User registered successfully',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName
        },
        accessToken,
        refreshToken
      });
    } catch (error) {
      console.error('Registration error:', error);
      
      if (error.message.includes('exists')) {
        return res.status(409).json({ error: error.message });
      }
      
      res.status(500).json({ error: 'Server error during registration' });
    }
  }
);

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user & get tokens
 * @access  Public
 */
router.post(
  '/login',
  [

    check('identifier', 'Username or email is required').not().isEmpty(),
    check('password', 'Password is required').exists()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { identifier, password } = req.body;

    try {
      // Authenticate user
      const user = await User.authenticateWithIdentifier(identifier, password);
      
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Generate tokens
      const accessToken = generateAccessToken(user);
      const refreshToken =await generateRefreshToken(user);

      res.json({
        message: 'Login successful',
        user,
        accessToken,
        refreshToken
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Server error during login' });
    }
  }
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
router.post(
  '/refresh',
  [
    check('refreshToken', 'Refresh token is required').not().isEmpty()
  ],
  async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { refreshToken } = req.body;

    try {
      // Verify refresh token
      const userData = await verifyRefreshToken(refreshToken);
      
      // Get user from database
      const user = await User.findById(userData.userId);
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Generate new access token
      const accessToken = generateAccessToken(user);

      res.json({
        accessToken
      });
    } catch (error) {
      console.error('Token refresh error:', error);
      
      if (error.message.includes('token')) {
        return res.status(401).json({ error: error.message });
      }
      
      res.status(500).json({ error: 'Server error during token refresh' });
    }
  }

);


/**
 * @route   POST /api/auth/logout
 * @desc    Logout user (blacklist token)
 * @access  Private
 */
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // Get token from header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    // Blacklist current access token
    await blacklistToken(token);
    
    // Revoke refresh token if provided
    const { refreshToken } = req.body;
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Server error during logout' });
  }
});

/**
 * @route   GET /api/auth/me
 * @desc    Get current user's data
 * @access  Private
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // Get user from database (to get the most up-to-date info)
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Server error fetching user data' });
  }
});



module.exports = router;