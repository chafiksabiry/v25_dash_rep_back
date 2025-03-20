const ExternalProfileService = require('./ExternalProfileService');

class ProfileService {
  constructor() {
    this.externalProfileService = new ExternalProfileService();
  }

  /**
   * Get the profile from the external service and transform for dashboard use
   */
  async getProfile(userId, token) {
    try {
      // Get profile from external service
      const externalProfile = await this.externalProfileService.getProfileFromExternalService(userId, token);
      
      // Transform to dashboard format
      return this.externalProfileService.mapExternalProfileToViewFormat(externalProfile);
    } catch (error) {
      console.error('Error getting profile:', error);
      throw error;
    }
  }

  /**
   * Update profile in the external service
   */
  async updateProfile(userId, profileData, token) {
    try {
      // Update in the external service
      const updatedExternalProfile = await this.externalProfileService.updateProfileInExternalService(
        userId, 
        profileData, 
        token
      );
      
      // Transform and return the updated profile
      return this.externalProfileService.mapExternalProfileToViewFormat(updatedExternalProfile);
    } catch (error) {
      console.error('Error updating profile:', error);
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