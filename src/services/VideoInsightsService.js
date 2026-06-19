const mongoose = require('mongoose');

// CEFR ordering used to keep the highest proficiency across experiences.
const LANG_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const toObjectId = (id) => {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
};

// Bilingual AI text fields are stored as { en, fr }; the linguistic-profile
// aggregate keeps a single canonical string, so flatten to English here.
const flattenText = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.en || value.fr || '';
  return '';
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

const maxScore = (a, b) => {
  const na = typeof a === 'number' ? a : 0;
  const nb = typeof b === 'number' ? b : 0;
  return Math.max(na, nb);
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

const buildVideoAssessmentResults = (score, proficiency, evidence, extra = {}) => {
  const safeScore = typeof score === 'number' ? Math.round(score) : 0;
  const feedback = evidence || 'Detected from experience video analysis';

  return {
    completeness: { score: safeScore, feedback },
    fluency: { score: safeScore, feedback },
    proficiency: { score: safeScore, feedback },
    overall: {
      score: safeScore,
      strengths: proficiency ? `CEFR ${proficiency} demonstrated in experience video` : 'Demonstrated in experience video',
      areasForImprovement: '',
    },
    source: 'video',
    completedAt: new Date(),
    ...extra,
  };
};

const mergeAssessmentResults = (existing, incoming) => {
  if (!existing) return incoming;
  if (!incoming) return existing;

  return {
    completeness: {
      score: maxScore(existing.completeness?.score, incoming.completeness?.score),
      feedback: incoming.completeness?.score >= (existing.completeness?.score || 0)
        ? incoming.completeness?.feedback
        : existing.completeness?.feedback,
    },
    fluency: {
      score: maxScore(existing.fluency?.score, incoming.fluency?.score),
      feedback: incoming.fluency?.score >= (existing.fluency?.score || 0)
        ? incoming.fluency?.feedback
        : existing.fluency?.feedback,
    },
    proficiency: {
      score: maxScore(existing.proficiency?.score, incoming.proficiency?.score),
      feedback: incoming.proficiency?.score >= (existing.proficiency?.score || 0)
        ? incoming.proficiency?.feedback
        : existing.proficiency?.feedback,
    },
    overall: {
      score: maxScore(existing.overall?.score, incoming.overall?.score),
      strengths: incoming.overall?.score >= (existing.overall?.score || 0)
        ? incoming.overall?.strengths
        : existing.overall?.strengths,
      areasForImprovement: existing.overall?.areasForImprovement || incoming.overall?.areasForImprovement || '',
    },
    source: incoming.source || existing.source || 'video',
    completedAt: incoming.completedAt || existing.completedAt,
  };
};

/**
 * Collapse the per-experience videoAnalysis blocks into profile-level insights.
 * Returns maps keyed by ObjectId string so duplicates keep their highest value.
 */
const aggregateFromExperiences = (experiences) => {
  const langMap = new Map(); // id -> { proficiency, score, evidence }
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
      const id = String(entry.language._id || entry.language);
      const prof = normalizeProficiency(entry.level, entry.score);
      if (!prof) return;

      const score = typeof entry.score === 'number' ? entry.score : 0;
      const evidence = flattenText(entry.evidence);
      const current = langMap.get(id);
      if (!current) {
        langMap.set(id, { proficiency: prof, score, evidence });
        return;
      }

      langMap.set(id, {
        proficiency: maxProficiency(current.proficiency, prof),
        score: maxScore(current.score, score),
        evidence: score >= current.score ? (evidence || current.evidence) : current.evidence,
      });
    });

    const collectSkills = (items, type) => {
      (items || []).forEach((entry) => {
        if (!entry || !entry.skill) return;
        const id = String(entry.skill._id || entry.skill);
        const level = scoreToLevel(entry.score);
        const current = skillMaps[type].get(id);
        skillMaps[type].set(id, current ? Math.max(current, level) : level);
      });
    };

    collectSkills(va.technicalSkills, 'technical');
    collectSkills(va.professionalSkills, 'professional');
    collectSkills(va.softSkills, 'soft');

    (va.industries || []).forEach((entry) => {
      if (entry && entry.industry) industryIds.add(String(entry.industry._id || entry.industry));
    });
    (va.activities || []).forEach((entry) => {
      if (entry && entry.activity) activityIds.add(String(entry.activity._id || entry.activity));
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

  // Languages — keep existing assessment data, raise proficiency & scores to max.
  const existingLanguages = agent?.personalInfo?.languages || [];
  const languageById = new Map();
  existingLanguages.forEach((lang) => {
    if (lang && lang.language) languageById.set(String(lang.language), { ...lang });
  });

  langMap.forEach((data, id) => {
    const objectId = toObjectId(id);
    if (!objectId) return;

    const videoAssessment = buildVideoAssessmentResults(data.score, data.proficiency, data.evidence);
    const existing = languageById.get(id);

    if (existing) {
      const existingVerified = existing.assessmentResults && existing.assessmentResults.source === 'video';
      if (existingVerified) {
        // Already verified by a previous video: keep the strongest measurement
        // across genuine video assessments (never downgrade a real result).
        existing.proficiency = maxProficiency(existing.proficiency || 'A1', data.proficiency);
        existing.assessmentResults = mergeAssessmentResults(existing.assessmentResults, videoAssessment);
      } else {
        // Existing level was only a CV estimate (or unset). The measured video
        // assessment is authoritative and OVERRIDES it — even if it's lower
        // (e.g. CV claimed C2 but the video demonstrates C1).
        existing.proficiency = data.proficiency;
        existing.assessmentResults = videoAssessment;
      }
    } else {
      languageById.set(id, {
        language: objectId,
        proficiency: data.proficiency,
        assessmentResults: videoAssessment,
      });
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
        byId.set(id, { skill: objectId, level, details: 'Detected from experience video' });
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
  buildVideoAssessmentResults,
  mergeAssessmentResults,
  aggregateFromExperiences,
  buildProfileUpdate,
};
