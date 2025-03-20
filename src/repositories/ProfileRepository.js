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
    return Profile.findOneAndUpdate(
      { userId },
      { $set: profileData },
      { new: true, runValidators: true }
    );
  }

  async delete(userId) {
    const result = await Profile.deleteOne({ userId });
    return result.deletedCount > 0;
  }

  async updateAchievements(userId, achievements) {
    return Profile.findOneAndUpdate(
      { userId },
      { $set: { achievements } },
      { new: true }
    );
  }

  async updatePerformance(userId, performance) {
    return Profile.findOneAndUpdate(
      { userId },
      { $set: { performance } },
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