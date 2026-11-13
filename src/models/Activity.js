const mongoose = require('mongoose');

const i18nStringSchema = new mongoose.Schema(
  {
    en: { type: String, trim: true, default: '' },
    fr: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const activitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true, default: '' },
    category: { type: String },
    name_i18n: { type: i18nStringSchema, default: () => ({ en: '', fr: '' }) },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Activity || mongoose.model('Activity', activitySchema);
