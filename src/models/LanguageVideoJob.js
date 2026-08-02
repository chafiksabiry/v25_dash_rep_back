const mongoose = require('mongoose');

const languageVideoJobSchema = new mongoose.Schema(
  {
    profileId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
      index: true,
    },
    videoPath: { type: String },
    mimetype: { type: String },
    languageContext: {
      languageName: String,
      languageCode: String,
      expectedProficiency: String,
      referencePhotoUrl: String,
    },
    requestBody: {
      languageId: String,
    },
    result: { type: mongoose.Schema.Types.Mixed },
    saved: { type: Boolean, default: false },
    error: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: 'language_video_jobs',
  }
);

languageVideoJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports =
  mongoose.models.LanguageVideoJob ||
  mongoose.model('LanguageVideoJob', languageVideoJobSchema);
