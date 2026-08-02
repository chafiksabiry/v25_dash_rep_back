const mongoose = require('mongoose');

const technicalSkillSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.TechnicalSkill || mongoose.model('TechnicalSkill', technicalSkillSchema);
