const notificationService = require('../services/NotificationService');
const mongoose = require('mongoose');
const Agent = require('../models/Agent');
const logger = require('../utils/logger');

const isServiceIdentity = (tokenId) =>
  String(process.env.NOTIFICATION_SERVICE_USER_IDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .includes(String(tokenId));

/**
 * Resolve the rep whose notifications the caller may access, from the VERIFIED
 * token identity only. x-agent-id / x-user-id are never trusted on their own:
 * they are honoured only when they name the token's own userId or an agent
 * owned by that user (the notifications may be keyed by either id).
 * Sends the 401/403 response itself and returns null when access is refused.
 */
async function getRepId(req, res, { allowService = false } = {}) {
  const tokenId = req.user?.userId || req.user?.id;
  if (!tokenId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return null;
  }

  // Explicit, authenticated path for other services that create notifications for a
  // rep (POST /upsert only): a VERIFIED token whose userId is listed in
  // NOTIFICATION_SERVICE_USER_IDS (comma-separated) may name the target rep through
  // x-agent-id / x-user-id or body.repId. Empty by default: nobody has this power.
  if (allowService && req.authVerified && isServiceIdentity(tokenId)) {
    const target = req.headers['x-agent-id'] || req.headers['x-user-id'] || req.body?.repId;
    if (target) {
      if (!mongoose.isValidObjectId(target)) {
        res.status(400).json({ success: false, message: 'Invalid repId' });
        return null;
      }
      logger.info('Notification created on behalf of a rep by an allow-listed service identity');
      return String(target);
    }
  }

  // Legacy header-only identification (ALLOW_HEADER_AUTH): req.user already is the header.
  if (!req.authVerified) return String(tokenId);

  const claimed = req.headers['x-agent-id'] || req.headers['x-user-id'];
  if (!claimed || String(claimed) === String(tokenId)) return String(tokenId);

  try {
    if (mongoose.isValidObjectId(claimed) && mongoose.isValidObjectId(tokenId)) {
      const owned = await Agent.exists({ _id: claimed, userId: tokenId });
      if (owned) return String(claimed);
    }
  } catch (error) {
    logger.error(`Notification identity check failed: ${error.message}`);
  }
  logger.warn('Notification access refused: identity header does not belong to the token');
  res.status(403).json({ success: false, message: 'Forbidden' });
  return null;
}

class NotificationController {
  async list(req, res) {
    try {
      const repId = await getRepId(req, res);
      if (!repId) return;

      const unreadOnly = String(req.query.unreadOnly || '') === 'true';
      const rows = await notificationService.listByRep(repId, { unreadOnly });
      res.json({
        success: true,
        data: rows.map((r) => notificationService.serialize(r)),
        unreadCount: rows.filter((r) => !r.read).length,
      });
    } catch (error) {
      logger.error('NotificationController.list', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async unreadCount(req, res) {
    try {
      const repId = await getRepId(req, res);
      if (!repId) return;
      const count = await notificationService.unreadCount(repId);
      res.json({ success: true, count });
    } catch (error) {
      logger.error('NotificationController.unreadCount', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async upsert(req, res) {
    try {
      const repId = await getRepId(req, res, { allowService: true });
      if (!repId) return;

      const { notification, created } = await notificationService.upsert(repId, req.body || {});
      res.status(created ? 201 : 200).json({
        success: true,
        created,
        data: notificationService.serialize(notification),
      });
    } catch (error) {
      logger.error('NotificationController.upsert', error);
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async setRead(req, res) {
    try {
      const repId = await getRepId(req, res);
      if (!repId) return;

      const read = req.body?.read !== false;
      const doc = await notificationService.setRead(repId, req.params.id, read);
      if (!doc) return res.status(404).json({ success: false, message: 'Notification not found' });
      res.json({ success: true, data: notificationService.serialize(doc) });
    } catch (error) {
      logger.error('NotificationController.setRead', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async markAllRead(req, res) {
    try {
      const repId = await getRepId(req, res);
      if (!repId) return;
      const result = await notificationService.markAllRead(repId);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('NotificationController.markAllRead', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async removeOne(req, res) {
    try {
      const repId = await getRepId(req, res);
      if (!repId) return;
      const doc = await notificationService.removeOne(repId, req.params.id);
      if (!doc) return res.status(404).json({ success: false, message: 'Notification not found' });
      res.json({ success: true, data: notificationService.serialize(doc) });
    } catch (error) {
      logger.error('NotificationController.removeOne', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async removeByKey(req, res) {
    try {
      const repId = await getRepId(req, res);
      if (!repId) return;
      const key = String(req.body?.notificationKey || req.params.key || '').trim();
      if (!key) return res.status(400).json({ success: false, message: 'notificationKey required' });
      const doc = await notificationService.removeByKey(repId, key);
      res.json({ success: true, deleted: !!doc });
    } catch (error) {
      logger.error('NotificationController.removeByKey', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async clearAll(req, res) {
    try {
      const repId = await getRepId(req, res);
      if (!repId) return;
      const result = await notificationService.clearAll(repId);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('NotificationController.clearAll', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new NotificationController();
module.exports.getRepId = getRepId;
