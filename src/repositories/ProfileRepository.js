const mongoose = require('mongoose');
const Profile = require('../models/Profile');
const Agent = require('../models/Agent');
const logger = require('../utils/logger');
const {
  buildVideoAssessmentResults,
  rebuildProfileVideoInsights,
} = require('../services/VideoInsightsService');

class ProfileRepository {
  async findByUserId(userId) {
    return Profile.findOne({ userId });
  }

  /**
   * Fetch the agent's profile photo URL (used as the identity reference when
   * verifying that the person in the experience video matches the account).
   */
  async getReferencePhotoUrl(profileId) {
    const filter = mongoose.isValidObjectId(profileId)
      ? { _id: profileId }
      : { userId: profileId };
    try {
      const agent = await Agent.findOne(filter, { 'personalInfo.photo.url': 1 }).lean();
      return agent?.personalInfo?.photo?.url || null;
    } catch (err) {
      logger.warn(`Could not load reference photo for profile ${profileId}: ${err.message}`);
      return null;
    }
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
   * Persist a dedicated language-tab video assessment onto personalInfo.languages[].
   * Matches by language ObjectId, ISO code, or display name (case-insensitive).
   */
  async saveLanguageVideoAssessment(profileId, context = {}, payload = {}) {
    const filter = mongoose.isValidObjectId(profileId)
      ? { _id: profileId }
      : { userId: profileId };

    const agent = await Agent.findOne(filter).lean();
    if (!agent?.personalInfo?.languages?.length) return false;

    const { languageName = '', languageCode = '', languageId = '', expectedProficiency = '' } = context;
    const assessment = payload.assessment || {};
    if (!assessment.assessable || !assessment.languageMatch?.matches) return false;

    const langs = agent.personalInfo.languages;
    const targetName = String(languageName || '').trim().toLowerCase();
    const targetCode = String(languageCode || '').trim().toLowerCase();
    const targetId = String(languageId || '').trim();

    const idx = langs.findIndex((entry) => {
      if (!entry) return false;
      const ref = entry.language;
      if (targetId && ref) {
        const refId = typeof ref === 'object' && ref._id ? String(ref._id) : String(ref);
        if (refId === targetId) return true;
      }
      if (targetCode && String(entry.iso639_1 || entry.code || '').toLowerCase() === targetCode) return true;
      if (typeof ref === 'string' && !mongoose.isValidObjectId(ref) && targetName) {
        return ref.toLowerCase() === targetName;
      }
      if (typeof ref === 'object' && ref?.name && targetName) {
        return String(ref.name).toLowerCase() === targetName;
      }
      return false;
    });

    if (idx < 0) return false;

    const flattenFeedback = (sub) => {
      if (!sub?.feedback) return '';
      if (typeof sub.feedback === 'string') return sub.feedback;
      return sub.feedback.en || sub.feedback.fr || '';
    };

    const summaryText =
      typeof assessment.summary === 'string'
        ? assessment.summary
        : assessment.summary?.en || assessment.summary?.fr || '';

    const verifiedLevel =
      assessment.meetsClaimedLevel && expectedProficiency
        ? String(expectedProficiency).toUpperCase()
        : String(assessment.cefr || langs[idx].proficiency || expectedProficiency || '').toUpperCase();

    const videoAssessment = buildVideoAssessmentResults(
      assessment.overallScore,
      verifiedLevel,
      summaryText || flattenFeedback(assessment.fluency),
      {
        source: 'language',
        verifiedProficiency: verifiedLevel,
        fluency: {
          score: assessment.fluency?.score ?? assessment.overallScore ?? 0,
          feedback: flattenFeedback(assessment.fluency),
        },
        proficiency: {
          score: assessment.grammar?.score ?? assessment.overallScore ?? 0,
          feedback: flattenFeedback(assessment.grammar),
        },
        completeness: {
          score: assessment.vocabulary?.score ?? assessment.overallScore ?? 0,
          feedback: flattenFeedback(assessment.vocabulary),
        },
        overall: {
          score: assessment.overallScore ?? 0,
          strengths: summaryText || `CEFR ${verifiedLevel} verified by language video`,
          areasForImprovement: flattenFeedback(assessment.coherence),
        },
        videoUrl: payload.videoUrl || null,
        verifiedAt: new Date(),
      }
    );

    const set = {
      [`personalInfo.languages.${idx}.assessmentResults`]: videoAssessment,
      [`personalInfo.languages.${idx}.proficiency`]: verifiedLevel,
    };

    const res = await Agent.updateOne(filter, { $set: set });
    return res.matchedCount > 0;
  }

  /**
   * Rebuild profile-level skills/languages from experiences that still have
   * a valid video URL and analysis. Stale video-derived skills are removed
   * when the source video is gone — the REP must re-upload and re-analyze.
   */
  async applyVideoInsights(filter) {
    try {
      const agent = await Agent.findOne(filter).lean();
      if (!agent) return false;

      const set = rebuildProfileVideoInsights(agent);

      if (Object.keys(set).length === 0) return false;

      await Agent.updateOne(filter, { $set: set });
      logger.info(
        `Applied video insights to agent ${agent._id}: ` +
          `${set['personalInfo.languages']?.length || 0} languages, ` +
          `tech=${set['skills.technical']?.length || 0}, ` +
          `prof=${set['skills.professional']?.length || 0}, ` +
          `soft=${set['skills.soft']?.length || 0}, ` +
          `industries=${set['professionalSummary.industries']?.length || 0}, ` +
          `activities=${set['professionalSummary.activities']?.length || 0}`
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