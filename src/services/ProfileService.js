const ExternalProfileService = require('./ExternalProfileService');
const logger = require('../utils/logger');
const axios = require('axios');

class ProfileService {
  constructor() {
    this.externalProfileService = new ExternalProfileService();
  }

  /**
   * Get the profile from the external service and transform for dashboard use
   */
  async getProfile(userId, token) {
    try {
      logger.info(`Getting token for user: ${userId}`);
      
      // Get profile from external service and return raw data
      return await this.externalProfileService.getProfileFromExternalService(userId, token);
    } catch (error) {
      logger.error(`Error getting profile for user ${userId}: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * Update profile in the external service
   */
  async updateProfile(profileId, profileData, token) {
    try {
      // Create a new object to hold all the flattened fields
      const flattenedData = {};
      
      // Recursively flatten nested fields using dot notation
      const flattenObject = (obj, prefix = '') => {
        for (const key in obj) {
          if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
            // Recursively flatten nested objects
            flattenObject(obj[key], `${prefix}${key}.`);
          } else {
            // Add the field with its path
            flattenedData[`${prefix}${key}`] = obj[key];
          }
        }
      };
      
      // Apply the flattening
      flattenObject(profileData);
      
      // Debug the flattened data structure
      logger.debug('Flattened profile data:', flattenedData);
      
      // Call the external API with the profile ID and flattened data
      const response = await axios.put(
        `${process.env.REP_PROFILE_API}/profiles/${profileId}`,
        flattenedData,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        }
      );
      
      return response.data;
    } catch (error) {
      logger.error('Error updating profile in external service:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Calculate REPS score based on contact center skills and assessments
   */
  async calculateREPSScore(userId, token) {
    try {
      // Get the full profile
      const profile = await this.getProfile(userId, token);
      
      if (!profile) {
        throw new Error('Profile not found');
      }

      // Initialize scores
      let reliabilityScore = 0;
      let efficiencyScore = 0;
      let professionalismScore = 0;
      let serviceScore = 0;
      let totalMetrics = 0;

      // Calculate scores from contact center skills
      if (profile.skills?.contactCenter?.length > 0) {
        profile.skills.contactCenter.forEach(skill => {
          if (skill.assessmentResults?.keyMetrics) {
            const metrics = skill.assessmentResults.keyMetrics;
            reliabilityScore += metrics.effectiveness || 0;
            efficiencyScore += metrics.effectiveness || 0;
            professionalismScore += metrics.professionalism || 0;
            serviceScore += metrics.customerFocus || 0;
            totalMetrics++;
          }
        });
      }

      // If no metrics found, return default scores
      if (totalMetrics === 0) {
        return {
          reliability: 0,
          efficiency: 0,
          professionalism: 0,
          service: 0
        };
      }

      // Calculate average scores
      return {
        reliability: Math.round(reliabilityScore / totalMetrics),
        efficiency: Math.round(efficiencyScore / totalMetrics),
        professionalism: Math.round(professionalismScore / totalMetrics),
        service: Math.round(serviceScore / totalMetrics)
      };
    } catch (error) {
      logger.error('Error calculating REPS score:', error);
      throw error;
    }
  }

  /**
   * Get profile completion status
   */
  async getProfileCompletionStatus(userId, token) {
    try {
      const profile = await this.getProfile(userId, token);
      
      if (!profile) {
        throw new Error('Profile not found');
      }

      // Get completion steps directly from profile
      const { completionSteps, status } = profile;

      // Calculate completion percentage
      const totalSteps = Object.keys(completionSteps).length;
      const completedSteps = Object.values(completionSteps).filter(Boolean).length;
      const completionPercentage = Math.round((completedSteps / totalSteps) * 100);

      return {
        status,
        completionSteps,
        completionPercentage,
        isComplete: status === 'completed'
      };
    } catch (error) {
      logger.error('Error getting profile completion status:', error);
      throw error;
    }
  }

  /**
   * Add or update language assessment
   */
  async addLanguageAssessment(profileId, assessmentData, token) {
    try {
      // Get the current profile
      const profile = await this.getProfile(profileId, token);
      
      if (!profile) {
        throw new Error('Profile not found');
      }

      // Check if the profile has languages
      if (!profile.personalInfo || !profile.personalInfo.languages) {
        throw new Error('Profile does not have languages defined');
      }

      // Find the language to update
      const languageName = assessmentData.language;
      const languages = profile.personalInfo.languages;
      const languageIndex = languages.findIndex(l => l.language.toLowerCase() === languageName.toLowerCase());

      if (languageIndex === -1) {
        throw new Error(`Language ${languageName} not found in profile`);
      }

      // Create updated language with assessment results
      const updatedLanguage = {
        ...languages[languageIndex],
        assessmentResults: assessmentData.results,
      };

      // Update the languages array
      const updatedLanguages = [...languages];
      updatedLanguages[languageIndex] = updatedLanguage;

      // Create profile data with just the languages field
      const profileData = {
        personalInfo: {
          languages: updatedLanguages
        }
      };

      // Update the profile
      return await this.updateProfile(profileId, profileData, token);
    } catch (error) {
      logger.error('Error adding language assessment:', error);
      throw error;
    }
  }

  /**
   * Add or update contact center assessment
   */
  async addContactCenterAssessment(profileId, assessment, token) {
    try {
      // Get the current profile
      const profile = await this.getProfile(profileId, token);
      
      if (!profile) {
        throw new Error('Profile not found');
      }

      // Initialize contact center skills if not present
      if (!profile.skills) {
        profile.skills = {};
      }
      
      if (!profile.skills.contactCenter) {
        profile.skills.contactCenter = [];
      }

      // Find the skill to update
      const skillName = assessment.skill;
      const contactCenterSkills = profile.skills.contactCenter;
      const skillIndex = contactCenterSkills.findIndex(s => s.skill.toLowerCase() === skillName.toLowerCase());

      // Create updated skill data
      const skillData = {
        skill: skillName,
        category: assessment.category || 'General',
        proficiency: assessment.proficiency || 'Intermediate',
        assessmentResults: assessment.results
      };

      let updatedSkills;
      if (skillIndex === -1) {
        // Add new skill
        updatedSkills = [...contactCenterSkills, skillData];
      } else {
        // Update existing skill
        updatedSkills = [...contactCenterSkills];
        updatedSkills[skillIndex] = skillData;
      }

      // Create profile data with just the updated contact center skills
      const profileData = {
        skills: {
          contactCenter: updatedSkills
        }
      };

      // Update the profile
      return await this.updateProfile(profileId, profileData, token);
    } catch (error) {
      logger.error('Error adding contact center assessment:', error);
      throw error;
    }
  }

  /**
   * Check if a profile exists for a user
   */
  async checkProfileExists(userId, token) {
    try {
      logger.info(`Checking if profile exists for user: ${userId}`);
      
      try {
        // Try to get the profile
        const profile = await this.getProfile(userId, token);
        // If profile is returned, it exists
        return !!profile;
      } catch (error) {
        // If error code is 404, profile doesn't exist
        if (error.response && error.response.status === 404) {
          return false;
        }
        // For other errors, re-throw
        throw error;
      }
    } catch (error) {
      logger.error(`Error checking if profile exists for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Get subscription plan for a profile
   */
  async getPlan(profileId, token) {
    try {
      logger.info(`Getting subscription plan for profile: ${profileId}`);
      
      const response = await axios.get(
        `${process.env.REP_PROFILE_API}/profiles/${profileId}/plan`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (!response.data) {
        logger.warn(`No plan found for profile ${profileId}`);
        return null;
      }

      return response.data;
    } catch (error) {
      logger.error(`Error getting plan for profile ${profileId}: ${error.message}`, { error });
      throw error;
    }
  }
}

module.exports = ProfileService; 