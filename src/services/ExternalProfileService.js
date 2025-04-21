const axios = require('axios');
require('dotenv').config();
const logger = require('../utils/logger');

const repProfileApiBaseUrl = process.env.REP_PROFILE_API || 'https://api-repcreationwizard.harx.ai/api';

// Create an axios instance for the external API
const externalApiClient = axios.create({
  baseURL: repProfileApiBaseUrl,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add request interceptor to add JWT token
externalApiClient.interceptors.request.use(
  (config) => {
    // For service-to-service communication, we might use a service API key
    // or forward the user's JWT token
    if (config.headers && config.data && config.data.token) {
      config.headers.Authorization = `Bearer ${config.data.token}`;
      // Remove token from the payload
      delete config.data.token;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

class ExternalProfileService {
  /**
   * Get profile data from the external profile creation service
   */
  async getProfileFromExternalService(userId, token) {
    try {
      logger.info(`Fetching profile from external service for user: ${userId}`);
      
      // Use the correct endpoint: /api/profiles/:id
      const response = await externalApiClient.get(`/profiles/${userId}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      logger.debug(`External API response received for user ${userId}`);
      return response.data;
    } catch (error) {
      logger.error(`Error fetching profile from external service for user ${userId}: ${error.message}`, { error });
      throw new Error('Failed to fetch profile from external service');
    }
  }

  /**
   * Update profile in the external service
   */
  async updateProfileInExternalService(userId, profileData, token) {
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
      console.log('Flattened profile data for external service:', flattenedData);
      
      // Use the correct endpoint: /api/profiles/:id with flattened data
      const response = await externalApiClient.put(`/profiles/${userId}`, flattenedData, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      return response.data;
    } catch (error) {
      console.error('Error updating profile in external service:', error);
      throw new Error('Failed to update profile in external service');
    }
  }

  /**
   * Map the external profile data to a format suitable for the dashboard
   * The dashboard needs a simplified version of the profile
   */
  mapExternalProfileToViewFormat(externalProfile) {
    // Handle possible null/undefined values
    if (!externalProfile) {
      return null;
    }

    const personalInfo = externalProfile.personalInfo || {};
    const professionalSummary = externalProfile.professionalSummary || {};
    const skills = externalProfile.skills || { technical: [], professional: [], soft: [] };
    const assessments = externalProfile.assessments || { contactCenter: [] };
    
    // Extract languages with their proficiency levels
    const languages = personalInfo.languages?.map(lang => ({
      language: lang.language,
      proficiency: lang.proficiency,
      assessmentScore: lang.assessmentResults?.overall?.score || 0
    })) || [];

    // Flatten skills into a single array for easier display
    const allSkills = [
      ...skills.technical.map(s => ({ name: s.skill, level: s.level, type: 'technical' })),
      ...skills.professional.map(s => ({ name: s.skill, level: s.level, type: 'professional' })),
      ...skills.soft.map(s => ({ name: s.skill, level: s.level, type: 'soft' }))
    ];

    // Group assessments by category
    const assessmentsByCategory = {};
    if (assessments.contactCenter && assessments.contactCenter.length > 0) {
      assessments.contactCenter.forEach(assessment => {
        if (!assessmentsByCategory[assessment.category]) {
          assessmentsByCategory[assessment.category] = [];
        }
        assessmentsByCategory[assessment.category].push(assessment);
      });
    }

    // Calculate average score for each category
    const categoryKPIs = {};
    const skillKPIs = {};

    Object.keys(assessmentsByCategory).forEach(category => {
      const categoryAssessments = assessmentsByCategory[category];
      const totalScore = categoryAssessments.reduce((sum, assessment) => sum + assessment.score, 0);
      categoryKPIs[category] = totalScore / categoryAssessments.length;
      
      // Store complete skill assessment data under each category
      skillKPIs[category] = categoryAssessments.map(assessment => ({
        category: assessment.category,
        skill: assessment.skill,
        score: assessment.score,
        keyMetrics: assessment.keyMetrics || {},
        strengths: assessment.strengths || [],
        improvements: assessment.improvements || [],
        feedback: assessment.feedback || '',
        tips: assessment.tips || [],
        completedAt: assessment.completedAt,
        _id: assessment._id
      }));
    });

    return {
      // Keep the document ID
      _id: externalProfile._id,
      
      // Basic profile information
      userId: externalProfile.userId,
      name: personalInfo.name || '',
/*       firstName: personalInfo.name?.split(' ')[0] || '',
      lastName: personalInfo.name?.split(' ').slice(1).join(' ') || '', */
      email: personalInfo.email || '',
      phone: personalInfo.phone || '',
      location: personalInfo.location || '',
      role: professionalSummary.currentRole || 'HARX Representative',
      experience: parseInt(professionalSummary.yearsOfExperience) || 0,
      
      // Professional summary details
      industries: professionalSummary.industries || [],
      keyExpertise: professionalSummary.keyExpertise || [],
      notableCompanies: professionalSummary.notableCompanies || [],
      
      // Keep full experience data
      experienceDetails: externalProfile.experience || [],
      
      // Skills data
      skills: allSkills.map(s => s.name),
      languages,
      
      // Assessment data
      assessmentKPIs: {
        categoryScores: categoryKPIs,  // Overall category scores
        skillAssessments: skillKPIs    // Complete skill assessment data by category
      },
      
      // Status information
      completionStatus: externalProfile.status,
      completionSteps: externalProfile.completionSteps,
      lastUpdated: externalProfile.lastUpdated
    };
  }

  /**
   * Calculate REPS scores based on assessment data
   */
  calculateREPSScores(contactCenterAssessments) {
    // Default scores if no assessments
    if (!contactCenterAssessments || contactCenterAssessments.length === 0) {
      return {
        reliability: 85,
        efficiency: 80,
        professionalism: 90,
        service: 85
      };
    }

    // Extract metrics from assessments
    let professionalism = 0;
    let effectiveness = 0;
    let customerFocus = 0;
    let count = 0;

    // Aggregate assessment metrics
    contactCenterAssessments.forEach(assessment => {
      if (assessment.keyMetrics) {
        professionalism += assessment.keyMetrics.professionalism || 0;
        effectiveness += assessment.keyMetrics.effectiveness || 0;
        customerFocus += assessment.keyMetrics.customerFocus || 0;
        count++;
      }
    });

    // Calculate averages and convert to 0-100 scale
    if (count > 0) {
      professionalism = (professionalism / count) * 10;
      effectiveness = (effectiveness / count) * 10;
      customerFocus = (customerFocus / count) * 10;
    }

    // Map to REPS categories
    return {
      reliability: Math.round(professionalism * 0.7 + effectiveness * 0.3),
      efficiency: Math.round(effectiveness * 0.8 + customerFocus * 0.2),
      professionalism: Math.round(professionalism),
      service: Math.round(customerFocus * 0.8 + professionalism * 0.2)
    };
  }
}

module.exports = ExternalProfileService; 