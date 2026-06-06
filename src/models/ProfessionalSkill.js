const mongoose = require('mongoose');

const professionalSkillSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.ProfessionalSkill || mongoose.model('ProfessionalSkill', professionalSkillSchema);
