const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  const userIdFromHeader = req.headers['x-user-id'] || req.headers['x-agent-id'];

  if (!token && !userIdFromHeader) {
    return res.status(401).json({ message: 'No token or identification provided' });
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      req.user = decoded;
      return next();
    } catch (error) {
      // If token is invalid but we have a userId from header, proceed anyway
      if (userIdFromHeader) {
        console.warn(`Invalid token for user ${userIdFromHeader}, but allowing via identification header`);
        req.user = { id: userIdFromHeader, userId: userIdFromHeader };
        return next();
      }
      return res.status(403).json({ message: 'Invalid token' });
    }
  }

  // If no token but we have userId from header
  if (userIdFromHeader) {
    req.user = { id: userIdFromHeader, userId: userIdFromHeader };
    return next();
  }
};

module.exports = { authenticateToken }; 