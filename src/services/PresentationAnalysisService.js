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

const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/**
 * Orchestrates the presentation-video analysis and its persistence.
 * Returns { status, body } so the controller stays a thin HTTP adapter.
 *
 * Authorization comes first, BEFORE any external call (Cloudinary/OpenAI):
 * the identity must come from a VERIFIED token (`authVerified`), never from a
 * header, and must own the requested profile (`:id` = agent _id or userId).
 *
 * Never throws: analysis failure → clear error; persistence failure → analysis
 * still returned with saved:false (non-blocking for the wizard).
 */
const runPresentationAnalysis = async ({
  videoAnalysisService,
  profileRepository,
  profileId,
  requesterId,
  authVerified,
  file,
  logger = defaultLogger,
}) => {
  if (!authVerified || !requesterId) {
    return { status: 401, body: { code: 'UNAUTHENTICATED', message: 'A valid token is required' } };
  }

  let owner;
  try {
    owner = await profileRepository.resolveAgentIdentity(profileId);
  } catch (error) {
    logger.error(`Presentation analysis: profile lookup failed: ${error?.message}`);
    return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Presentation analysis failed' } };
  }
  if (!owner) {
    return { status: 404, body: { code: 'PROFILE_NOT_FOUND', message: 'Profile not found' } };
  }
  if (!sameId(owner.userId, requesterId)) {
    logger.warn(`Presentation analysis refused: token does not own profile ${profileId}`);
    return { status: 403, body: { code: 'FORBIDDEN', message: 'You cannot analyze another profile' } };
  }

  if (!file || !file.buffer) {
    return { status: 400, body: { code: 'NO_VIDEO', message: 'No video file provided' } };
  }

  // From here on, always address the agent by its resolved _id.
  const agentId = String(owner._id);

  let result;
  try {
    const referencePhotoUrl = await profileRepository.getReferencePhotoUrl(agentId);
    result = await videoAnalysisService.analyzeExperienceVideo(file.buffer, file.mimetype, {
      mode: 'presentation',
      referencePhotoUrl,
    });
  } catch (error) {
    if (error?.name === 'VideoValidationError') {
      logger.warn(`Presentation video rejected for profile ${agentId}: ${error.code}`);
      return {
        status: 400,
        body: { code: error.code || 'VIDEO_INVALID', message: error.message, details: error.details || {} },
      };
    }
    // Only the error message is logged: never a transcript, token or video content.
    logger.error(`Presentation video analysis failed for profile ${agentId}: ${error?.message}`);
    return {
      status: 502,
      body: {
        code: 'ANALYSIS_FAILED',
        message: 'The presentation video could not be analyzed. Please try again later.',
      },
    };
  }

  const detected = buildDetected(result.analysis);

  // One Cloudinary copy per candidate: when the wizard already holds the
  // presentation video, the analysis copy is not referenced and is deleted.
  const reuseWizardVideo = !!owner.presentationVideoUrl && result.videoUrl !== owner.presentationVideoUrl;
  const toPersist = reuseWizardVideo ? { ...result, videoUrl: null } : result;

  let saved = false;
  let insightsApplied = false;
  try {
    const outcome = await profileRepository.savePresentationVideoAnalysis(agentId, toPersist);
    saved = !!outcome?.saved;
    insightsApplied = !!outcome?.insightsApplied;
    if (!saved) logger.warn(`Profile ${agentId} not updated: presentation analysis not persisted`);
  } catch (persistError) {
    logger.error(`Failed to persist presentation analysis for profile ${agentId}: ${persistError?.message}`);
  }

  // The analysis copy is referenced only when persisted AND the wizard has no video
  // of its own; in every other case it is deleted (never left orphaned).
  if (result.videoUrl && (reuseWizardVideo || !saved)) {
    await videoAnalysisService.deleteUploadedVideo(result.videoUrl);
  }

  return {
    status: 200,
    body: {
      data: {
        saved,
        insightsApplied,
        detected,
        summary: result.analysis?.summary || { en: '', fr: '' },
        relevance: result.relevance,
      },
    },
  };
};

module.exports = { runPresentationAnalysis, buildDetected };
