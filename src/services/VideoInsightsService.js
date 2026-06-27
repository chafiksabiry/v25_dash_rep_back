const mongoose = require('mongoose');

// CEFR ordering used to keep the highest proficiency across experiences.
const LANG_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VIDEO_SKILL_DETAILS = 'Detected from experience video';

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
  const verifiedProficiency = extra.verifiedProficiency || proficiency || null;

  return {
    completeness: { score: safeScore, feedback },
    fluency: { score: safeScore, feedback },
    proficiency: { score: safeScore, feedback },
    overall: {
      score: safeScore,
      strengths: verifiedProficiency
        ? `CEFR ${verifiedProficiency} demonstrated`
        : 'Demonstrated in video',
      areasForImprovement: '',
    },
    verifiedProficiency,
    source: extra.source || 'video',
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

  (Array.isArray(experiences) ? experiences : []).forEach((exp, expIndex) => {
    if (!exp?.videoUrl) return;
    const va = exp && exp.videoAnalysis;
    if (!va || typeof va !== 'object') return;

    (va.spokenLanguages || []).forEach((entry) => {
      if (!entry || !entry.language) return;
      const id = String(entry.language._id || entry.language);
      const prof = normalizeProficiency(entry.level, entry.score);
      if (!prof) return;

      const score = typeof entry.score === 'number' ? entry.score : 0;
      const evidence = flattenText(entry.evidence);
      const experienceVideoUrl = exp.videoUrl || null;
      const current = langMap.get(id);
      if (!current) {
        langMap.set(id, { proficiency: prof, score, evidence, experienceVideoUrl, experienceIndex: expIndex });
        return;
      }

      const keepCurrent = current.score > score;
      langMap.set(id, {
        proficiency: maxProficiency(current.proficiency, prof),
        score: maxScore(current.score, score),
        evidence: keepCurrent ? current.evidence : (evidence || current.evidence),
        experienceVideoUrl: keepCurrent ? current.experienceVideoUrl : experienceVideoUrl,
        experienceIndex: keepCurrent ? current.experienceIndex : expIndex,
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

  const excluded = new Set(
    (agent?.personalInfo?.excludedLanguageIds || []).map((id) => String(id))
  );

  langMap.forEach((data, id) => {
    if (excluded.has(id)) return;

    const objectId = toObjectId(id);
    if (!objectId) return;

    const existing = languageById.get(id);

    // Dedicated language-tab verification is never overwritten by experience aggregation.
    if (existing?.assessmentResults?.source === 'language') {
      return;
    }

    const videoAssessment = buildVideoAssessmentResults(data.score, data.proficiency, data.evidence, {
      source: 'experience',
      verifiedProficiency: data.proficiency,
      experienceVideoUrl: data.experienceVideoUrl || null,
      experienceIndex: typeof data.experienceIndex === 'number' ? data.experienceIndex : null,
    });

    if (existing) {
      const existingSource = existing.assessmentResults?.source;
      if (existingSource === 'language') {
        return;
      }
      if (existingSource === 'experience' || existingSource === 'video') {
        existing.proficiency = maxProficiency(existing.proficiency || 'A1', data.proficiency);
        existing.assessmentResults = mergeAssessmentResults(existing.assessmentResults, {
          ...videoAssessment,
          source: 'experience',
          verifiedProficiency: existing.assessmentResults?.verifiedProficiency || data.proficiency,
          experienceVideoUrl: data.experienceVideoUrl || existing.assessmentResults?.experienceVideoUrl,
          experienceIndex:
            typeof data.experienceIndex === 'number'
              ? data.experienceIndex
              : existing.assessmentResults?.experienceIndex,
        });
      } else {
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
        byId.set(id, { skill: objectId, level, details: VIDEO_SKILL_DETAILS });
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

const stripVideoDerivedSkills = (skills = {}) => {
  const cleaned = {};
  ['technical', 'professional', 'soft', 'contactCenter'].forEach((type) => {
    cleaned[type] = (skills[type] || []).filter(
      (entry) => entry?.details !== VIDEO_SKILL_DETAILS,
    );
  });
  return cleaned;
};

const stripExperienceLanguageAssessments = (languages = []) =>
  (Array.isArray(languages) ? languages : []).map((lang) => {
    if (!lang) return lang;
    const source = lang.assessmentResults?.source;
    if (source === 'language') return lang;
    if (source === 'experience' || source === 'video') {
      const { assessmentResults, ...rest } = lang;
      return rest;
    }
    return lang;
  });

/**
 * Rebuild profile-level skills/languages from experiences that still have a video URL
 * and analysis. Removes stale "Detected from experience video" skills when the source
 * video is gone — user must re-upload and re-analyze.
 */
const rebuildProfileVideoInsights = (agent) => {
  const validExperiences = (Array.isArray(agent?.experience) ? agent.experience : []).filter(
    (exp) => exp?.videoUrl && exp?.videoAnalysis,
  );
  const cleanedAgent = {
    ...agent,
    skills: stripVideoDerivedSkills(agent?.skills),
    personalInfo: {
      ...(agent?.personalInfo || {}),
      languages: stripExperienceLanguageAssessments(agent?.personalInfo?.languages),
    },
    experience: validExperiences,
  };
  const insights = aggregateFromExperiences(validExperiences);
  return buildProfileUpdate(cleanedAgent, insights);
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
  VIDEO_SKILL_DETAILS,
  stripVideoDerivedSkills,
  rebuildProfileVideoInsights,
};
