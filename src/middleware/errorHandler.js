const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  // Log only what is needed to diagnose: never headers (Authorization), body, query or params.
  logger.error(`Error processing ${req.method} ${req.baseUrl}${req.path}: ${err.message}`);

  // Send error response
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
    // Only include stack trace in development
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

module.exports = errorHandler; 