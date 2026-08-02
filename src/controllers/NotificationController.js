const notificationService = require('../services/NotificationService');
const logger = require('../utils/logger');

function resolveRepId(req) {
  return (
    req.headers['x-agent-id'] ||
    req.headers['x-user-id'] ||
    req.user?.userId ||
    req.user?.id ||
    req.body?.repId ||
    req.params?.repId ||
    null
  );
}

class NotificationController {
  async list(req, res) {
    try {
      const repId = resolveRepId(req);
      if (!repId) return res.status(401).json({ success: false, message: 'Unauthorized' });

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
      const repId = resolveRepId(req);
      if (!repId) return res.status(401).json({ success: false, message: 'Unauthorized' });
      const count = await notificationService.unreadCount(repId);
      res.json({ success: true, count });
    } catch (error) {
      logger.error('NotificationController.unreadCount', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async upsert(req, res) {
    try {
      const repId = resolveRepId(req);
      if (!repId) return res.status(401).json({ success: false, message: 'Unauthorized' });

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
      const repId = resolveRepId(req);
      if (!repId) return res.status(401).json({ success: false, message: 'Unauthorized' });

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
      const repId = resolveRepId(req);
      if (!repId) return res.status(401).json({ success: false, message: 'Unauthorized' });
      const result = await notificationService.markAllRead(repId);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('NotificationController.markAllRead', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async removeOne(req, res) {
    try {
      const repId = resolveRepId(req);
      if (!repId) return res.status(401).json({ success: false, message: 'Unauthorized' });
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
      const repId = resolveRepId(req);
      if (!repId) return res.status(401).json({ success: false, message: 'Unauthorized' });
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
      const repId = resolveRepId(req);
      if (!repId) return res.status(401).json({ success: false, message: 'Unauthorized' });
      const result = await notificationService.clearAll(repId);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('NotificationController.clearAll', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new NotificationController();
