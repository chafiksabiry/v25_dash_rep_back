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

const toMap = (docs) => new Map((docs || []).map((d) => [String(d._id), d.name]));

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

    return {
      skill: new Map([...toMap(technical), ...toMap(professional), ...toMap(soft)]),
      industry: toMap(industries),
      activity: toMap(activities),
      language: toMap(languages),
    };
  }

  enrichAnalysis(analysis, maps) {
    if (!analysis || typeof analysis !== 'object') return analysis;

    const populateRef = (items, idField, mapKey) =>
      (Array.isArray(items) ? items : []).map((item) => {
        if (!item) return item;
        if (typeof item[idField] === 'object' && item[idField]?.name) return item;
        const id = toId(item[idField]);
        const name = id ? maps[mapKey]?.get(id) : null;
        if (!name) return item;
        return { ...item, [idField]: { _id: id, name } };
      });

    return {
      ...analysis,
      technicalSkills: populateRef(analysis.technicalSkills, 'skill', 'skill'),
      professionalSkills: populateRef(analysis.professionalSkills, 'skill', 'skill'),
      softSkills: populateRef(analysis.softSkills, 'skill', 'skill'),
      spokenLanguages: populateRef(analysis.spokenLanguages, 'language', 'language'),
      industries: populateRef(analysis.industries, 'industry', 'industry'),
      activities: populateRef(analysis.activities, 'activity', 'activity'),
    };
  }

  async enrichExperiences(experiences) {
    if (!Array.isArray(experiences) || experiences.length === 0) return experiences;
    if (mongoose.connection.readyState !== 1) return experiences;

    const maps = await this.loadNameMaps();
    return experiences.map((exp) => {
      if (!exp?.videoAnalysis) return exp;
      return { ...exp, videoAnalysis: this.enrichAnalysis(exp.videoAnalysis, maps) };
    });
  }
}

module.exports = VideoAnalysisEnrichmentService;
