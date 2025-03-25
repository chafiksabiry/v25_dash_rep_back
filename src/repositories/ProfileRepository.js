const Profile = require('../models/Profile');

class ProfileRepository {
  async findByUserId(userId) {
    return Profile.findOne({ userId });
  }

  async create(profileData) {
    const profile = new Profile(profileData);
    return profile.save();
  }

  async update(userId, profileData) {
    // Create an object for update with dot notation for nested fields
    const updateData = {};
    
    // Process the data to use dot notation for nested properties
    for (const key in profileData) {
      if (typeof profileData[key] === 'object' && profileData[key] !== null && !Array.isArray(profileData[key])) {
        // For nested objects, create entries with dot notation
        for (const nestedKey in profileData[key]) {
          updateData[`${key}.${nestedKey}`] = profileData[key][nestedKey];
        }
      } else {
        // For simple fields or arrays, add them directly
        updateData[key] = profileData[key];
      }
    }
    
    return Profile.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(userId) {
    const result = await Profile.deleteOne({ userId });
    return result.deletedCount > 0;
  }

  async updateAchievements(userId, achievements) {
    // If achievements is an array, set it directly
    return Profile.findOneAndUpdate(
      { userId },
      { $set: { achievements } },
      { new: true }
    );
  }

  async updatePerformance(userId, performance) {
    // Create update object with dot notation for nested performance fields
    const updateData = {};
    
    for (const key in performance) {
      updateData[`performance.${key}`] = performance[key];
    }
    
    return Profile.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true }
    );
  }

  async updatePoints(userId, points) {
    return Profile.findOneAndUpdate(
      { userId },
      { $set: { points } },
      { new: true }
    );
  }
}

module.exports = ProfileRepository; 