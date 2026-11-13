jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/models/Agent', () => ({ find: jest.fn() }));

const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Agent = require('../src/models/Agent');
const {
  setupNotificationWebSocket,
  broadcastNotificationUpdate,
  closeNotificationWebSocket,
} = require('../src/websocket/notificationUpdates');

const SECRET = 'ws-test-secret';
const A = String(new mongoose.Types.ObjectId());
const B = String(new mongoose.Types.ObjectId());
const AGENT_A = String(new mongoose.Types.ObjectId());
const tokenFor = (userId) => jwt.sign({ userId }, SECRET);

let server;
let port;
const sockets = [];

const connect = (headers) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/notification-updates`, { headers });
    ws.received = [];
    ws.closeCode = null;
    ws.on('message', (m) => ws.received.push(JSON.parse(String(m))));
    ws.on('close', (code) => { ws.closeCode = code; });
    ws.on('error', reject);
    ws.on('open', () => { sockets.push(ws); resolve(ws); });
  });
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const notifications = (ws) => ws.received.filter((m) => m.type === 'notification');

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  server = http.createServer();
  setupNotificationWebSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(async () => {
  sockets.forEach((s) => s.terminate());
  closeNotificationWebSocket();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  Agent.find.mockReturnValue({ lean: () => Promise.resolve([{ _id: AGENT_A }]) });
});

describe('notification WebSocket', () => {
  test("sends 'connected' on open (existing clients wait for it) without authenticating", async () => {
    const ws = await connect();
    await wait();
    expect(ws.received.map((m) => m.type)).toContain('connected');
    broadcastNotificationUpdate({ repId: A, notification: { id: 'x' } });
    await wait();
    expect(notifications(ws)).toHaveLength(0);
  });

  test('unknown message types are ignored without closing the connection', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'something-else', foo: 1 }));
    ws.send('not json');
    await wait(150);
    expect(ws.closeCode).toBeNull();
  });

  test("authenticated 'subscribe' is acknowledged with the TOKEN identity, never the client's repId", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'auth', token: tokenFor(A) }));
    await wait();
    ws.send(JSON.stringify({ type: 'subscribe', repId: B }));
    await wait();
    const ack = ws.received.find((m) => m.type === 'subscribed');
    expect(ack.repId).toBe(A);
  });

  test('unauthenticated subscribe gets no acknowledgement', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'subscribe', repId: A }));
    await wait();
    expect(ws.received.some((m) => m.type === 'subscribed')).toBe(false);
  });

  test('oversized message is refused (maxPayload), connection closed 1009', async () => {
    const ws = await connect();
    ws.send('x'.repeat(64 * 1024));
    await wait(200);
    expect(ws.closeCode).toBe(1009);
  });

  test('anonymous client receives nothing', async () => {
    const anon = await connect();
    broadcastNotificationUpdate({ repId: A, notification: { id: 1 } });
    await wait();
    expect(notifications(anon)).toHaveLength(0);
  });

  test('anonymous client sending subscribe + a victim repId still receives nothing', async () => {
    const anon = await connect();
    anon.send(JSON.stringify({ type: 'subscribe', repId: A }));
    await wait();
    broadcastNotificationUpdate({ repId: A, notification: { id: 2 } });
    await wait();
    expect(notifications(anon)).toHaveLength(0);
  });

  test('A receives A, not B', async () => {
    const wsA = await connect();
    wsA.send(JSON.stringify({ type: 'auth', token: tokenFor(A) }));
    await wait();
    expect(wsA.received.some((m) => m.type === 'authenticated')).toBe(true);
    broadcastNotificationUpdate({ repId: A, notification: { id: 'for-A' } });
    broadcastNotificationUpdate({ repId: B, notification: { id: 'for-B' } });
    await wait();
    expect(notifications(wsA).map((m) => m.notification.id)).toEqual(['for-A']);
  });

  test("authenticated A cannot subscribe to B by sending B's repId", async () => {
    const wsA = await connect();
    wsA.send(JSON.stringify({ type: 'auth', token: tokenFor(A) }));
    await wait();
    wsA.send(JSON.stringify({ type: 'subscribe', repId: B }));
    await wait();
    broadcastNotificationUpdate({ repId: B, notification: { id: 'for-B' } });
    await wait();
    expect(notifications(wsA)).toHaveLength(0);
  });

  test("A also receives notifications keyed by one of A's agent ids", async () => {
    const wsA = await connect();
    wsA.send(JSON.stringify({ type: 'auth', token: tokenFor(A) }));
    await wait();
    broadcastNotificationUpdate({ repId: AGENT_A, notification: { id: 'agent-key' } });
    await wait();
    expect(notifications(wsA)).toHaveLength(1);
  });

  test('invalid token → rejected and closed', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'auth', token: jwt.sign({ userId: A }, 'wrong-secret') }));
    await wait(150);
    expect(ws.closeCode).toBe(4401);
    broadcastNotificationUpdate({ repId: A, notification: { id: 3 } });
    await wait();
    expect(notifications(ws)).toHaveLength(0);
  });

  test('Authorization header on upgrade authenticates non-browser clients', async () => {
    const ws = await connect({ Authorization: `Bearer ${tokenFor(A)}` });
    await wait();
    broadcastNotificationUpdate({ repId: A, notification: { id: 'hdr' } });
    await wait();
    expect(notifications(ws)).toHaveLength(1);
  });

  test('token in the query string is NOT accepted', async () => {
    const ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/notification-updates?token=${tokenFor(A)}`);
      s.received = [];
      s.on('message', (m) => s.received.push(JSON.parse(String(m))));
      s.on('open', () => { sockets.push(s); resolve(s); });
      s.on('error', reject);
    });
    await wait();
    broadcastNotificationUpdate({ repId: A, notification: { id: 'q' } });
    await wait();
    expect(ws.received.filter((m) => m.type === 'notification')).toHaveLength(0);
  });
});
