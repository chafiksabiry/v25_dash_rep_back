const mongoose = require('mongoose');
const TechnicalSkill = require('../models/TechnicalSkill');
const ProfessionalSkill = require('../models/ProfessionalSkill');
const SoftSkill = require('../models/SoftSkill');
const Industry = require('../models/Industry');
const Activity = require('../models/Activity');
const Language = require('../models/Language');

const toId = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

class VideoAnalysisEnrichmentService {
  async loadNameMaps() {
    const [technical, professional, soft, industries, activities, languages] = await Promise.all([
      TechnicalSkill.find({ isActive: { $ne: false } }, { name: 1 }).lean(),
      ProfessionalSkill.find({ isActive: { $ne: false } }, { name: 1 }).lean(),
      SoftSkill.find({ isActive: { $ne: false } }, { name: 1 }).lean(),
      Industry.find({ isActive: { $ne: false } }, { name: 1 }).lean(),
      Activity.find({ isActive: { $ne: false } }, { name: 1 }).lean(),
      Language.find({}, { name: 1 }).lean(),
    ]);

    const toMap = (docs) => new Map(docs.map((d) => [String(d._id), d.name]));

    return {
      skill: new Map([...toMap(technical), ...toMap(professional), ...toMap(soft)]),
      industry: toMap(industries),
      activity: toMap(activities),
      language: toMap(languages),
    };
  }

  enrichAnalysis(analysis, maps) {
    if (!analysis || typeof analysis !== 'object') return analysis;

    const addName = (items, idField) =>
      (Array.isArray(items) ? items : []).map((item) => {
        if (!item) return item;
        const id = toId(item[idField]);
        const name = id ? maps[idField === 'language' ? 'language' : idField]?.get(id) : null;
        return name ? { ...item, name } : item;
      });

    return {
      ...analysis,
      technicalSkills: addName(analysis.technicalSkills, 'skill'),
      professionalSkills: addName(analysis.professionalSkills, 'skill'),
      softSkills: addName(analysis.softSkills, 'skill'),
      spokenLanguages: addName(analysis.spokenLanguages, 'language'),
      industries: addName(analysis.industries, 'industry'),
      activities: addName(analysis.activities, 'activity'),
    };
  }

  async enrichExperiences(experiences) {
    if (!Array.isArray(experiences) || experiences.length === 0) return experiences;
    if (mongoose.connection.readyState !== 1) return experiences;

    const maps = await this.loadNameMaps();
    const skillMaps = {
      skill: maps.skill,
      industry: maps.industry,
      activity: maps.activity,
      language: maps.language,
    };

    return experiences.map((exp) => {
      if (!exp?.videoAnalysis) return exp;
      return {
        ...exp,
        videoAnalysis: this.enrichAnalysis(exp.videoAnalysis, skillMaps),
      };
    });
  }
}

module.exports = VideoAnalysisEnrichmentService;
