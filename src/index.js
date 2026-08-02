const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const mongoose = require('mongoose');
const profileRoutes = require('./routes/profileRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');

// Load environment variables
dotenv.config();

// Connect to MongoDB (shared HARX database) for reading reference collections
// (skills, industries, activities). Non-fatal: the server still starts if the
// connection fails so existing HTTP-based features keep working.
if (process.env.MONGO_URI) {
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => logger.info('Connected to MongoDB'))
    .catch((err) => logger.error(`MongoDB connection failed: ${err.message}`));
} else {
  logger.warn('MONGO_URI not set — reference collections (skills/industries/activities) will be unavailable');
}

const app = express();

// Set up trust proxy for secure handling of headers
app.set('trust proxy', true); 

const allowedOrigins = [
  process.env.FRONT_URL,
  process.env.QIANKUN_MAIN_APP_URL,
  'https://harx.ai',
  'https://v25.harx.ai',
  'https://v25-preprod.harx.ai',
  'https://harxv25dashboardfrontend.netlify.app',
  'https://harxv25comporchestratorfront.netlify.app',
  'https://harxv25dashboardrepfront.netlify.app',
  'http://localhost:5173',
  'http://localhost:5183',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith('.harx.ai') ||
      origin.endsWith('.netlify.app')
    ) {
      return callback(null, true);
    }

    console.log('CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-user-id',
    'x-agent-id',
    'Accept',
    'Origin',
    'X-Requested-With',
  ],
  credentials: true,
  optionsSuccessStatus: 204,
}));

// ✅ Set CORS headers for static file requests too
/* app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// 🔥 Serve static files from dist
app.use(express.static(path.join(__dirname, 'dist'))); */

// Parse incoming JSON
app.use(express.json());

// Add request logging middleware (should be one of the first middlewares)
app.use(requestLogger);

// Routes
app.use('/api/profiles', profileRoutes);
app.use('/api/notifications', notificationRoutes);

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// Add error handling middleware (should be after all routes)
app.use(errorHandler);

// Start server (long timeouts for large uploads; language analysis runs async after 202)
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
server.timeout = 10 * 60 * 1000;
server.keepAliveTimeout = 10 * 60 * 1000 + 5000;
server.headersTimeout = 10 * 60 * 1000 + 10000;

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