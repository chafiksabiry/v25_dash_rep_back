jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/models/Agent', () => ({ findOne: jest.fn() }));

const mongoose = require('mongoose');
const Agent = require('../src/models/Agent');
const { requireProfileOwnership, requireVerifiedAuth } = require('../src/middleware/ownership');

const A = String(new mongoose.Types.ObjectId());
const B = String(new mongoose.Types.ObjectId());
const AGENT_A = String(new mongoose.Types.ObjectId());
const AGENT_B = String(new mongoose.Types.ObjectId());

const mkRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const agentLookup = (agent) => Agent.findOne.mockReturnValue({ lean: () => Promise.resolve(agent) });
const run = async (req) => {
  const res = mkRes();
  const next = jest.fn();
  const full = { method: 'POST', baseUrl: '/api/profiles', path: '/x', ...req };
  await requireProfileOwnership(full, res, next);
  return { res, next, req: full };
};

beforeEach(() => jest.clearAllMocks());

describe('requireProfileOwnership', () => {
  test('token A on profile B → 403, route not reached', async () => {
    agentLookup({ _id: AGENT_B, userId: B });
    const { res, next } = await run({ params: { id: AGENT_B }, user: { userId: A }, authVerified: true });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('own profile addressed by agent _id → next', async () => {
    agentLookup({ _id: AGENT_A, userId: A });
    const { next, req } = await run({ params: { id: AGENT_A }, user: { userId: A }, authVerified: true });
    expect(next).toHaveBeenCalled();
    expect(req.ownedAgent._id).toBe(AGENT_A);
  });

  test('own profile addressed by userId → next (lookup covers both ids)', async () => {
    agentLookup({ _id: AGENT_A, userId: A });
    const { next } = await run({ params: { id: A }, user: { userId: A }, authVerified: true });
    expect(Agent.findOne.mock.calls[0][0].$or).toHaveLength(2);
    expect(next).toHaveBeenCalled();
  });

  test('identity not from a verified token (header fallback) → 401, no DB access', async () => {
    const { res, next } = await run({ params: { id: AGENT_A }, user: { userId: A }, authVerified: false });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(Agent.findOne).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('unknown profile → 404; invalid id → 404 without a query', async () => {
    agentLookup(null);
    expect((await run({ params: { id: AGENT_A }, user: { userId: A }, authVerified: true })).res.status).toHaveBeenCalledWith(404);
    Agent.findOne.mockClear();
    expect((await run({ params: { id: 'zzz' }, user: { userId: A }, authVerified: true })).res.status).toHaveBeenCalledWith(404);
    expect(Agent.findOne).not.toHaveBeenCalled();
  });

  test('database error → 500, route not reached', async () => {
    Agent.findOne.mockReturnValue({ lean: () => Promise.reject(new Error('down')) });
    const { res, next } = await run({ params: { id: AGENT_A }, user: { userId: A }, authVerified: true });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireVerifiedAuth', () => {
  test('refuses unverified identity, accepts verified', () => {
    const res = mkRes();
    const next = jest.fn();
    requireVerifiedAuth({ authVerified: false, user: { userId: A } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    requireVerifiedAuth({ authVerified: true, user: { userId: A } }, mkRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('route wiring: ownership runs BEFORE the upload middleware', () => {
  jest.mock('../src/controllers/ProfileController', () => jest.fn().mockImplementation(() => new Proxy({}, { get: () => () => {} })));
  const router = require('../src/routes/profileRoutes');
  const stackOf = (path) => router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post).route.stack.map((h) => h.handle);

  test.each(['/:id/experience/analyze-video', '/:id/language/analyze-video'])('%s', (path) => {
    const handlers = stackOf(path);
    expect(handlers[0]).toBe(requireProfileOwnership);
  });
});

describe('recheck routes wiring (PR #6)', () => {
  test.each(['/:id/identity/recheck', '/:id/language/accent/recheck'])('%s starts with ownership', (path) => {
    const router = require('../src/routes/profileRoutes');
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
    expect(layer.route.stack[0].handle).toBe(requireProfileOwnership);
  });
});

describe('language job polling wiring (PR #6)', () => {
  test('GET /:id/language/analyze-video/jobs/:jobId starts with ownership', () => {
    const router = require('../src/routes/profileRoutes');
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/:id/language/analyze-video/jobs/:jobId' && l.route.methods.get
    );
    expect(layer.route.stack[0].handle).toBe(requireProfileOwnership);
  });
});
