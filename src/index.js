const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const profileRoutes = require('./routes/profileRoutes');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

// Load environment variables
dotenv.config();

const app = express();

// Set up trust proxy for secure handling of headers
app.set('trust proxy', true); 

const corsOptions = {
  origin: [
    'https://v25-prod.harx.ai'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'], 
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// ✅ Set CORS headers for static file requests too
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://v25-prod.harx.ai');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// 🔥 Serve static files from dist
app.use(express.static(path.join(__dirname, 'dist')));

// Parse incoming JSON
app.use(express.json());

// Add request logging middleware (should be one of the first middlewares)
app.use(requestLogger);

// Routes
app.use('/api/profiles', profileRoutes);

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// Add error handling middleware (should be after all routes)
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Give logger time to write before exiting
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
}); 