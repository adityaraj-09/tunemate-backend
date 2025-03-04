// config/jwt.js
const jwt = require('jsonwebtoken');
const { asyncRedis } = require('./redis');
const redis = require('./redis');

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
const JWT_REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '30d';

/**
 * Generate access token for a user
 * 
 * @param {Object} user - User object containing fields to include in the token
 * @returns {string} JWT access token
 */
const generateAccessToken = (user) => {
  const payload = {
    userId: user.id || user.userId,
    username: user.username,
    role: user.role || 'user'
  };
  
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
};

/**
 * Generate refresh token for a user
 * 
 * @param {Object} user - User object containing fields to include in the token
 * @returns {string} JWT refresh token
 */
const generateRefreshToken = async (user) => {
  const payload = {
    userId: user.id || user.userId,
    tokenType: 'refresh'
  };
  
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRY });
  
  try {
    // Store refresh token in Redis with user info
    const tokenId = `refresh_token:${token}`;
    
    // Convert JWT_REFRESH_EXPIRY to seconds
    let expirySeconds;
    if (JWT_REFRESH_EXPIRY.endsWith('d')) {
      expirySeconds = parseInt(JWT_REFRESH_EXPIRY) * 24 * 60 * 60;
    } else if (JWT_REFRESH_EXPIRY.endsWith('h')) {
      expirySeconds = parseInt(JWT_REFRESH_EXPIRY) * 60 * 60;
    } else if (JWT_REFRESH_EXPIRY.endsWith('m')) {
      expirySeconds = parseInt(JWT_REFRESH_EXPIRY) * 60;
    } else {
      expirySeconds = parseInt(JWT_REFRESH_EXPIRY) || 2592000; // Default 30 days
    }
    
    await asyncRedis.set(tokenId, JSON.stringify({
      userId: user.id || user.userId
    }), 'EX', expirySeconds);
    
    return token;
  } catch (error) {
    console.error('Error storing refresh token in Redis:', error);
    // Return the token anyway so login still works
    return token;
  }
};

/**
 * Verify a JWT token
 * 
 * @param {string} token - JWT token to verify
 * @returns {Promise<Object>} Decoded token payload
 */
const verifyToken = (token) => {
  return new Promise((resolve, reject) => {
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        return reject(err);
      }
      resolve(decoded);
    });
  });
};

/**
 * Add a token to the blacklist
 * 
 * @param {string} token - JWT token to blacklist
 * @returns {Promise<void>}
 */
const blacklistToken = async (token) => {
  try {
    // Decode token without verification to get expiry
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.exp) {
      throw new Error('Invalid token');
    }
    
    // Calculate remaining time until expiry
    const now = Math.floor(Date.now() / 1000);
    const expiryTime = decoded.exp;
    const remainingTime = expiryTime - now;
    
    if (remainingTime > 0) {
      // Add token to blacklist with expiry
      await asyncRedis.set(`blacklist:${token}`, '1', 'EX', remainingTime);
    }
  } catch (error) {
    console.error('Error blacklisting token:', error);
    throw error;
  }
};

/**
 * Check if a token is blacklisted
 * 
 * @param {string} token - JWT token to check
 * @returns {Promise<boolean>} True if token is blacklisted
 */
const isTokenBlacklisted = async (token) => {
  try {
    const result = await asyncRedis.get(`blacklist:${token}`);
    return result !== null;
  } catch (error) {
    console.error('Error checking blacklisted token:', error);
    return true; // Fail safe: if we can't check, assume it's blacklisted
  }
};

/**
 * Verify a refresh token and return user info
 * 
 * @param {string} token - Refresh token to verify
 * @returns {Promise<Object>} User information from token
 */
const verifyRefreshToken = async (token) => {
  try {
    // First, verify the token is valid
    const decoded = await verifyToken(token);
    
    // Check if it's a refresh token
    if (decoded.tokenType !== 'refresh') {
      throw new Error('Not a refresh token');
    }
    
    // Check if the token is in Redis (has not been revoked)
    const tokenData = await asyncRedis.get(`refresh_token:${token}`);
    if (!tokenData) {
      throw new Error('Refresh token has been revoked');
    }
    
    return JSON.parse(tokenData);
  } catch (error) {
    console.error('Error verifying refresh token:', error);
    throw error;
  }
};

/**
 * Revoke a refresh token
 * 
 * @param {string} token - Refresh token to revoke
 * @returns {Promise<void>}
 */
const revokeRefreshToken = async (token) => {
  try {
    await asyncRedis.del(`refresh_token:${token}`);
  } catch (error) {
    console.error('Error revoking refresh token:', error);
    throw error;
  }
};

module.exports = {
  JWT_SECRET,
  JWT_EXPIRY,
  JWT_REFRESH_EXPIRY,
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  blacklistToken,
  isTokenBlacklisted,
  verifyRefreshToken,
  revokeRefreshToken
};