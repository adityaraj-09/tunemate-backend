// middleware/auth.middleware.js
const { verifyToken, isTokenBlacklisted } = require('../config/jwt');

/**
 * Authentication middleware
 * Verifies JWT token in the request header and attaches user to request object
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const authenticateToken = async (req, res, next) => {
  try {
    // Get authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
      return res.status(401).json({ 
        error: 'Access denied. Authentication token is required.'
      });
    }
    
    // Check if token is blacklisted
    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      return res.status(401).json({ 
        error: 'Access denied. Token has been revoked.'
      });
    }
    
    // Verify token
    const decoded = await verifyToken(token);
    
    // Attach user to request
    req.user = {
      id: decoded.userId,
      username: decoded.username,
      role: decoded.role || 'user'
    };
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Access denied. Token has expired.'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Access denied. Invalid token.'
      });
    }
    
    console.error('Authentication error:', error);
    return res.status(500).json({ 
      error: 'Internal server error during authentication.'
    });
  }
};

/**
 * Optional authentication middleware
 * Tries to verify JWT token but doesn't require it
 * Useful for routes that work for both authenticated and anonymous users
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const optionalAuth = async (req, res, next) => {
  try {
    // Get authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
      // No token provided, continue as anonymous
      req.user = null;
      return next();
    }
    
    // Check if token is blacklisted
    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      // Blacklisted token, continue as anonymous
      req.user = null;
      return next();
    }
    
    // Verify token
    const decoded = await verifyToken(token);
    
    // Attach user to request
    req.user = {
      id: decoded.userId,
      username: decoded.username,
      role: decoded.role || 'user'
    };
    
    next();
  } catch (error) {
    // Any error in token verification, continue as anonymous
    req.user = null;
    next();
  }
};

/**
 * Role-based authentication middleware
 * Checks if authenticated user has the required role
 * 
 * @param {string|Array<string>} roles - Required role(s)
 * @returns {Function} Middleware function
 */
const requireRole = (roles) => {
  return (req, res, next) => {
    // Must be used after authenticateToken middleware
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Access denied. Authentication required.' 
      });
    }
    
    // Convert single role to array
    const allowedRoles = Array.isArray(roles) ? roles : [roles];
    
    if (allowedRoles.includes(req.user.role)) {
      return next();
    }
    
    return res.status(403).json({ 
      error: 'Access denied. Insufficient permissions.' 
    });
  };
};

module.exports = {
  authenticateToken,
  optionalAuth,
  requireRole
};