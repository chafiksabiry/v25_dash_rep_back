const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Define logger format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}${stack ? '\n' + stack : ''}`;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    // Console output for all levels
    new winston.transports.Console(),
    // File output for info and above
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
    }),
    // Separate file for errors
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error' 
    }),
  ],
});

module.exports = logger; 