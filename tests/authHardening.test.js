jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'unit-test-secret-not-a-real-one';
const mkRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const run = (headers) => {
  const { authenticateToken } = require('../src/middleware/auth');
  const req = { headers };
  const res = mkRes();
  const next = jest.fn();
  authenticateToken(req, res, next);
  return { req, res, next };
};

const OLD_ENV = process.env;
beforeEach(() => {
  process.env = { ...OLD_ENV, JWT_SECRET: TEST_SECRET };
  delete process.env.ALLOW_HEADER_AUTH;
});
afterAll(() => { process.env = OLD_ENV; });

describe('authenticateToken', () => {
  test('valid token → next, identity verified', () => {
    const token = jwt.sign({ userId: 'u1' }, TEST_SECRET);
    const { req, next } = run({ authorization: `Bearer ${token}` });
    expect(next).toHaveBeenCalled();
    expect(req.user.userId).toBe('u1');
    expect(req.authVerified).toBe(true);
  });

  test('invalid token + x-user-id → 403 (no fallback with a bad token)', () => {
    const { res, next } = run({ authorization: 'Bearer nope', 'x-user-id': 'victim' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('token signed with another secret → 403', () => {
    const token = jwt.sign({ userId: 'u1' }, 'other');
    expect(run({ authorization: `Bearer ${token}` }).res.status).toHaveBeenCalledWith(403);
  });

  test('x-user-id / x-agent-id alone → 401 by default', () => {
    expect(run({ 'x-user-id': 'victim' }).res.status).toHaveBeenCalledWith(401);
    expect(run({ 'x-agent-id': 'victim' }).res.status).toHaveBeenCalledWith(401);
  });

  test('no credentials → 401', () => {
    const { res, next } = run({});
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('ALLOW_HEADER_AUTH=true re-enables header-only identification, never "verified"', () => {
    process.env.ALLOW_HEADER_AUTH = 'true';
    const { req, next } = run({ 'x-user-id': 'legacy' });
    expect(next).toHaveBeenCalled();
    expect(req.user.userId).toBe('legacy');
    expect(req.authVerified).toBe(false);
  });

  test('flag on: an invalid token is still rejected', () => {
    process.env.ALLOW_HEADER_AUTH = 'true';
    const { res, next } = run({ authorization: 'Bearer nope', 'x-user-id': 'legacy' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('missing JWT_SECRET with a token → 500, nothing accepted', () => {
    delete process.env.JWT_SECRET;
    const { res, next } = run({ authorization: 'Bearer anything' });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('getJwtSecret', () => {
  const { getJwtSecret } = require('../src/utils/jwtSecret');
  test('throws when missing, empty or blank', () => {
    delete process.env.JWT_SECRET;
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = '';
    expect(() => getJwtSecret()).toThrow();
    process.env.JWT_SECRET = '   ';
    expect(() => getJwtSecret()).toThrow();
  });
  test('returns the configured value', () => {
    expect(getJwtSecret()).toBe(TEST_SECRET);
  });
});

describe('no hard-coded secret / test-token route left in source', () => {
  const fs = require('fs');
  const path = require('path');
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(path.join(__dirname, '../src')).filter((f) => f.endsWith('.js'));

  test('no JWT_SECRET fallback literal', () => {
    files.forEach((f) => {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/JWT_SECRET\s*\|\|/);
    });
  });

  test('GET /generate-test-token is gone', () => {
    const router = require('../src/routes/profileRoutes');
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths.some((p) => p.includes('generate-test-token'))).toBe(false);
  });
});

describe('error handler logging', () => {
  test('never logs headers, body, query or params', () => {
    const logger = require('../src/utils/logger');
    const errorHandler = require('../src/middleware/errorHandler');
    const req = {
      method: 'POST', baseUrl: '/api/profiles', path: '/x',
      headers: { authorization: 'Bearer SECRET-TOKEN' },
      body: { password: 'SECRET-BODY' }, query: { t: 'SECRET-QUERY' }, params: {},
    };
    const res = mkRes();
    errorHandler(new Error('boom'), req, res, jest.fn());
    const logged = JSON.stringify(logger.error.mock.calls);
    ['SECRET-TOKEN', 'SECRET-BODY', 'SECRET-QUERY'].forEach((s) => expect(logged).not.toContain(s));
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('controller logs', () => {
  test('getProfileById does not log the token', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/controllers/ProfileController.js'), 'utf8');
    expect(src).not.toMatch(/\$\{token\}/);
  });
});
