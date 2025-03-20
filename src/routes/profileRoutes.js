const express = require('express');
const ProfileController = require('../controllers/ProfileController');
const { authenticateToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

const router = express.Router();
const profileController = new ProfileController();

// Test route to generate a JWT token (only for development)
router.get('/generate-test-token/:userId', (req, res) => {
  const userId = req.params.userId;
  const token = jwt.sign(
    { id: userId, email: `${userId}@example.com` }, 
    process.env.JWT_SECRET || 'your-secret-key', 
    { expiresIn: '1h' }
  );
  res.json({ token });
});

// All other routes require authentication
router.use(authenticateToken);

// Get profile
router.get('/', profileController.getProfile.bind(profileController));

// Get specific user's profile by ID (for testing)
router.get('/user/:id', profileController.getProfileById.bind(profileController));

// Update profile
router.put('/', profileController.updateProfile.bind(profileController));

// Get REPS score
router.get('/reps-score', profileController.getREPSScore.bind(profileController));

// Get profile completion status
router.get('/completion-status', profileController.getCompletionStatus.bind(profileController));

module.exports = router; 