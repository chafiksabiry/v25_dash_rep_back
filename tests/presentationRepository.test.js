jest.mock('../src/models/Agent', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mongoose = require('mongoose');
const Agent = require('../src/models/Agent');
const ProfileRepository = require('../src/repositories/ProfileRepository');

const id = new mongoose.Types.ObjectId();
const payload = {
  videoUrl: 'https://cdn.example/analysis.mp4',
  duration: 61,
  transcription: 't',
  analysis: { technicalSkills: [] },
  languageAssessment: { languages: [] },
};

const run = async (personalInfo) => {
  const repo = new ProfileRepository();
  repo.applyVideoInsights = jest.fn().mockResolvedValue(true);
  Agent.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: id, personalInfo }) });
  Agent.updateOne.mockResolvedValue({ matchedCount: 1 });
  const out = await repo.savePresentationVideoAnalysis(String(id), payload);
  return { out, set: Agent.updateOne.mock.calls[0][1].$set };
};

beforeEach(() => jest.clearAllMocks());

describe('savePresentationVideoAnalysis', () => {
  test('never writes wizard-owned fields (url, publicId, duration); uses analyzedDuration', async () => {
    const { out, set } = await run({ presentationVideo: { url: 'w', publicId: 'p', duration: 99 } });
    expect(out).toEqual({ saved: true, insightsApplied: true });
    const keys = Object.keys(set);
    expect(keys.every((k) => k.startsWith('personalInfo.presentationVideo.'))).toBe(true);
    ['url', 'publicId', 'duration'].forEach((f) =>
      expect(keys).not.toContain(`personalInfo.presentationVideo.${f}`)
    );
    expect(set['personalInfo.presentationVideo.analyzedDuration']).toBe(61);
  });

  test('personalInfo null → parents created, no dot-path through null', async () => {
    const { out, set } = await run(null);
    expect(out.saved).toBe(true);
    expect(Object.keys(set)).toEqual(['personalInfo']);
    expect(set.personalInfo.presentationVideo.analyzedDuration).toBe(61);
  });

  test('presentationVideo null → object initialised as a whole', async () => {
    const { set } = await run({ photo: { url: 'x' }, presentationVideo: null });
    expect(Object.keys(set)).toEqual(['personalInfo.presentationVideo']);
    expect(set['personalInfo.presentationVideo'].analysis).toBeDefined();
  });

  test('presentationVideo missing → initialised', async () => {
    const { set } = await run({ photo: { url: 'x' } });
    expect(Object.keys(set)).toEqual(['personalInfo.presentationVideo']);
  });

  test('legacy string presentationVideo is left untouched; sibling field used', async () => {
    const { set } = await run({ presentationVideo: 'https://cdn.example/legacy.mp4' });
    expect(Object.keys(set)).toEqual(['personalInfo.presentationVideoAnalysis']);
  });

  test('unknown agent → saved:false, nothing written', async () => {
    const repo = new ProfileRepository();
    Agent.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    expect(await repo.savePresentationVideoAnalysis(String(id), payload)).toEqual({ saved: false, insightsApplied: false });
    expect(Agent.updateOne).not.toHaveBeenCalled();
  });
});

describe('resolveAgentIdentity', () => {
  test('matches on _id OR userId', async () => {
    const repo = new ProfileRepository();
    Agent.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: id, userId: 'u', personalInfo: { presentationVideo: { url: 'w' } } }) });
    const out = await repo.resolveAgentIdentity(String(id));
    expect(Agent.findOne.mock.calls[0][0].$or).toHaveLength(2);
    expect(out.presentationVideoUrl).toBe('w');
  });
  test('invalid id → null without querying', async () => {
    const repo = new ProfileRepository();
    expect(await repo.resolveAgentIdentity('not-an-id')).toBeNull();
    expect(Agent.findOne).not.toHaveBeenCalled();
  });
});
