const Profile = require('../models/Profile');

class ProfileRepository {
  async findByUserId(userId) {
    return Profile.findOne({ userId });
  }

  async create(profileData) {
    const profile = new Profile(profileData);
    // Update completion status before saving
    profile.updateCompletionStatus();
    return profile.save();
  }

  async update(userId, profileData) {
    // Create an object for update with dot notation for nested fields
    const updateData = {};
    
    // Process the data to use dot notation for nested properties
    const flattenObject = (obj, prefix = '') => {
      for (const key in obj) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          if (Array.isArray(obj[key])) {
            // Handle arrays directly
            updateData[`${prefix}${key}`] = obj[key];
          } else {
            // Recursively flatten nested objects
            flattenObject(obj[key], `${prefix}${key}.`);
          }
        } else {
          // For simple fields, add them directly
          updateData[`${prefix}${key}`] = obj[key];
        }
      }
    };
    
    flattenObject(profileData);
    
    const profile = await Profile.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (profile) {
      // Update completion status after update
      profile.updateCompletionStatus();
      await profile.save();
    }

    return profile;
  }

  async delete(userId) {
    const result = await Profile.deleteOne({ userId });
    return result.deletedCount > 0;
  }

  async updateLanguages(userId, languages) {
    const profile = await Profile.findOneAndUpdate(
      { userId },
      { $set: { 'personalInfo.languages': languages } },
      { new: true }
    );

    if (profile) {
      profile.updateCompletionStatus();
      await profile.save();
    }

    return profile;
  }

  async updateSkills(userId, skillType, skills) {
    const updateField = `skills.${skillType}`;
    const profile = await Profile.findOneAndUpdate(
      { userId },
      { $set: { [updateField]: skills } },
      { new: true }
    );

    if (profile) {
      profile.updateCompletionStatus();
      await profile.save();
    }

    return profile;
  }

  async updateExperience(userId, experience) {
    const profile = await Profile.findOneAndUpdate(
      { userId },
      { $set: { experience } },
      { new: true }
    );

    if (profile) {
      profile.updateCompletionStatus();
      await profile.save();
    }

    return profile;
  }

  async updateAchievements(userId, achievements) {
    const profile = await Profile.findOneAndUpdate(
      { userId },
      { $set: { achievements } },
      { new: true }
    );

    if (profile) {
      profile.updateCompletionStatus();
      await profile.save();
    }

    return profile;
  }

  async updateAvailability(userId, availability) {
    return Profile.findOneAndUpdate(
      { userId },
      { $set: { availability } },
      { new: true }
    );
  }

  async updatePersonalInfo(userId, personalInfo) {
    const profile = await Profile.findOneAndUpdate(
      { userId },
      { $set: { personalInfo } },
      { new: true }
    );

    if (profile) {
      profile.updateCompletionStatus();
      await profile.save();
    }

    return profile;
  }

  async updateProfessionalSummary(userId, professionalSummary) {
    return Profile.findOneAndUpdate(
      { userId },
      { $set: { professionalSummary } },
      { new: true }
    );
  }
}

module.exports = ProfileRepository; 