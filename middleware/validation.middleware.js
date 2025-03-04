// middleware/validation.middleware.js
const { validationResult } = require('express-validator');

/**
 * Validates request using express-validator
 * Returns 400 Bad Request with validation errors if validation fails
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      status: 'error',
      errors: errors.array()
    });
  }
  
  next();
};

module.exports = validateRequest;