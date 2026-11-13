const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../utils/jwtSecret');

// Legacy identification by x-user-id / x-agent-id WITHOUT a token. Off by default;
// only an explicit ALLOW_HEADER_AUTH=true re-enables it (transition for clients
// that still depend on it). A token that is present but invalid is NEVER accepted,
// whatever the flag. Identity set from a header is not "verified".
const headerAuthAllowed = () => process.env.ALLOW_HEADER_AUTH === 'true';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    let secret;
    try {
      secret = getJwtSecret();
    } catch (error) {
      return res.status(500).json({ message: 'Server authentication is not configured' });
    }
    try {
      req.user = jwt.verify(token, secret);
      // Identity proven by a verified JWT.
      req.authVerified = true;
      return next();
    } catch (error) {
      return res.status(403).json({ message: 'Invalid token' });
    }
  }

  const userIdFromHeader = req.headers['x-user-id'] || req.headers['x-agent-id'];
  if (userIdFromHeader && headerAuthAllowed()) {
    req.user = { id: userIdFromHeader, userId: userIdFromHeader };
    req.authVerified = false;
    return next();
  }

  return res.status(401).json({ message: 'No token provided' });
};

module.exports = { authenticateToken };
