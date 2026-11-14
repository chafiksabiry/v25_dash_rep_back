const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  // Log only what is needed to diagnose: never headers (Authorization), body, query or params.
  logger.error(`Error processing ${req.method} ${req.baseUrl}${req.path}: ${err.message}`);

  // Send error response
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error',
    // Stack traces only with an explicit debug switch (never inferred from NODE_ENV, which
    // can be unset on a deployed environment).
    ...(process.env.EXPOSE_ERROR_STACK === 'true' && { stack: err.stack })
  });
}

module.exports = errorHandler; 