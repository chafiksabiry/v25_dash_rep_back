const mongoose = require('mongoose');
const RepNotification = require('../models/RepNotification');
const logger = require('../utils/logger');

function toObjectId(value) {
  const s = String(value || '').trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

class NotificationService {
  async listByRep(repId, { unreadOnly = false, limit = 100 } = {}) {
    const oid = toObjectId(repId);
    if (!oid) return [];
    const query = { repId: oid };
    if (unreadOnly) query.read = false;
    return RepNotification.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 200))
      .lean();
  }

  async unreadCount(repId) {
    const oid = toObjectId(repId);
    if (!oid) return 0;
    return RepNotification.countDocuments({ repId: oid, read: false });
  }

  async upsert(repId, payload) {
    const oid = toObjectId(repId);
    if (!oid) throw new Error('Invalid repId');

    const notificationKey = String(payload.notificationKey || '').trim();
    if (!notificationKey) throw new Error('notificationKey is required');

    const update = {
      kind: payload.kind || 'general',
      status: payload.status || undefined,
      title: String(payload.title || '').trim(),
      message: String(payload.message || '').trim(),
      actionPath: payload.actionPath ? String(payload.actionPath).trim() : undefined,
      read: payload.read === true,
    };

    const gigOid = toObjectId(payload.gigId);
    if (gigOid) update.gigId = gigOid;
    const journeyOid = toObjectId(payload.journeyId);
    if (journeyOid) update.journeyId = journeyOid;

    const existing = await RepNotification.findOne({ repId: oid, notificationKey }).lean();
    const doc = await RepNotification.findOneAndUpdate(
      { repId: oid, notificationKey },
      {
        $set: update,
        $setOnInsert: { repId: oid, notificationKey },
      },
      { upsert: true, new: true, lean: true }
    );

    return { notification: doc, created: !existing };
  }

  async setRead(repId, notificationId, read) {
    const repOid = toObjectId(repId);
    const notifOid = toObjectId(notificationId);
    if (!repOid || !notifOid) return null;
    return RepNotification.findOneAndUpdate(
      { _id: notifOid, repId: repOid },
      { $set: { read: !!read } },
      { new: true, lean: true }
    );
  }

  async markAllRead(repId) {
    const oid = toObjectId(repId);
    if (!oid) return { modifiedCount: 0 };
    const result = await RepNotification.updateMany(
      { repId: oid, read: false },
      { $set: { read: true } }
    );
    return { modifiedCount: result.modifiedCount || 0 };
  }

  async removeOne(repId, notificationId) {
    const repOid = toObjectId(repId);
    const notifOid = toObjectId(notificationId);
    if (!repOid || !notifOid) return null;
    return RepNotification.findOneAndDelete({ _id: notifOid, repId: repOid }).lean();
  }

  async removeByKey(repId, notificationKey) {
    const repOid = toObjectId(repId);
    const key = String(notificationKey || '').trim();
    if (!repOid || !key) return null;
    return RepNotification.findOneAndDelete({ repId: repOid, notificationKey: key }).lean();
  }

  async clearAll(repId) {
    const oid = toObjectId(repId);
    if (!oid) return { deletedCount: 0 };
    const result = await RepNotification.deleteMany({ repId: oid });
    return { deletedCount: result.deletedCount || 0 };
  }

  serialize(doc) {
    if (!doc) return null;
    return {
      id: String(doc._id),
      notificationKey: doc.notificationKey,
      kind: doc.kind,
      status: doc.status,
      gigId: doc.gigId ? String(doc.gigId) : undefined,
      journeyId: doc.journeyId ? String(doc.journeyId) : undefined,
      title: doc.title,
      message: doc.message,
      actionPath: doc.actionPath,
      read: !!doc.read,
      createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now(),
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : undefined,
    };
  }
}

module.exports = new NotificationService();
