const defaultLogger = require('../utils/logger');

const pickName = (ref) => {
  if (!ref) return '';
  if (typeof ref === 'object') return ref.name || '';
  return '';
};

const refId = (ref) => (ref && typeof ref === 'object' && ref._id ? String(ref._id) : null);

const mapRefs = (items, field) =>
  (Array.isArray(items) ? items : [])
    .map((entry) => {
      const ref = entry?.[field];
      const name = pickName(ref);
      if (!name) return null;
      return { id: refId(ref), name, score: typeof entry.score === 'number' ? entry.score : null };
    })
    .filter(Boolean);

/**
 * Elements detected in the presentation, shaped for the front to display.
 * Names only (no transcript, no evidence text).
 */
const buildDetected = (analysis = {}) => {
  const languages = (Array.isArray(analysis.spokenLanguages) ? analysis.spokenLanguages : [])
    .map((entry) => {
      const name = pickName(entry?.language) || entry?.languageName || '';
      if (!name) return null;
      return {
        id: refId(entry.language),
        name,
        level: entry.level || null,
        score: typeof entry.score === 'number' ? entry.score : null,
      };
    })
    .filter(Boolean);

  const detected = {
    technicalSkills: mapRefs(analysis.technicalSkills, 'skill'),
    professionalSkills: mapRefs(analysis.professionalSkills, 'skill'),
    softSkills: mapRefs(analysis.softSkills, 'skill'),
    industries: mapRefs(analysis.industries, 'industry'),
    activities: mapRefs(analysis.activities, 'activity'),
    languages,
  };
  detected.isEmpty = Object.values(detected).every((list) => !Array.isArray(list) || list.length === 0);
  return detected;
};

/**
 * Orchestrates the presentation-video analysis and its persistence.
 * Returns { status, body } so the controller stays a thin HTTP adapter.
 * Never throws: analysis failure → clear error; persistence failure → analysis
 * still returned with saved:false (non-blocking for the wizard).
 */
const runPresentationAnalysis = async ({
  videoAnalysisService,
  profileRepository,
  profileId,
  file,
  logger = defaultLogger,
}) => {
  if (!file || !file.buffer) {
    return { status: 400, body: { code: 'NO_VIDEO', message: 'No video file provided' } };
  }

  let result;
  try {
    const referencePhotoUrl = await profileRepository.getReferencePhotoUrl(profileId);
    result = await videoAnalysisService.analyzeExperienceVideo(file.buffer, file.mimetype, {
      mode: 'presentation',
      referencePhotoUrl,
    });
  } catch (error) {
    if (error?.name === 'VideoValidationError') {
      logger.warn(`Presentation video rejected for profile ${profileId}: ${error.code}`);
      return {
        status: 400,
        body: { code: error.code || 'VIDEO_INVALID', message: error.message, details: error.details || {} },
      };
    }
    // Only the error message is logged: never a transcript, token or video content.
    logger.error(`Presentation video analysis failed for profile ${profileId}: ${error?.message}`);
    return {
      status: 502,
      body: {
        code: 'ANALYSIS_FAILED',
        message: 'The presentation video could not be analyzed. Please try again later.',
      },
    };
  }

  const detected = buildDetected(result.analysis);

  let saved = false;
  let insightsApplied = false;
  try {
    const outcome = await profileRepository.savePresentationVideoAnalysis(profileId, result);
    saved = !!outcome?.saved;
    insightsApplied = !!outcome?.insightsApplied;
    if (!saved) logger.warn(`Profile ${profileId} not found: presentation analysis not persisted`);
  } catch (persistError) {
    logger.error(
      `Failed to persist presentation analysis for profile ${profileId}: ${persistError?.message}`
    );
  }

  return {
    status: 200,
    body: {
      data: {
        saved,
        insightsApplied,
        videoUrl: result.videoUrl,
        duration: result.duration,
        transcription: result.transcription,
        summary: result.analysis?.summary || { en: '', fr: '' },
        relevance: result.relevance,
        detected,
        languageAssessment: result.languageAssessment,
        fraudCheck: result.fraudCheck,
        analysis: result.analysis,
      },
    },
  };
};

module.exports = { runPresentationAnalysis, buildDetected };
