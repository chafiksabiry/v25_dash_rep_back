const mongoose = require('mongoose');

// Language Assessment Results Schema
const languageAssessmentResultsSchema = new mongoose.Schema({
  completeness: {
    score: { type: Number, min: 0, max: 100 },
    feedback: String
  },
  fluency: {
    score: { type: Number, min: 0, max: 100 },
    feedback: String
  },
  proficiency: {
    score: { type: Number, min: 0, max: 100 },
    feedback: String
  },
  overall: {
    score: { type: Number, min: 0, max: 100 },
    strengths: String,
    areasForImprovement: String
  },
  completedAt: { type: Date, default: Date.now }
}, { _id: false });

// Contact Center Assessment Schema
const contactCenterAssessmentSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    enum: ['Communication', 'Problem Solving', 'Customer Service']
  },
  skill: {
    type: String,
    required: true
  },
  score: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  strengths: [{
    type: String,
    required: true
  }],
  improvements: [{
    type: String,
    required: true
  }],
  feedback: {
    type: String,
    required: true
  },
  tips: [{
    type: String,
    required: true
  }],
  keyMetrics: {
    professionalism: {
      type: Number,
      required: true,
      min: 0,
      max: 10
    },
    effectiveness: {
      type: Number,
      required: true,
      min: 0,
      max: 10
    },
    customerFocus: {
      type: Number,
      required: true,
      min: 0,
      max: 10
    }
  },
  completedAt: {
    type: Date,
    default: Date.now
  }
});

const languageSchema = new mongoose.Schema({
  language: { type: String, required: true },
  proficiency: { type: String, required: true },
  assessmentResults: languageAssessmentResultsSchema
});

const skillSchema = new mongoose.Schema({
  skill: { type: String, required: true },
  level: { type: Number, required: true },
  details: String
});

const achievementSchema = new mongoose.Schema({
  description: { type: String, required: true },
  impact: { type: String },
  context: { type: String },
  skills: [String]
});

const experienceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  company: { type: String, required: true },
  startDate: { 
    type: Date, 
    required: true,
    validate: {
      validator: function(value) {
        return !isNaN(new Date(value).getTime());
      },
      message: props => `${props.value} is not a valid date!`
    }
  },
  endDate: {
    type: mongoose.Schema.Types.Mixed,
    validate: {
      validator: function(value) {
        if (value === 'present') return true;
        if (!value) return true;
        return !isNaN(new Date(value).getTime());
      },
      message: props => `${props.value} must be either a valid date or 'present'!`
    }
  },
  responsibilities: [{ type: String }],
  achievements: [{ type: String }]
});

const contactCenterSkillSchema = new mongoose.Schema({
  skill: { 
    type: String, 
    required: true 
  },
  category: {
    type: String,
    required: true,
    enum: ['Communication', 'Problem Solving', 'Customer Service']
  },
  proficiency: {
    type: String,
    required: true,
    enum: ['Expert', 'Advanced', 'Intermediate', 'Basic', 'Novice']
  },
  assessmentResults: {
    score: {
      type: Number,
      required: true,
      min: 0,
      max: 100
    },
    strengths: [{
      type: String,
      required: true
    }],
    improvements: [{
      type: String,
      required: true
    }],
    feedback: {
      type: String,
      required: true
    },
    tips: [{
      type: String,
      required: true
    }],
    keyMetrics: {
      professionalism: {
        type: Number,
        required: true,
        min: 0,
        max: 100
      },
      effectiveness: {
        type: Number,
        required: true,
        min: 0,
        max: 100
      },
      customerFocus: {
        type: Number,
        required: true,
        min: 0,
        max: 100
      }
    },
    completedAt: {
      type: Date,
      default: Date.now
    }
  }
}, { _id: false });

const profileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['draft', 'in_progress', 'completed'],
    default: 'draft'
  },
  completionSteps: {
    basicInfo: { type: Boolean, default: false },
    experience: { type: Boolean, default: false },
    skills: { type: Boolean, default: false },
    languages: { type: Boolean, default: false },
    assessment: { type: Boolean, default: false }
  },
  availability: {
    days: [{ type: String }],
    hours: {
      start: { type: String },
      end: { type: String }
    },
    timeZones: [{ type: String }],
    flexibility: [{ type: String }]
  },
  personalInfo: {
    name: String,
    location: String,
    email: String,
    phone: String,
    languages: [languageSchema]
  },
  professionalSummary: {
    yearsOfExperience: String,
    currentRole: String,
    industries: [String],
    keyExpertise: [String],
    notableCompanies: [String],
    profileDescription: {
      type: String,
      trim: true,
      default: ''
    }
  },
  skills: {
    technical: [skillSchema],
    professional: [skillSchema],
    soft: [skillSchema],
    contactCenter: [contactCenterSkillSchema]
  },
  achievements: [achievementSchema],
  experience: [experienceSchema],
  lastUpdated: { type: Date, default: Date.now }
}, { timestamps: true });

// Update lastUpdated timestamp on save and handle experience dates
profileSchema.pre('save', function (next) {
  // Update lastUpdated
  this.lastUpdated = new Date();

  // Handle experience dates
  if (this.experience && Array.isArray(this.experience)) {
    this.experience.forEach(exp => {
      // Handle startDate - convert any string (including ISO strings) to Date
      if (exp.startDate && !(exp.startDate instanceof Date)) {
        try {
          exp.startDate = new Date(exp.startDate);
          if (isNaN(exp.startDate.getTime())) {
            throw new Error(`Invalid startDate format: ${exp.startDate}`);
          }
        } catch (error) {
          console.error('Error converting startDate:', error);
          throw new Error(`Invalid startDate format: ${exp.startDate}`);
        }
      }

      // Handle endDate - convert any string to Date except 'present'
      if (exp.endDate && exp.endDate !== 'present' && !(exp.endDate instanceof Date)) {
        try {
          exp.endDate = new Date(exp.endDate);
          if (isNaN(exp.endDate.getTime())) {
            throw new Error(`Invalid endDate format: ${exp.endDate}`);
          }
        } catch (error) {
          console.error('Error converting endDate:', error);
          throw new Error(`Invalid endDate format: ${exp.endDate}`);
        }
      }
    });
  }

  next();
});

// Add pre-update middleware for experience dates
profileSchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate();
  
  // If we're updating experience array
  if (update.experience && Array.isArray(update.experience)) {
    update.experience = update.experience.map(exp => {
      // Handle startDate
      if (exp.startDate && !(exp.startDate instanceof Date)) {
        const startDate = new Date(exp.startDate);
        if (isNaN(startDate.getTime())) {
          throw new Error(`Invalid startDate format for experience: ${exp.title}`);
        }
        exp.startDate = startDate;
      }

      // Handle endDate
      if (exp.endDate && exp.endDate !== 'present' && !(exp.endDate instanceof Date)) {
        const endDate = new Date(exp.endDate);
        if (isNaN(endDate.getTime())) {
          throw new Error(`Invalid endDate format for experience: ${exp.title}`);
        }
        exp.endDate = endDate;
      }

      return exp;
    });
  }

  // Update lastUpdated timestamp
  update.lastUpdated = new Date();
  
  next();
});

// Method to update completion status
profileSchema.methods.updateCompletionStatus = function () {
  const steps = this.completionSteps;

  // Update individual step completion status
  steps.basicInfo = !!(this.personalInfo.name && this.personalInfo.email);
  steps.experience = this.experience.length > 0;
  steps.skills = !!(this.skills.technical.length || this.skills.professional.length || 
                    this.skills.soft.length || this.skills.contactCenter.length);
  steps.languages = this.personalInfo.languages.length > 0;
  steps.assessment = this.personalInfo.languages.some(lang => lang.assessmentResults) ||
    this.skills.contactCenter.some(skill => skill.assessmentResults);

  // Update overall status
  const completedSteps = Object.values(steps).filter(Boolean).length;
  if (completedSteps === 0) {
    this.status = 'draft';
  } else if (completedSteps === Object.keys(steps).length) {
    this.status = 'completed';
  } else {
    this.status = 'in_progress';
  }
};

module.exports = mongoose.model('Profile', profileSchema);