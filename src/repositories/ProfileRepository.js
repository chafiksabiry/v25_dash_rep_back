const mongoose = require('mongoose');
const Profile = require('../models/Profile');
const Agent = require('../models/Agent');
const logger = require('../utils/logger');
const {
  aggregateFromExperiences,
  buildProfileUpdate,
} = require('../services/VideoInsightsService');

class ProfileRepository {
  async findByUserId(userId) {
    return Profile.findOne({ userId });
  }

  /**
   * Persist the AI video analysis onto a single experience entry.
   * The profile is matched by _id (falling back to userId), and the
   * experience entry by array index (falling back to title/company match).
   * Returns true if a document was modified.
   */
  /**
   * Strip display-only `name` fields from the resolved vocabulary refs so the
   * persisted analysis keeps ObjectId references only (UI receives names separately).
   */
  static toObjectIdRef(value) {
    if (!value) return value;
    if (typeof value === 'object' && value._id) return value._id;
    return value;
  }

  sanitizeAnalysisForStorage(analysis) {
    if (!analysis || typeof analysis !== 'object') return analysis;

    const toObjectId = ProfileRepository.toObjectIdRef;

    const stripForStorage = (items, refField) =>
      Array.isArray(items)
        ? items.map(({ name, ...rest }) => ({
            ...rest,
            [refField]: toObjectId(rest[refField]),
          }))
        : items;

    return {
      ...analysis,
      technicalSkills: stripForStorage(analysis.technicalSkills, 'skill'),
      professionalSkills: stripForStorage(analysis.professionalSkills, 'skill'),
      softSkills: stripForStorage(analysis.softSkills, 'skill'),
      spokenLanguages: stripForStorage(analysis.spokenLanguages, 'language'),
      industries: stripForStorage(analysis.industries, 'industry'),
      activities: stripForStorage(analysis.activities, 'activity'),
    };
  }

  // Keep language ObjectId refs only when persisting the detailed assessment.
  sanitizeLanguageAssessmentForStorage(languageAssessment) {
    if (!languageAssessment || typeof languageAssessment !== 'object') return languageAssessment;

    const languages = Array.isArray(languageAssessment.languages)
      ? languageAssessment.languages.map((entry) => {
          if (entry?.language) {
            const { ...rest } = entry;
            return { ...rest, language: ProfileRepository.toObjectIdRef(entry.language) };
          }
          return entry;
        })
      : [];

    return { ...languageAssessment, languages };
  }

  async saveExperienceVideoAnalysis(profileId, experienceIndex, payload, context = {}) {
    const fields = {
      videoUrl: payload.videoUrl || null,
      videoDuration: payload.duration || null,
      videoTranscription: payload.transcription || '',
      videoAnalysis: this.sanitizeAnalysisForStorage(payload.analysis) || {},
      videoLanguageAssessment: this.sanitizeLanguageAssessmentForStorage(payload.languageAssessment) || {},
      videoFraudCheck: payload.fraudCheck || {},
      videoRelevance: payload.relevance || {},
      videoAnalyzedAt: new Date(),
    };

    // Build the profile filter (_id when valid, otherwise userId).
    const filter = mongoose.isValidObjectId(profileId)
      ? { _id: profileId }
      : { userId: profileId };

    const idx = Number.isInteger(experienceIndex) ? experienceIndex : parseInt(experienceIndex, 10);

    if (Number.isInteger(idx) && idx >= 0) {
      const set = {};
      Object.entries(fields).forEach(([k, v]) => {
        set[`experience.${idx}.${k}`] = v;
      });
      const res = await Agent.updateOne(filter, { $set: set });
      if (res.matchedCount > 0) {
        // Always aggregate: off-topic experiences already have empty skills/
        // industries/activities, so only their (real) spoken languages flow up.
        await this.applyVideoInsights(filter);
        return true;
      }
    }

    // Fallback: match the experience entry by title (+ company) using arrayFilters.
    if (context.title) {
      const set = {};
      Object.entries(fields).forEach(([k, v]) => {
        set[`experience.$[e].${k}`] = v;
      });
      const arrayFilter = { 'e.title': context.title };
      if (context.company) arrayFilter['e.company'] = context.company;
      const res = await Agent.updateOne(filter, { $set: set }, { arrayFilters: [arrayFilter] });
      if (res.matchedCount > 0) {
        await this.applyVideoInsights(filter);
        return true;
      }
    }

    return false;
  }

  /**
   * Aggregate every experience's videoAnalysis into profile-level skills,
   * languages, industries and activities. Languages keep the highest CEFR
   * level across experiences; skills are added (highest level wins). This is
   * additive and never removes manually-entered data.
   */
  async applyVideoInsights(filter) {
    try {
      const agent = await Agent.findOne(filter).lean();
      if (!agent) return false;

      const insights = aggregateFromExperiences(agent.experience);
      const set = buildProfileUpdate(agent, insights);

      if (Object.keys(set).length === 0) return false;

      await Agent.updateOne(filter, { $set: set });
      logger.info(
        `Applied video insights to agent ${agent._id}: ` +
          `${set['personalInfo.languages']?.length || 0} languages, ` +
          `tech=${set['skills.technical']?.length || 0}, ` +
          `prof=${set['skills.professional']?.length || 0}, ` +
          `soft=${set['skills.soft']?.length || 0}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to apply video insights: ${error.message}`, { error });
      return false;
    }
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