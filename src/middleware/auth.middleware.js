const { verifyAccessToken } = require('../utils/generateToken');
const { sendError } = require('../utils/response');
const { redis } = require('../config/redis');
const { prisma } = require('../config/db');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return sendError(res, 'Access token required', 401);
    }

    const token = authHeader.split(' ')[1];

    // check blacklist
    const isBlacklisted = await redis.get(`blacklist:${token}`);
    if (isBlacklisted) {
      return sendError(res, 'Token has been revoked', 401);
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      const message = err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token';
      return sendError(res, message, 401);
    }

    // check pw_changed flag (invalidates all tokens issued before password change)
    const pwChanged = await redis.get(`pw_changed:${payload.id}`);
    if (pwChanged && payload.iat < parseInt(pwChanged)) {
      return sendError(res, 'Password was changed. Please log in again.', 401);
    }

    // try user cache first
    const cached = await redis.get(`user:${payload.id}`);
    if (cached) {
      req.user = JSON.parse(cached);
      return next();
    }

    // cache miss — hit DB
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, name: true, email: true, role: true, isActive: true, isDeleted: true, mustChangePassword: true },
    });

    if (!user || user.isDeleted) {
      return sendError(res, 'User not found', 401);
    }

    if (!user.isActive) {
      return sendError(res, 'Account is deactivated. Contact your administrator.', 403);
    }

    // cache for 5 minutes
    await redis.setEx(`user:${payload.id}`, 300, JSON.stringify(user));
    req.user = user;
    next();
  } catch {
    return sendError(res, 'Authentication failed', 500);
  }
};

module.exports = { authenticate };
