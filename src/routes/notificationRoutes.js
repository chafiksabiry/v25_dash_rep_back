const express = require('express');
const notificationController = require('../controllers/NotificationController');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

router.get('/', notificationController.list.bind(notificationController));
router.get('/unread-count', notificationController.unreadCount.bind(notificationController));
router.post('/upsert', notificationController.upsert.bind(notificationController));
router.patch('/mark-all-read', notificationController.markAllRead.bind(notificationController));
router.delete('/', notificationController.clearAll.bind(notificationController));
router.delete('/key/:key', notificationController.removeByKey.bind(notificationController));
router.patch('/:id/read', notificationController.setRead.bind(notificationController));
router.delete('/:id', notificationController.removeOne.bind(notificationController));

module.exports = router;
