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
    { userId: userId }, 
    process.env.JWT_SECRET || 'my_super_secret_key_12345'
   /*  { expiresIn: '1h' } */
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

// Update profile by ID
router.put('/:id', profileController.updateProfile.bind(profileController));

// Update basic info
router.put('/:id/basic-info', profileController.updateBasicInfo.bind(profileController));

// Update experience
router.put('/:id/experience', profileController.updateExperience.bind(profileController));

// Update skills
router.put('/:id/skills', profileController.updateSkills.bind(profileController));

// Add language assessment
router.post('/:id/language-assessment', profileController.addLanguageAssessment.bind(profileController));

// Add contact center assessment
router.post('/:id/contact-center-assessment', profileController.addContactCenterAssessment.bind(profileController));

// Check if profile exists
router.get('/:id/exists', profileController.checkProfileExists.bind(profileController));

// Get REPS score
router.get('/reps-score', profileController.getREPSScore.bind(profileController));

// Get profile completion status
router.get('/completion-status', profileController.getCompletionStatus.bind(profileController));

// Get user's subscription plan
router.get('/:id/plan', profileController.getPlan.bind(profileController));

module.exports = router; 