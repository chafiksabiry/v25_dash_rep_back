const mongoose = require('mongoose');

// CEFR ordering used to keep the highest proficiency across experiences.
const LANG_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const toObjectId = (id) => {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
};

/**
 * Normalize a spoken-language entry to a CEFR proficiency.
 * Uses the explicit level when valid ("Native" → C2), otherwise derives it
 * from the 0-100 confidence score.
 */
const normalizeProficiency = (level, score) => {
  if (typeof level === 'string' && level.trim()) {
    const cleaned = level.trim();
    if (/native|bilingual/i.test(cleaned)) return 'C2';
    const match = LANG_ORDER.find((l) => l.toLowerCase() === cleaned.toLowerCase());
    if (match) return match;
  }

  if (typeof score === 'number') {
    if (score >= 95) return 'C2';
    if (score >= 85) return 'C1';
    if (score >= 70) return 'B2';
    if (score >= 55) return 'B1';
    if (score >= 40) return 'A2';
    return 'A1';
  }

  return null;
};

const maxProficiency = (a, b) => {
  const ia = LANG_ORDER.indexOf(a);
  const ib = LANG_ORDER.indexOf(b);
  if (ia === -1) return b;
  if (ib === -1) return a;
  return ib > ia ? b : a;
};

// 0-100 confidence score → 0-5 skill level used by the profile.
const scoreToLevel = (score) => {
  if (typeof score !== 'number') return 1;
  if (score >= 90) return 5;
  if (score >= 75) return 4;
  if (score >= 60) return 3;
  if (score >= 40) return 2;
  return 1;
};

/**
 * Collapse the per-experience videoAnalysis blocks into profile-level insights.
 * Returns maps keyed by ObjectId string so duplicates keep their highest value.
 */
const aggregateFromExperiences = (experiences) => {
  const langMap = new Map(); // id -> proficiency
  const skillMaps = {
    technical: new Map(), // id -> level
    professional: new Map(),
    soft: new Map(),
  };
  const industryIds = new Set();
  const activityIds = new Set();

  (Array.isArray(experiences) ? experiences : []).forEach((exp) => {
    const va = exp && exp.videoAnalysis;
    if (!va || typeof va !== 'object') return;

    (va.spokenLanguages || []).forEach((entry) => {
      if (!entry || !entry.language) return;
      const id = String(entry.language);
      const prof = normalizeProficiency(entry.level, entry.score);
      if (!prof) return;
      const current = langMap.get(id);
      langMap.set(id, current ? maxProficiency(current, prof) : prof);
    });

    const collectSkills = (items, type) => {
      (items || []).forEach((entry) => {
        if (!entry || !entry.skill) return;
        const id = String(entry.skill);
        const level = scoreToLevel(entry.score);
        const current = skillMaps[type].get(id);
        skillMaps[type].set(id, current ? Math.max(current, level) : level);
      });
    };

    collectSkills(va.technicalSkills, 'technical');
    collectSkills(va.professionalSkills, 'professional');
    collectSkills(va.softSkills, 'soft');

    (va.industries || []).forEach((entry) => {
      if (entry && entry.industry) industryIds.add(String(entry.industry));
    });
    (va.activities || []).forEach((entry) => {
      if (entry && entry.activity) activityIds.add(String(entry.activity));
    });
  });

  return { langMap, skillMaps, industryIds, activityIds };
};

/**
 * Merge aggregated insights into the existing profile data and return a
 * Mongo `$set` payload. Existing manual entries are preserved; for duplicates
 * the higher proficiency / skill level wins (additive, never destructive).
 */
const buildProfileUpdate = (agent, insights) => {
  const set = {};
  const { langMap, skillMaps, industryIds, activityIds } = insights;

  // Languages — keep existing assessment data, raise proficiency to the max.
  const existingLanguages = agent?.personalInfo?.languages || [];
  const languageById = new Map();
  existingLanguages.forEach((lang) => {
    if (lang && lang.language) languageById.set(String(lang.language), { ...lang });
  });

  langMap.forEach((proficiency, id) => {
    const objectId = toObjectId(id);
    if (!objectId) return;
    const existing = languageById.get(id);
    if (existing) {
      existing.proficiency = maxProficiency(existing.proficiency || 'A1', proficiency);
    } else {
      languageById.set(id, { language: objectId, proficiency });
    }
  });

  if (langMap.size > 0) {
    set['personalInfo.languages'] = Array.from(languageById.values());
  }

  // Skills — add detected skills, keeping the highest level per skill.
  ['technical', 'professional', 'soft'].forEach((type) => {
    const detected = skillMaps[type];
    if (!detected || detected.size === 0) return;

    const existing = agent?.skills?.[type] || [];
    const byId = new Map();
    existing.forEach((entry) => {
      if (entry && entry.skill) byId.set(String(entry.skill), { ...entry });
    });

    detected.forEach((level, id) => {
      const objectId = toObjectId(id);
      if (!objectId) return;
      const current = byId.get(id);
      if (current) {
        current.level = Math.max(current.level || 0, level);
      } else {
        byId.set(id, { skill: objectId, level });
      }
    });

    set[`skills.${type}`] = Array.from(byId.values());
  });

  // Industries & activities — union of existing + detected.
  if (industryIds.size > 0) {
    const union = new Map();
    (agent?.professionalSummary?.industries || []).forEach((id) => {
      const oid = toObjectId(id);
      if (oid) union.set(String(id), oid);
    });
    industryIds.forEach((id) => {
      const oid = toObjectId(id);
      if (oid) union.set(id, oid);
    });
    set['professionalSummary.industries'] = Array.from(union.values());
  }

  if (activityIds.size > 0) {
    const union = new Map();
    (agent?.professionalSummary?.activities || []).forEach((id) => {
      const oid = toObjectId(id);
      if (oid) union.set(String(id), oid);
    });
    activityIds.forEach((id) => {
      const oid = toObjectId(id);
      if (oid) union.set(id, oid);
    });
    set['professionalSummary.activities'] = Array.from(union.values());
  }

  return set;
};

module.exports = {
  LANG_ORDER,
  normalizeProficiency,
  maxProficiency,
  scoreToLevel,
  aggregateFromExperiences,
  buildProfileUpdate,
};
