const mongoose = require('mongoose');

const repNotificationSchema = new mongoose.Schema(
  {
    repId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    /** Clé stable pour upsert (ex: script-required-{journeyId}). */
    notificationKey: {
      type: String,
      required: true,
      trim: true,
    },
    kind: {
      type: String,
      enum: ['enrollment', 'script_required', 'certification_required', 'general'],
      default: 'general',
    },
    status: { type: String, trim: true },
    gigId: { type: mongoose.Schema.Types.ObjectId },
    journeyId: { type: mongoose.Schema.Types.ObjectId },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    actionPath: { type: String, trim: true },
    read: { type: Boolean, default: false },
    /** Rep explicitly dismissed this notification — hidden from the list and
     *  never recreated by a backfill sync (e.g. the still-enrolled-gigs
     *  poll), unlike a hard delete which that same poll would just undo. */
    dismissed: { type: Boolean, default: false },
    dismissedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'rep_notifications',
  }
);

repNotificationSchema.index({ repId: 1, notificationKey: 1 }, { unique: true });
repNotificationSchema.index({ repId: 1, read: 1, createdAt: -1 });

module.exports =
  mongoose.models.RepNotification ||
  mongoose.model('RepNotification', repNotificationSchema);
