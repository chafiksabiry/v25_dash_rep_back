const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Agent = require('../models/Agent');
const { getJwtSecret } = require('../utils/jwtSecret');
const logger = require('../utils/logger');

/** @type {import('ws').WebSocketServer | null} */
let wss = null;

const AUTH_TIMEOUT_MS = 5000;
// Messages are tiny ({type:'auth',token}); ws would otherwise accept 100 MiB per message.
const MAX_PAYLOAD_BYTES = 8 * 1024;

/** Browsers cannot set an Authorization header on a WebSocket, so the token is
 *  sent in a first `{ type: "auth", token }` message (never in the URL, which gets logged).
 *  Non-browser clients may send `Authorization: Bearer …` on the upgrade instead. */
const tokenFromUpgrade = (req) => {
  const header = req?.headers?.authorization;
  return header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
};

/**
 * Verify a JWT and derive the rep ids the socket may receive: the token's userId
 * and the agent ids owned by that user (notifications may be keyed by either).
 * Returns a Set of strings, or null when the token is invalid.
 */
async function authenticate(token) {
  let payload;
  try {
    payload = jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
  const userId = payload?.userId || payload?.id;
  if (!userId) return null;

  const repIds = new Set([String(userId)]);
  try {
    if (mongoose.isValidObjectId(userId)) {
      const agents = await Agent.find({ userId }, { _id: 1 }).lean();
      agents.forEach((a) => repIds.add(String(a._id)));
    }
  } catch (error) {
    logger.warn(`[Notification WS] could not load agents for identity: ${error.message}`);
  }
  return repIds;
}

/**
 * Attach a WebSocket server at `/notification-updates`.
 * A client receives nothing until it is authenticated. Its rep ids come from the
 * verified token ONLY: any repId sent by the client is ignored.
 */
function setupNotificationWebSocket(server) {
  wss = new WebSocketServer({
    server,
    path: '/notification-updates',
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  wss.on('connection', (ws, req) => {
    ws.repIds = null; // null = not authenticated: never receives broadcasts

    // Without an 'error' listener a protocol error (e.g. oversized message) is thrown as an
    // uncaught exception, which would take the whole server down. ws closes the socket itself.
    ws.on('error', (error) => {
      logger.warn(`[Notification WS] socket error: ${error.code || error.message}`);
    });

    const authenticateWith = async (token) => {
      const repIds = token ? await authenticate(token) : null;
      if (!repIds) {
        try {
          ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHENTICATED' }));
        } catch {
          /* ignore */
        }
        ws.close(4401, 'unauthenticated');
        return;
      }
      ws.repIds = repIds;
      ws.primaryRepId = [...repIds][0]; // the token's userId (inserted first)
      try {
        ws.send(JSON.stringify({ type: 'authenticated' }));
      } catch {
        /* ignore */
      }
    };

    const timer = setTimeout(() => {
      if (!ws.repIds) ws.close(4401, 'authentication timeout');
    }, AUTH_TIMEOUT_MS);

    // Kept for client compatibility: existing clients wait for this message before
    // sending anything. It carries no data and does not authenticate the socket.
    try {
      ws.send(JSON.stringify({ type: 'connected', message: 'Ready for notification updates' }));
    } catch {
      /* ignore */
    }

    const headerToken = tokenFromUpgrade(req);
    if (headerToken) authenticateWith(headerToken);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw || ''));
        if (data?.type === 'auth' && !ws.repIds) {
          authenticateWith(typeof data.token === 'string' ? data.token : null);
        }
        // "subscribe": acknowledged only for an authenticated socket, and always with the
        // identity derived from the token. A client-supplied repId is never used.
        if (data?.type === 'subscribe' && ws.repIds) {
          ws.send(JSON.stringify({ type: 'subscribed', repId: ws.primaryRepId }));
        }
      } catch {
        /* ignore malformed */
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      ws.repIds = null;
    });
  });

  logger.info('Notification WebSocket listening on /notification-updates');
}

/**
 * Push a notification ONLY to authenticated clients whose verified identity
 * covers that rep. Unauthenticated / unsubscribed clients receive nothing.
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
    if (client.repIds && client.repIds.has(targetRepId)) {
      try {
        client.send(message);
      } catch {
        /* ignore */
      }
    }
  });
}

/** Test helper / graceful shutdown. */
function closeNotificationWebSocket() {
  if (wss) {
    wss.close();
    wss = null;
  }
}

module.exports = {
  setupNotificationWebSocket,
  broadcastNotificationUpdate,
  closeNotificationWebSocket,
};
