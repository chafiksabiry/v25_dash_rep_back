const mongoose = require('mongoose');
const TechnicalSkill = require('../models/TechnicalSkill');
const ProfessionalSkill = require('../models/ProfessionalSkill');
const SoftSkill = require('../models/SoftSkill');
const Industry = require('../models/Industry');
const Activity = require('../models/Activity');
const Language = require('../models/Language');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const emptyVocabulary = () => ({
  technicalSkills: [],
  professionalSkills: [],
  softSkills: [],
  industries: [],
  activities: [],
  languages: [],
});

class VocabularyService {
  constructor() {
    this._cache = null;
    this._cachedAt = 0;
  }

  async _items(Model, fields = { name: 1 }) {
    const docs = await Model.find({ isActive: { $ne: false } }, fields).lean();
    return docs
      .filter((doc) => doc.name)
      .map((doc) => ({
        id: doc._id,
        name: doc.name,
        ...(doc.code ? { code: doc.code } : {}),
      }));
  }

  /**
   * Load platform vocabularies with both ObjectId and display name.
   * Returns empty arrays if the DB is unavailable so analysis can still proceed.
   */
  async getVocabulary() {
    const now = Date.now();
    if (this._cache && now - this._cachedAt < CACHE_TTL_MS) {
      return this._cache;
    }

    if (mongoose.connection.readyState !== 1) {
      logger.warn('Vocabulary requested but MongoDB is not connected — returning empty lists');
      return emptyVocabulary();
    }

    const [technicalSkills, professionalSkills, softSkills, industries, activities, languages] =
      await Promise.all([
        this._items(TechnicalSkill),
        this._items(ProfessionalSkill),
        this._items(SoftSkill),
        this._items(Industry),
        this._items(Activity),
        this._items(Language, { name: 1, code: 1 }),
      ]);

    this._cache = {
      technicalSkills,
      professionalSkills,
      softSkills,
      industries,
      activities,
      languages,
    };
    this._cachedAt = now;

    logger.info(
      `Loaded vocabulary from DB: tech=${technicalSkills.length}, prof=${professionalSkills.length}, ` +
        `soft=${softSkills.length}, ind=${industries.length}, act=${activities.length}, lang=${languages.length}`
    );

    return this._cache;
  }
}

module.exports = VocabularyService;
