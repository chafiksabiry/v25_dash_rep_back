const mongoose = require('mongoose');

// Minimal Agent model — maps to the shared `agents` collection (rep wizard profiles).
const experienceSchema = new mongoose.Schema(
  {
    title: String,
    company: String,
    videoUrl: String,
    videoTranscription: String,
    videoAnalysis: { type: mongoose.Schema.Types.Mixed },
    videoAnalyzedAt: Date,
  },
  { strict: false }
);

const agentSchema = new mongoose.Schema(
  {
    userId: mongoose.Schema.Types.ObjectId,
    experience: [experienceSchema],
  },
  { strict: false, collection: 'agents' }
);

module.exports = mongoose.models.Agent || mongoose.model('Agent', agentSchema);
