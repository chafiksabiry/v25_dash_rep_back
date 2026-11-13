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
  videoAnalysisService: { analyzeExperienceVideo: jest.fn().mockResolvedValue(pipelineResult()) },
  profileRepository: {
    getReferencePhotoUrl: jest.fn().mockResolvedValue(null),
    savePresentationVideoAnalysis: jest.fn().mockResolvedValue({ saved: true, insightsApplied: true }),
  },
  profileId: 'p1',
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
