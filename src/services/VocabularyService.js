const mongoose = require('mongoose');
const TechnicalSkill = require('../models/TechnicalSkill');
const ProfessionalSkill = require('../models/ProfessionalSkill');
const SoftSkill = require('../models/SoftSkill');
const Industry = require('../models/Industry');
const Activity = require('../models/Activity');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

class VocabularyService {
  constructor() {
    this._cache = null;
    this._cachedAt = 0;
  }

  async _names(Model) {
    const docs = await Model.find({ isActive: { $ne: false } }, { name: 1 }).lean();
    return docs.map((d) => d.name).filter(Boolean);
  }

  /**
   * Load the platform vocabularies directly from the shared MongoDB collections.
   * Returns empty arrays if the DB is unavailable so analysis can still proceed.
   */
  async getVocabulary() {
    const now = Date.now();
    if (this._cache && now - this._cachedAt < CACHE_TTL_MS) {
      return this._cache;
    }

    if (mongoose.connection.readyState !== 1) {
      logger.warn('Vocabulary requested but MongoDB is not connected — returning empty lists');
      return {
        technicalSkills: [],
        professionalSkills: [],
        softSkills: [],
        industries: [],
        activities: [],
      };
    }

    const [technicalSkills, professionalSkills, softSkills, industries, activities] = await Promise.all([
      this._names(TechnicalSkill),
      this._names(ProfessionalSkill),
      this._names(SoftSkill),
      this._names(Industry),
      this._names(Activity),
    ]);

    this._cache = { technicalSkills, professionalSkills, softSkills, industries, activities };
    this._cachedAt = now;

    logger.info(
      `Loaded vocabulary from DB: tech=${technicalSkills.length}, prof=${professionalSkills.length}, ` +
        `soft=${softSkills.length}, ind=${industries.length}, act=${activities.length}`
    );

    return this._cache;
  }
}

module.exports = VocabularyService;
