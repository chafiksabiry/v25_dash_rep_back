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
  return { out, set: Agent.updateOne.mock.calls[0][1].$set, filter: Agent.updateOne.mock.calls[0][0] };
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

describe('compare-and-set against concurrent wizard writes', () => {
  const setup = (personalInfo, matched) => {
    const repo = new ProfileRepository();
    repo.applyVideoInsights = jest.fn().mockResolvedValue(true);
    Agent.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: id, personalInfo }) });
    matched.forEach((m) => Agent.updateOne.mockResolvedValueOnce({ matchedCount: m }));
    return repo;
  };

  test('presentationVideo null/missing: write only if still null (guard in the filter)', async () => {
    const { filter } = await run({ presentationVideo: null });
    expect(filter['personalInfo.presentationVideo']).toBeNull();
    Agent.updateOne.mockClear();
    expect((await run(null)).filter.personalInfo).toBeNull();
  });

  test('object: write only if still an object', async () => {
    const { filter } = await run({ presentationVideo: { url: 'w' } });
    expect(filter['personalInfo.presentationVideo']).toEqual({ $type: 'object' });
  });

  test('string: write only if still a string', async () => {
    const { filter } = await run({ presentationVideo: 'legacy' });
    expect(filter['personalInfo.presentationVideo']).toEqual({ $type: 'string' });
  });

  test('wizard wrote in between (no match) → re-read and retry, then saved', async () => {
    const repo = setup({ presentationVideo: null }, [0, 1]);
    const out = await repo.savePresentationVideoAnalysis(String(id), payload);
    expect(Agent.findOne).toHaveBeenCalledTimes(2);
    expect(Agent.updateOne).toHaveBeenCalledTimes(2);
    expect(out.saved).toBe(true);
  });

  test('conflict persists → saved:false, nothing forced, insights not applied', async () => {
    const repo = setup({ presentationVideo: null }, [0, 0, 0]);
    const out = await repo.savePresentationVideoAnalysis(String(id), payload);
    expect(out).toEqual({ saved: false, insightsApplied: false });
    expect(Agent.updateOne).toHaveBeenCalledTimes(3);
    expect(repo.applyVideoInsights).not.toHaveBeenCalled();
  });
});

describe('staleness marker', () => {
  test('analyzedForPublicId (wizard publicId at request time) is stored, never the wizard publicId field', async () => {
    const repo = new ProfileRepository();
    repo.applyVideoInsights = jest.fn().mockResolvedValue(true);
    Agent.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: id, personalInfo: { presentationVideo: { url: 'w', publicId: 'pid-2' } } }) });
    Agent.updateOne.mockResolvedValue({ matchedCount: 1 });
    await repo.savePresentationVideoAnalysis(String(id), { ...payload, analyzedForPublicId: 'pid-1' });
    const set = Agent.updateOne.mock.calls[0][1].$set;
    expect(set['personalInfo.presentationVideo.analyzedForPublicId']).toBe('pid-1');
    expect(Object.keys(set)).not.toContain('personalInfo.presentationVideo.publicId');
  });

  test('resolveAgentIdentity exposes the wizard publicId', async () => {
    const repo = new ProfileRepository();
    Agent.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: id, userId: 'u', personalInfo: { presentationVideo: { url: 'w', publicId: 'pid-1' } } }) });
    expect((await repo.resolveAgentIdentity(String(id))).presentationVideoPublicId).toBe('pid-1');
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
