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
        return res.status(401).json({ message: 'Unauthorized' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        logger.warn(`No token provided for user ${userId}`);
        return res.status(401).json({ message: 'No token provided' });
      }

      logger.info(`Retrieving profile for user: ${userId}`);
      const profile = await this.profileService.getProfile(userId, token);
      
      if (!profile) {
        logger.warn(`Profile not found for user ${userId}`);
        return res.status(404).json({ message: 'Profile not found' });
      }

      logger.info(`Successfully retrieved profile for user ${userId}`);
      res.json({ data: profile });
    } catch (error) {
      logger.error(`Error in getProfile controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async getProfileById(req, res) {
    try {
      const userId = req.params.id;
      if (!userId) {
        return res.status(400).json({ message: 'User ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      logger.info(`Retrieving profile by ID: ${userId}`);
      logger.info(`Retrieving token in getProfileById controller: ${token}`);

      const profile = await this.profileService.getProfile(userId, token);
      
      if (!profile) {
        logger.warn(`Profile not found for ID ${userId}`);
        return res.status(404).json({ message: 'Profile not found' });
      }

      res.json({ data: profile });
    } catch (error) {
      logger.error(`Error in getProfileById controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async updateProfile(req, res) {
    try {
      const profileId = req.params.id;
      const profileData = req.body;
      
      if (!profileId) {
        return res.status(400).json({ message: 'Profile ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      // Validate required fields based on update type
      if (profileData.personalInfo) {
        const { name, email } = profileData.personalInfo;
        if (!name || !email) {
          return res.status(400).json({ 
            message: 'Name and email are required in personal info' 
          });
        }
      }

      if (profileData.experience) {
        for (const exp of profileData.experience) {
          if (!exp.title || !exp.company || !exp.startDate) {
            return res.status(400).json({ 
              message: 'Title, company, and start date are required for experience' 
            });
          }
        }
      }

      if (profileData.skills) {
        const skillTypes = ['technical', 'professional', 'soft', 'contactCenter'];
        for (const type of skillTypes) {
          if (profileData.skills[type]) {
            for (const skill of profileData.skills[type]) {
              if (!skill.skill || !skill.level) {
                return res.status(400).json({ 
                  message: `Skill name and level are required for ${type} skills` 
                });
              }
            }
          }
        }
      }

      logger.info(`Updating profile: ${profileId}`);
      const updatedProfile = await this.profileService.updateProfile(profileId, profileData, token);
      
      if (!updatedProfile) {
        logger.warn(`Profile not found for update: ${profileId}`);
        return res.status(404).json({ message: 'Profile not found' });
      }

      res.json({ data: updatedProfile });
    } catch (error) {
      logger.error(`Error in updateProfile controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async getREPSScore(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      logger.info(`Calculating REPS score for user: ${userId}`);
      const score = await this.profileService.calculateREPSScore(userId, token);
      res.json(score);
    } catch (error) {
      logger.error(`Error in getREPSScore controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async getCompletionStatus(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      logger.info(`Getting completion status for user: ${userId}`);
      const status = await this.profileService.getProfileCompletionStatus(userId, token);
      res.json(status);
    } catch (error) {
      logger.error(`Error in getCompletionStatus controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

module.exports = ProfileController; 