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

  async updateBasicInfo(req, res) {
    try {
      const profileId = req.params.id;
      const basicInfo = req.body;
      
      if (!profileId) {
        return res.status(400).json({ message: 'Profile ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      // Basic validation for personal info
      if (basicInfo.name === '' || basicInfo.email === '') {
        return res.status(400).json({ 
          message: 'Name and email cannot be empty' 
        });
      }

      logger.info(`Updating basic info for profile: ${profileId}`);
      
      // Create a profile data object with just the personal info
      const profileData = { personalInfo: basicInfo };
      
      const updatedProfile = await this.profileService.updateProfile(profileId, profileData, token);
      
      if (!updatedProfile) {
        logger.warn(`Profile not found for basic info update: ${profileId}`);
        return res.status(404).json({ message: 'Profile not found' });
      }

      res.json({ data: updatedProfile });
    } catch (error) {
      logger.error(`Error in updateBasicInfo controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async updateExperience(req, res) {
    try {
      const profileId = req.params.id;
      const { experience } = req.body;
      
      if (!profileId) {
        return res.status(400).json({ message: 'Profile ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      // Validate experience entries
      if (Array.isArray(experience)) {
        for (const exp of experience) {
          if (!exp.title || !exp.company || !exp.startDate) {
            return res.status(400).json({ 
              message: 'Title, company, and start date are required for each experience entry' 
            });
          }
        }
      } else {
        return res.status(400).json({ message: 'Experience must be an array' });
      }

      logger.info(`Updating experience for profile: ${profileId}`);
      
      // Create a profile data object with just the experience field
      const profileData = { experience };
      
      const updatedProfile = await this.profileService.updateProfile(profileId, profileData, token);
      
      if (!updatedProfile) {
        logger.warn(`Profile not found for experience update: ${profileId}`);
        return res.status(404).json({ message: 'Profile not found' });
      }

      res.json({ data: updatedProfile });
    } catch (error) {
      logger.error(`Error in updateExperience controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async updateSkills(req, res) {
    try {
      const profileId = req.params.id;
      const { skills } = req.body;
      
      if (!profileId) {
        return res.status(400).json({ message: 'Profile ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      // Simple validation
      if (!skills || typeof skills !== 'object') {
        return res.status(400).json({ message: 'Skills object is required' });
      }

      logger.info(`Updating skills for profile: ${profileId}`);
      
      // Create a profile data object with just the skills field
      const profileData = { skills };
      
      const updatedProfile = await this.profileService.updateProfile(profileId, profileData, token);
      
      if (!updatedProfile) {
        logger.warn(`Profile not found for skills update: ${profileId}`);
        return res.status(404).json({ message: 'Profile not found' });
      }

      res.json({ data: updatedProfile });
    } catch (error) {
      logger.error(`Error in updateSkills controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async addLanguageAssessment(req, res) {
    try {
      const profileId = req.params.id;
      const assessmentData = req.body;
      
      if (!profileId) {
        return res.status(400).json({ message: 'Profile ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      // Validate assessment data
      if (!assessmentData.language || !assessmentData.results) {
        return res.status(400).json({ 
          message: 'Language and assessment results are required' 
        });
      }

      logger.info(`Adding language assessment for profile: ${profileId}`);
      
      // Update the profile with the language assessment
      const updatedProfile = await this.profileService.addLanguageAssessment(profileId, assessmentData, token);
      
      if (!updatedProfile) {
        logger.warn(`Profile not found for language assessment: ${profileId}`);
        return res.status(404).json({ message: 'Profile not found' });
      }

      res.json({ data: updatedProfile });
    } catch (error) {
      logger.error(`Error in addLanguageAssessment controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async addContactCenterAssessment(req, res) {
    try {
      const profileId = req.params.id;
      const { assessment } = req.body;
      
      if (!profileId) {
        return res.status(400).json({ message: 'Profile ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      // Validate assessment data
      if (!assessment || !assessment.skill || !assessment.results) {
        return res.status(400).json({ 
          message: 'Assessment must include skill and results' 
        });
      }

      logger.info(`Adding contact center assessment for profile: ${profileId}`);
      
      // Update the profile with the contact center assessment
      const updatedProfile = await this.profileService.addContactCenterAssessment(profileId, assessment, token);
      
      if (!updatedProfile) {
        logger.warn(`Profile not found for contact center assessment: ${profileId}`);
        return res.status(404).json({ message: 'Profile not found' });
      }

      res.json({ data: updatedProfile });
    } catch (error) {
      logger.error(`Error in addContactCenterAssessment controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  async checkProfileExists(req, res) {
    try {
      const userId = req.params.id || req.user?.id;
      
      if (!userId) {
        return res.status(400).json({ message: 'User ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      logger.info(`Checking if profile exists for user: ${userId}`);
      const exists = await this.profileService.checkProfileExists(userId, token);
      
      res.json({ exists });
    } catch (error) {
      logger.error(`Error in checkProfileExists controller: ${error.message}`, { error });
      // Return false instead of an error, so frontend can handle gracefully
      res.json({ exists: false });
    }
  }

  async getPlan(req, res) {
    try {
      const profileId = req.params.id;
      if (!profileId) {
        return res.status(400).json({ message: 'Profile ID is required' });
      }

      // Get token from request headers
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      logger.info(`Retrieving subscription plan for profile: ${profileId}`);
      const plan = await this.profileService.getPlan(profileId, token);
      
      if (!plan) {
        logger.warn(`Plan not found for profile ${profileId}`);
        return res.status(404).json({ message: 'Plan not found' });
      }

      res.json(plan);
    } catch (error) {
      logger.error(`Error in getPlan controller: ${error.message}`, { error });
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

module.exports = ProfileController; 