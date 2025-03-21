const mongoose = require('mongoose');

const ProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  location: { type: String, required: true },
  role: { type: String, required: true },
  experience: { type: Number, default: 0 },
  rating: { type: Number, default: 0 },
  totalReviews: { type: Number, default: 0 },
  skills: [{ type: String }],
  points: { type: Number, default: 0 },
  achievements: [{
    title: String,
    description: String,
    progress: Number,
    total: Number
  }],
  performance: {
    customerSatisfaction: { type: Number, default: 0 },
    taskCompletionRate: { type: Number, default: 0 },
    onTimeDelivery: { type: Number, default: 0 }
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Profile', ProfileSchema); 