// The JWT signing secret must come from the environment: there is no default.
// Called once at startup (index.js) so a misconfigured server refuses to boot,
// and by the auth middleware on each verification.
const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
};

module.exports = { getJwtSecret };
