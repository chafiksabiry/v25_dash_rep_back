const { runPresentationAnalysis, buildDetected } = require('../src/services/PresentationAnalysisService');

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const file = { buffer: Buffer.from('x'), mimetype: 'video/webm' };

const pipelineResult = () => ({
  videoUrl: 'https://cdn.example/p.mp4',
  duration: 60,
  transcription: 'SECRET TRANSCRIPT',
  languageAssessment: { assessable: true, languages: [] },
  fraudCheck: {},
  relevance: { onTopic: true, score: 90 },
  analysis: {
    technicalSkills: [{ skill: { _id: 'a1', name: 'Excel' }, score: 70 }],
    professionalSkills: [],
    softSkills: [{ skill: { _id: 'a2', name: 'Empathy' }, score: 60 }],
    industries: [{ industry: { _id: 'a3', name: 'Telecom' }, score: 80 }],
    activities: [],
    spokenLanguages: [
      { language: { _id: 'a4', name: 'English' }, level: 'C1', score: 85 },
      { languageName: 'Wolof', level: 'B1', score: 50 },
    ],
    summary: { en: 'ok', fr: 'ok' },
  },
});

const deps = (overrides = {}) => ({
  videoAnalysisService: {
    analyzeExperienceVideo: jest.fn().mockResolvedValue(pipelineResult()),
    deleteUploadedVideo: jest.fn().mockResolvedValue(true),
  },
  profileRepository: {
    resolveAgentIdentity: jest.fn().mockResolvedValue({ _id: 'agentA', userId: 'userA', presentationVideoUrl: null }),
    getReferencePhotoUrl: jest.fn().mockResolvedValue(null),
    savePresentationVideoAnalysis: jest.fn().mockResolvedValue({ saved: true, insightsApplied: true }),
  },
  profileId: 'agentA',
  requesterId: 'userA',
  authVerified: true,
  file,
  logger,
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('runPresentationAnalysis', () => {
  test('analyzes without experience context, persists and returns detected items', async () => {
    const d = deps();
    const { status, body } = await runPresentationAnalysis(d);
    expect(status).toBe(200);
    expect(d.videoAnalysisService.analyzeExperienceVideo.mock.calls[0][2].mode).toBe('presentation');
    expect(d.videoAnalysisService.analyzeExperienceVideo.mock.calls[0][2].title).toBeUndefined();
    expect(d.profileRepository.savePresentationVideoAnalysis).toHaveBeenCalledTimes(1);
    expect(body.data.saved).toBe(true);
    expect(body.data.insightsApplied).toBe(true);
    expect(body.data.detected.technicalSkills[0].name).toBe('Excel');
    expect(body.data.detected.softSkills[0].name).toBe('Empathy');
    expect(body.data.detected.industries[0].name).toBe('Telecom');
    expect(body.data.detected.languages.map((l) => l.name)).toEqual(['English', 'Wolof']);
    expect(body.data.detected.isEmpty).toBe(false);
    // Response limited to what the front consumes: no transcript, no full analysis.
    expect(Object.keys(body.data).sort()).toEqual(['detected', 'insightsApplied', 'relevance', 'saved', 'summary']);
    expect(JSON.stringify(body)).not.toContain('SECRET TRANSCRIPT');
  });

  describe('authorization (before any external call)', () => {
    const expectNothingCalled = (d) => {
      expect(d.videoAnalysisService.analyzeExperienceVideo).not.toHaveBeenCalled();
      expect(d.videoAnalysisService.deleteUploadedVideo).not.toHaveBeenCalled();
      expect(d.profileRepository.savePresentationVideoAnalysis).not.toHaveBeenCalled();
      expect(d.profileRepository.getReferencePhotoUrl).not.toHaveBeenCalled();
    };

    test("token of profile A on profile B → 403, nothing written, no OpenAI/Cloudinary call", async () => {
      const d = deps({ requesterId: 'userA' });
      d.profileRepository.resolveAgentIdentity.mockResolvedValue({ _id: 'agentB', userId: 'userB' });
      const { status, body } = await runPresentationAnalysis(d);
      expect(status).toBe(403);
      expect(body.code).toBe('FORBIDDEN');
      expectNothingCalled(d);
    });

    test('identity not proven by a verified token (header fallback) → 401', async () => {
      const d = deps({ authVerified: false });
      const { status } = await runPresentationAnalysis(d);
      expect(status).toBe(401);
      expect(d.profileRepository.resolveAgentIdentity).not.toHaveBeenCalled();
      expectNothingCalled(d);
    });

    test('unknown profile → 404, nothing called', async () => {
      const d = deps();
      d.profileRepository.resolveAgentIdentity.mockResolvedValue(null);
      const { status } = await runPresentationAnalysis(d);
      expect(status).toBe(404);
      expectNothingCalled(d);
    });

    test('owner is matched on userId whether :id was the agent _id or the userId', async () => {
      const d = deps({ profileId: 'userA' });
      const { status } = await runPresentationAnalysis(d);
      expect(status).toBe(200);
      // always persisted by the resolved agent _id
      expect(d.profileRepository.savePresentationVideoAnalysis.mock.calls[0][0]).toBe('agentA');
    });
  });

  describe('single Cloudinary copy', () => {
    test('wizard already has the video → analysis copy not referenced and deleted', async () => {
      const d = deps();
      d.profileRepository.resolveAgentIdentity.mockResolvedValue({
        _id: 'agentA', userId: 'userA', presentationVideoUrl: 'https://cdn.example/wizard.mp4',
      });
      await runPresentationAnalysis(d);
      expect(d.profileRepository.savePresentationVideoAnalysis.mock.calls[0][1].videoUrl).toBeNull();
      expect(d.videoAnalysisService.deleteUploadedVideo).toHaveBeenCalledWith('https://cdn.example/p.mp4');
    });

    test('no wizard video → analysis copy is kept and referenced', async () => {
      const d = deps();
      await runPresentationAnalysis(d);
      expect(d.profileRepository.savePresentationVideoAnalysis.mock.calls[0][1].videoUrl).toBe('https://cdn.example/p.mp4');
      expect(d.videoAnalysisService.deleteUploadedVideo).not.toHaveBeenCalled();
    });

    test('persistence failed (no wizard video) → analysis copy deleted, not orphaned', async () => {
      const d = deps();
      d.profileRepository.savePresentationVideoAnalysis.mockRejectedValue(new Error('x'));
      await runPresentationAnalysis(d);
      expect(d.videoAnalysisService.deleteUploadedVideo).toHaveBeenCalledWith('https://cdn.example/p.mp4');
    });

    test('persistence failed with a wizard video → copy deleted too (never referenced)', async () => {
      const d = deps();
      d.profileRepository.resolveAgentIdentity.mockResolvedValue({ _id: 'agentA', userId: 'userA', presentationVideoUrl: 'https://cdn.example/w.mp4' });
      d.profileRepository.savePresentationVideoAnalysis.mockResolvedValue({ saved: false, insightsApplied: false });
      await runPresentationAnalysis(d);
      expect(d.videoAnalysisService.deleteUploadedVideo).toHaveBeenCalledWith('https://cdn.example/p.mp4');
    });
  });

  test('VIDEO_TOO_SHORT → 400 with code, nothing persisted', async () => {
    const err = Object.assign(new Error('Video is too short'), {
      name: 'VideoValidationError', code: 'VIDEO_TOO_SHORT', details: { duration: 10, minDuration: 30 },
    });
    const d = deps();
    d.videoAnalysisService.analyzeExperienceVideo.mockRejectedValue(err);
    const { status, body } = await runPresentationAnalysis(d);
    expect(status).toBe(400);
    expect(body.code).toBe('VIDEO_TOO_SHORT');
    expect(body.details.minDuration).toBe(30);
    expect(d.profileRepository.savePresentationVideoAnalysis).not.toHaveBeenCalled();
  });

  test('OpenAI failure → 502 ANALYSIS_FAILED, profile untouched, no leak in logs', async () => {
    const d = deps();
    d.videoAnalysisService.analyzeExperienceVideo.mockRejectedValue(new Error('OpenAI 429'));
    const { status, body } = await runPresentationAnalysis(d);
    expect(status).toBe(502);
    expect(body.code).toBe('ANALYSIS_FAILED');
    expect(d.profileRepository.savePresentationVideoAnalysis).not.toHaveBeenCalled();
  });

  test('persistence failure is non-blocking: analysis still returned, saved=false', async () => {
    const d = deps();
    d.profileRepository.savePresentationVideoAnalysis.mockRejectedValue(new Error('mongo down'));
    const { status, body } = await runPresentationAnalysis(d);
    expect(status).toBe(200);
    expect(body.data.saved).toBe(false);
    expect(body.data.detected.technicalSkills).toHaveLength(1);
  });

  test('empty presentation → 200 with empty detected list', async () => {
    const d = deps();
    d.videoAnalysisService.analyzeExperienceVideo.mockResolvedValue({
      ...pipelineResult(),
      transcription: '',
      analysis: { spokenLanguages: [], technicalSkills: [] },
    });
    const { status, body } = await runPresentationAnalysis(d);
    expect(status).toBe(200);
    expect(body.data.detected.isEmpty).toBe(true);
  });

  test('missing file → 400 NO_VIDEO', async () => {
    const { status, body } = await runPresentationAnalysis(deps({ file: undefined }));
    expect(status).toBe(400);
    expect(body.code).toBe('NO_VIDEO');
  });

  test('never logs transcript content', async () => {
    const d = deps();
    d.profileRepository.savePresentationVideoAnalysis.mockRejectedValue(new Error('boom'));
    await runPresentationAnalysis(d);
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain('SECRET TRANSCRIPT');
  });

  test('buildDetected tolerates empty analysis', () => {
    expect(buildDetected(undefined).isEmpty).toBe(true);
  });
});
