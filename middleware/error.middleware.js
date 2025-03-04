// middleware/error.middleware.js

/**
 * Global error handling middleware
 * Catches all uncaught errors in the request processing pipeline
 * 
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const errorMiddleware = (err, req, res, next) => {
    // Log the error
    console.error('Uncaught Error:', err);
    
    // Set status code
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    
    // Prepare error response
    const errorResponse = {
      error: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message || 'Unknown error',
      status: statusCode
    };
    
    // Include stack trace in development
    if (process.env.NODE_ENV !== 'production') {
      errorResponse.stack = err.stack;
    }
    
    // Send error response
    res.status(statusCode).json(errorResponse);
  };
  
  module.exports = errorMiddleware;