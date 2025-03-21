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
      logger.info(`Getting profile for user: ${userId}`);
      
      // Get profile from external service
      const externalProfile = await this.externalProfileService.getProfileFromExternalService(userId, token);
      
      // Transform to dashboard format
      return this.externalProfileService.mapExternalProfileToViewFormat(externalProfile);
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
      // Call the external API with the profile ID
      const response = await axios.put(
        `${process.env.REP_PROFILE_API}/profiles/${profileId}`,
        profileData,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        }
      );
      
      return response.data;
    } catch (error) {
      console.error('Error updating profile in external service:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get REPS score for dashboard
   */
  async calculateREPSScore(userId, token) {
    try {
      // Get the full profile
      const profile = await this.getProfile(userId, token);
      
      if (!profile) {
        throw new Error('Profile not found');
      }

      // Get the REPS scores
      const { performance } = profile;
      
      return {
        reliability: Math.round(performance.onTimeDelivery),
        efficiency: Math.round(performance.taskCompletionRate),
        professionalism: Math.round((performance.customerSatisfaction + performance.taskCompletionRate) / 2),
        service: Math.round(performance.customerSatisfaction)
      };
    } catch (error) {
      console.error('Error calculating REPS score:', error);
      throw error;
    }
  }

  /**
   * Get profile completion status from external service
   */
  async getProfileCompletionStatus(userId, token) {
    try {
      const profile = await this.getProfile(userId, token);
      
      if (!profile) {
        throw new Error('Profile not found');
      }

      return {
        status: profile.completionStatus,
        steps: profile.completionSteps
      };
    } catch (error) {
      console.error('Error getting profile completion status:', error);
      throw error;
    }
  }
}

module.exports = ProfileService; 