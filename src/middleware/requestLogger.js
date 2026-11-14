const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const startTime = new Date();
  // Path only: the query string may carry credentials and is never logged.
  const safePath = String(req.originalUrl || '').split('?')[0];
  
  // Log incoming request
  logger.info(`Incoming request: ${req.method} ${safePath} from ${req.ip}`);
  
  // Add response logging after completing request
  const originalSend = res.send;
  res.send = function(body) {
    const duration = new Date() - startTime;
    const size = body ? body.length : 0;
    
    logger.info(`Response: ${req.method} ${safePath} - Status: ${res.statusCode} - Duration: ${duration}ms - Size: ${size} bytes`);
    
    return originalSend.call(this, body);
  };
  
  next();
}

module.exports = requestLogger; 