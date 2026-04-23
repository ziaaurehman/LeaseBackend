const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const signAccessToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  });
};

const verifyAccessToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

const generateRefreshToken = () => crypto.randomUUID();

const decodeToken = (token) => {
  return jwt.decode(token);
};

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, decodeToken };
