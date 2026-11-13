const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');

/** @type {import('ws').WebSocketServer | null} */
let wss = null;

/**
 * Attach a WebSocket server at `/notification-updates`.
 * Clients send `{ type: "subscribe", repId }` so broadcasts can be filtered.
 */
function setupNotificationWebSocket(server) {
  wss = new WebSocketServer({
    server,
    path: '/notification-updates',
  });

  wss.on('connection', (ws) => {
    ws.repId = null;

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw || ''));
        if (data?.type === 'subscribe' && data.repId) {
          ws.repId = String(data.repId).trim();
          ws.send(JSON.stringify({ type: 'subscribed', repId: ws.repId }));
        }
      } catch {
        /* ignore malformed */
      }
    });

    ws.on('close', () => {
      ws.repId = null;
    });

    try {
      ws.send(JSON.stringify({ type: 'connected', message: 'Ready for notification updates' }));
    } catch {
      /* ignore */
    }
  });

  logger.info('Notification WebSocket listening on /notification-updates');
}

/**
 * Push a newly created notification to subscribed clients for that rep.
 * @param {{ type?: string, repId: string, notification: object, created?: boolean }} data
 */
function broadcastNotificationUpdate(data) {
  if (!wss) {
    logger.warn('[Notification WS] WebSocket server not initialized');
    return;
  }

  const targetRepId = String(data?.repId || '').trim();
  if (!targetRepId) return;

  const message = JSON.stringify({
    type: data.type || 'notification',
    repId: targetRepId,
    created: data.created !== false,
    notification: data.notification,
  });

  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    // Deliver to subscribed clients for this rep, or to clients that have not
    // subscribed yet (they filter by repId on the client side — same as enrollment WS).
    if (!client.repId || client.repId === targetRepId) {
      try {
        client.send(message);
      } catch {
        /* ignore */
      }
    }
  });
}

module.exports = {
  setupNotificationWebSocket,
  broadcastNotificationUpdate,
};
