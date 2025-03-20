const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const startTime = new Date();
  
  // Log incoming request
  logger.info(`Incoming request: ${req.method} ${req.originalUrl} from ${req.ip}`);
  
  // Add response logging after completing request
  const originalSend = res.send;
  res.send = function(body) {
    const duration = new Date() - startTime;
    const size = body ? body.length : 0;
    
    logger.info(`Response: ${req.method} ${req.originalUrl} - Status: ${res.statusCode} - Duration: ${duration}ms - Size: ${size} bytes`);
    
    return originalSend.call(this, body);
  };
  
  next();
}

module.exports = requestLogger; 