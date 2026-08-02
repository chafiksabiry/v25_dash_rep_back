const fs = require('fs');
const path = require('path');
const os = require('os');
const LanguageVideoJob = require('../models/LanguageVideoJob');
const VideoAnalysisService = require('./VideoAnalysisService');
const ProfileRepository = require('../repositories/ProfileRepository');
const logger = require('../utils/logger');

class LanguageVideoJobService {
  constructor() {
    this._videoAnalysisService = null;
    this.profileRepository = new ProfileRepository();
  }

  get videoAnalysisService() {
    if (!this._videoAnalysisService) {
      this._videoAnalysisService = new VideoAnalysisService();
    }
    return this._videoAnalysisService;
  }

  async createJob({ profileId, videoBuffer, mimetype, languageContext, requestBody = {} }) {
    const ext = mimetype.includes('mp4') ? 'mp4' : 'webm';
    const videoPath = path.join(os.tmpdir(), `lang-job-${Date.now()}-${profileId}.${ext}`);
    fs.writeFileSync(videoPath, videoBuffer);

    return LanguageVideoJob.create({
      profileId: String(profileId),
      status: 'queued',
      videoPath,
      mimetype,
      languageContext,
      requestBody: {
        languageId: String(requestBody.languageId || '').trim(),
      },
    });
  }

  startJob(jobId) {
    setImmediate(() => {
      this.processJob(jobId).catch((err) => {
        logger.error(`Unhandled language video job ${jobId}: ${err.message}`, { err });
      });
    });
  }

  async processJob(jobId) {
    const job = await LanguageVideoJob.findById(jobId);
    if (!job || job.status !== 'queued') return;

    await LanguageVideoJob.updateOne({ _id: jobId }, { status: 'processing' });
    logger.info(`[lang-video-job:${jobId}] processing started for profile ${job.profileId}`);

    try {
      const buffer = fs.readFileSync(job.videoPath);
      const result = await this.videoAnalysisService.analyzeLanguageVideo(
        buffer,
        job.mimetype,
        job.languageContext
      );

      let saved = false;
      if (result.assessment?.assessable && result.assessment?.languageMatch?.matches) {
        try {
          saved = await this.profileRepository.saveLanguageVideoAssessment(
            job.profileId,
            {
              languageName: job.languageContext.languageName,
              languageCode: job.languageContext.languageCode,
              languageId: job.requestBody?.languageId || '',
              expectedProficiency: job.languageContext.expectedProficiency,
            },
            result
          );
          if (saved) {
            logger.info(`[lang-video-job:${jobId}] assessment saved for profile ${job.profileId}`);
          }
        } catch (persistError) {
          logger.error(`[lang-video-job:${jobId}] persist failed: ${persistError.message}`);
        }
      }

      await LanguageVideoJob.updateOne(
        { _id: jobId },
        { status: 'completed', result: { ...result, saved }, saved }
      );
      logger.info(`[lang-video-job:${jobId}] completed`);
    } catch (error) {
      await LanguageVideoJob.updateOne(
        { _id: jobId },
        {
          status: 'failed',
          error: {
            message: error.message,
            name: error.name,
            code: error.code,
            details: error.details || {},
          },
        }
      );
      logger.error(`[lang-video-job:${jobId}] failed: ${error.message}`);
    } finally {
      if (job.videoPath && fs.existsSync(job.videoPath)) {
        try {
          fs.unlinkSync(job.videoPath);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  async getJob(profileId, jobId) {
    return LanguageVideoJob.findOne({ _id: jobId, profileId: String(profileId) });
  }
}

module.exports = new LanguageVideoJobService();
