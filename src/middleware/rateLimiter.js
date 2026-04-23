const { redis } = require('../config/redis');
const { sendError } = require('../utils/response');

// factory — creates a rate limiter middleware
const rateLimiter = ({ keyPrefix, max, windowSeconds, message }) => {
  return async (req, res, next) => {
    try {
      const identifier = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      const key = `${keyPrefix}:${identifier}`;

      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (current > max) {
        const ttl = await redis.ttl(key);
        return sendError(
          res,
          message || `Too many requests. Try again in ${Math.ceil(ttl / 60)} minute(s).`,
          429
        );
      }

      next();
    } catch {
      // if Redis is down, fail open (don't block requests)
      next();
    }
  };
};

module.exports = { rateLimiter };
