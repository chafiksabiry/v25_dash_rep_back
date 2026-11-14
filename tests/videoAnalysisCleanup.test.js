jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), writeFileSync: jest.fn(), existsSync: jest.fn().mockReturnValue(false), unlinkSync: jest.fn() }));

const VideoAnalysisService = require('../src/services/VideoAnalysisService');

const make = ({ duration = 60, transcribeError = null } = {}) => {
  const svc = new VideoAnalysisService();
  svc._ensureInitialized = jest.fn();
  svc.vocabularyService = { getVocabulary: jest.fn().mockResolvedValue({}) };
  svc.uploadToCloudinary = jest.fn().mockResolvedValue({ url: 'https://cdn.example/a.mp4', publicId: 'a', duration });
  svc.buildAudioUrl = jest.fn().mockReturnValue('https://cdn.example/a.mp3');
  svc.downloadToTemp = jest.fn().mockRejectedValue(transcribeError || new Error('audio failed'));
  svc.deleteUploadedVideo = jest.fn().mockResolvedValue(true);
  return svc;
};
const video = Buffer.from('x');

describe('orphan Cloudinary copy cleanup (presentation mode)', () => {
  test('video too short after upload → copy deleted, VIDEO_TOO_SHORT thrown', async () => {
    const svc = make({ duration: 5 });
    await expect(svc.analyzeExperienceVideo(video, 'video/webm', { mode: 'presentation' })).rejects.toMatchObject({ code: 'VIDEO_TOO_SHORT' });
    expect(svc.deleteUploadedVideo).toHaveBeenCalledWith('https://cdn.example/a.mp4');
  });

  test('pipeline failure after upload → copy deleted, original error rethrown', async () => {
    const svc = make();
    await expect(svc.analyzeExperienceVideo(video, 'video/webm', { mode: 'presentation' })).rejects.toThrow('audio failed');
    expect(svc.deleteUploadedVideo).toHaveBeenCalledTimes(1);
  });

  test('upload itself fails → nothing to delete', async () => {
    const svc = make();
    svc.uploadToCloudinary.mockRejectedValue(new Error('upload failed'));
    await expect(svc.analyzeExperienceVideo(video, 'video/webm', { mode: 'presentation' })).rejects.toThrow('upload failed');
    expect(svc.deleteUploadedVideo).not.toHaveBeenCalled();
  });

  test('experience mode keeps its existing behaviour (no deletion)', async () => {
    const svc = make();
    await expect(svc.analyzeExperienceVideo(video, 'video/webm', { title: 't' })).rejects.toThrow('audio failed');
    expect(svc.deleteUploadedVideo).not.toHaveBeenCalled();
  });
});
