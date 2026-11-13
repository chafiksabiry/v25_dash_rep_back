const Agent = require('../models/Agent');
const logger = require('../utils/logger');
const { isObjectIdString } = require('../utils/objectId');

/**
 * Requires an identity proven by a verified token. The legacy header-only
 * fallback (ALLOW_HEADER_AUTH) is NOT accepted. Place BEFORE multer so no
 * upload is buffered for an unauthenticated caller.
 */
const requireVerifiedAuth = (req, res, next) => {
  if (req.authVerified === true && (req.user?.userId || req.user?.id)) return next();
  return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'A valid token is required' });
};

/**
 * Requires that the profile in `:id` (agent _id OR userId) belongs to the user of
 * the verified token. 401/403/404 before any external call (OpenAI, Cloudinary).
 * On success sets req.ownedAgent = { _id, userId }.
 */
const requireProfileOwnership = async (req, res, next) => {
  const requesterId = req.user?.userId || req.user?.id;
  if (req.authVerified !== true || !requesterId) {
    return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'A valid token is required' });
  }

  const profileId = req.params.id;
  if (!isObjectIdString(profileId)) {
    return res.status(404).json({ code: 'PROFILE_NOT_FOUND', message: 'Profile not found' });
  }

  try {
    const agent = await Agent.findOne(
      { $or: [{ _id: profileId }, { userId: profileId }] },
      { userId: 1 }
    ).lean();
    if (!agent) {
      return res.status(404).json({ code: 'PROFILE_NOT_FOUND', message: 'Profile not found' });
    }
    if (String(agent.userId) !== String(requesterId)) {
      logger.warn(`Access refused: token does not own profile ${profileId} (${req.method} ${req.baseUrl}${req.path})`);
      return res.status(403).json({ code: 'FORBIDDEN', message: 'You cannot access another profile' });
    }
    req.ownedAgent = { _id: agent._id, userId: agent.userId };
    return next();
  } catch (error) {
    logger.error(`Ownership check failed: ${error.message}`);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Authorization check failed' });
  }
};

module.exports = { requireVerifiedAuth, requireProfileOwnership };
