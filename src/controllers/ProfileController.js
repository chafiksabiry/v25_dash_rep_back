const ProfileService = require('../services/ProfileService');
const logger = require('../utils/logger');

class ProfileController {
  constructor() {
    this.profileService = new ProfileService();
  }

  async getProfile(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        logger.warn('Unauthorized access attempt - missing user ID');
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        logger.warn(`No token provided for user ${userId}`);
        res.status(401).json({ message: 'No token provided' });
        return;
      }

      logger.info(`Retrieving profile for user: ${userId}`);
      const profile = await this.profileService.getProfile(userId, token);
      
      if (!profile) {
        logger.warn(`Profile not found for user ${userId}`);
        res.status(404).json({ message: 'Profile not found' });
        return;
      }

      logger.info(`Successfully retrieved profile for user ${userId}`);
      res.json(profile);
    } catch (error) {
      logger.error(`Error in getProfile controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Special test method to get a specific user's profile by ID
  async getProfileById(req, res) {
    try {
      const userId = req.params.id;
      if (!userId) {
        res.status(400).json({ message: 'User ID is required' });
        return;
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        res.status(401).json({ message: 'No token provided' });
        return;
      }
      logger.info(`token from getProfileById controller: ${token}`);

      const profile = await this.profileService.getProfile(userId, token);
      if (!profile) {
        res.status(404).json({ message: 'Profile not found' });
        return;
      }

      res.json(profile);
    } catch (error) {
      console.error('Error in getProfileById controller:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async updateProfile(req, res) {
    try {
      const profileId = req.params.id;
      const profileData = req.body;
      
      if (!profileId) {
        res.status(400).json({ message: 'Profile ID is required' });
        return;
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        res.status(401).json({ message: 'No token provided' });
        return;
      }

      // Log the update operation
      console.log(`Updating profile with ID: ${profileId}`);
      
      const updatedProfile = await this.profileService.updateProfile(profileId, profileData, token);
      
      if (!updatedProfile) {
        res.status(404).json({ message: 'Profile not found' });
        return;
      }

      res.json(updatedProfile);
    } catch (error) {
      console.error('Error in updateProfile controller:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async getREPSScore(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        res.status(401).json({ message: 'No token provided' });
        return;
      }

      const score = await this.profileService.calculateREPSScore(userId, token);
      res.json(score);
    } catch (error) {
      console.error('Error in getREPSScore controller:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async getCompletionStatus(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        res.status(401).json({ message: 'No token provided' });
        return;
      }

      const status = await this.profileService.getProfileCompletionStatus(userId, token);
      res.json(status);
    } catch (error) {
      console.error('Error in getCompletionStatus controller:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

module.exports = ProfileController; 