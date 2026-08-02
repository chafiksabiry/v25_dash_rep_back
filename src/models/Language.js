const mongoose = require('mongoose');

const languageSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, lowercase: true },
    iso639_1: { type: String, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    nativeName: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Language || mongoose.model('Language', languageSchema);
