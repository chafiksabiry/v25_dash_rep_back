const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  // Log error details
  logger.error(`Error processing ${req.method} ${req.originalUrl}: ${err.message}`, {
    error: err,
    request: {
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
      params: req.params,
      query: req.query,
      body: req.body
    }
  });

  // Send error response
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
    // Only include stack trace in development
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

module.exports = errorHandler; 