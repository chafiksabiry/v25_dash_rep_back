jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/models/Agent', () => ({ exists: jest.fn() }));
jest.mock('../src/services/NotificationService', () => ({
  listByRep: jest.fn().mockResolvedValue([]),
  serialize: (x) => x,
}));

const mongoose = require('mongoose');
const Agent = require('../src/models/Agent');
const notificationService = require('../src/services/NotificationService');
const logger = require('../src/utils/logger');
const controller = require('../src/controllers/NotificationController');

const A = String(new mongoose.Types.ObjectId());
const B = String(new mongoose.Types.ObjectId());
const AGENT_OF_A = String(new mongoose.Types.ObjectId());

const mkRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const call = async (req) => {
  const res = mkRes();
  await controller.list({ query: {}, body: {}, params: {}, authVerified: true, ...req }, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  Agent.exists.mockResolvedValue(null);
});

describe('notification identity (IDOR)', () => {
  test('token of A + x-user-id of B → 403, B notifications never read', async () => {
    const res = await call({ user: { userId: A }, headers: { 'x-user-id': B } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(notificationService.listByRep).not.toHaveBeenCalled();
  });

  test('token of A + x-agent-id of an agent NOT owned by A → 403', async () => {
    const res = await call({ user: { userId: A }, headers: { 'x-agent-id': B } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(notificationService.listByRep).not.toHaveBeenCalled();
  });

  test('token of A + x-agent-id of A\'s own agent → allowed with that agent id', async () => {
    Agent.exists.mockResolvedValue({ _id: AGENT_OF_A });
    const res = await call({ user: { userId: A }, headers: { 'x-agent-id': AGENT_OF_A } });
    expect(Agent.exists).toHaveBeenCalledWith({ _id: AGENT_OF_A, userId: A });
    expect(notificationService.listByRep).toHaveBeenCalledWith(AGENT_OF_A, { unreadOnly: false });
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('no header → token identity', async () => {
    await call({ user: { userId: A }, headers: {} });
    expect(notificationService.listByRep).toHaveBeenCalledWith(A, { unreadOnly: false });
  });

  test('header equal to token identity → token identity, no DB lookup', async () => {
    await call({ user: { userId: A }, headers: { 'x-user-id': A } });
    expect(Agent.exists).not.toHaveBeenCalled();
    expect(notificationService.listByRep).toHaveBeenCalledWith(A, { unreadOnly: false });
  });

  test('body/params repId can never override identity', async () => {
    await call({ user: { userId: A }, headers: {}, body: { repId: B }, params: { repId: B } });
    expect(notificationService.listByRep).toHaveBeenCalledWith(A, { unreadOnly: false });
  });

  test('no identity at all → 401', async () => {
    const res = await call({ headers: {} });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(notificationService.listByRep).not.toHaveBeenCalled();
  });

  test('legacy header-only mode (unverified): identity = header-derived req.user', async () => {
    await call({ authVerified: false, user: { userId: B, id: B }, headers: { 'x-user-id': B } });
    expect(notificationService.listByRep).toHaveBeenCalledWith(B, { unreadOnly: false });
  });

  test('refusal is logged without the claimed identity', async () => {
    await call({ user: { userId: A }, headers: { 'x-user-id': B } });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(B);
  });
});
