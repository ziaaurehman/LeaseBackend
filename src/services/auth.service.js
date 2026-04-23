const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { prisma } = require('../config/db');
const { redis } = require('../config/redis');
const { signAccessToken, generateRefreshToken, verifyAccessToken } = require('../utils/generateToken');
const { sendPasswordResetEmail, sendWelcomeEmail } = require('./email.service');

const REFRESH_TTL = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30') * 86400;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_SECONDS = 15 * 60; // 15 minutes

// ─── Login ────────────────────────────────────────────────────────────────────

const login = async ({ email, password }) => {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.isDeleted) {
    throw { status: 401, message: 'Invalid email or password' };
  }

  if (!user.isActive) {
    throw { status: 403, message: 'Account is deactivated. Contact your administrator.' };
  }

  // check lock
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const remaining = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    throw { status: 429, message: `Account locked. Try again in ${remaining} minute(s).` };
  }

  const passwordMatch = await bcrypt.compare(password, user.password);

  if (!passwordMatch) {
    const newAttempts = user.failedLoginAttempts + 1;
    const updateData = { failedLoginAttempts: newAttempts };

    if (newAttempts >= MAX_FAILED_ATTEMPTS) {
      updateData.lockedUntil = new Date(Date.now() + LOCK_DURATION_SECONDS * 1000);
      updateData.failedLoginAttempts = 0;
    }

    await prisma.user.update({ where: { id: user.id }, data: updateData });
    throw { status: 401, message: 'Invalid email or password' };
  }

  // successful login — reset lock state
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  const payload = { id: user.id, email: user.email, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = generateRefreshToken();

  // store refresh token in Redis
  await redis.setEx(`refresh:${refreshToken}`, REFRESH_TTL, user.id);

  // warm user cache
  const userCache = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    isDeleted: user.isDeleted,
    mustChangePassword: user.mustChangePassword,
  };
  await redis.setEx(`user:${user.id}`, 300, JSON.stringify(userCache));

  return {
    accessToken,
    refreshToken,
    user: userCache,
  };
};

// ─── Refresh Token ────────────────────────────────────────────────────────────

const refreshAccessToken = async (refreshToken) => {
  const userId = await redis.get(`refresh:${refreshToken}`);
  if (!userId) {
    throw { status: 401, message: 'Invalid or expired refresh token' };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, isActive: true, isDeleted: true },
  });

  if (!user || user.isDeleted || !user.isActive) {
    await redis.del(`refresh:${refreshToken}`);
    throw { status: 401, message: 'User not found or inactive' };
  }

  const newAccessToken = signAccessToken({ id: user.id, email: user.email, role: user.role });

  // rotate refresh token
  const newRefreshToken = generateRefreshToken();
  const ttl = await redis.ttl(`refresh:${refreshToken}`);
  const remainingTtl = ttl > 0 ? ttl : REFRESH_TTL;

  await redis.del(`refresh:${refreshToken}`);
  await redis.setEx(`refresh:${newRefreshToken}`, remainingTtl, user.id);

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
};

// ─── Logout ───────────────────────────────────────────────────────────────────

const logout = async (accessToken, refreshToken) => {
  // blacklist the access token until it would have expired (~15min max)
  await redis.setEx(`blacklist:${accessToken}`, 60 * 20, '1');

  if (refreshToken) {
    await redis.del(`refresh:${refreshToken}`);
  }
};

// ─── Change Password ──────────────────────────────────────────────────────────

const changePassword = async (userId, { currentPassword, newPassword }, accessToken) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw { status: 404, message: 'User not found' };

  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) throw { status: 400, message: 'Current password is incorrect' };

  const hashed = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { id: userId },
    data: { password: hashed, mustChangePassword: false },
  });

  // invalidate all tokens issued before now
  await redis.set(`pw_changed:${userId}`, Math.floor(Date.now() / 1000));

  // blacklist current access token
  await redis.setEx(`blacklist:${accessToken}`, 60 * 20, '1');

  // clear user cache so next request gets fresh data
  await redis.del(`user:${userId}`);
};

// ─── Forgot Password ──────────────────────────────────────────────────────────

const forgotPassword = async (email) => {
  const user = await prisma.user.findUnique({ where: { email } });

  // always return success to prevent user enumeration
  if (!user || user.isDeleted || !user.isActive) return;

  const token = crypto.randomBytes(32).toString('hex');
  const TTL = 60 * 60; // 1 hour

  await redis.setEx(`pwd_reset:${token}`, TTL, user.id);

  const resetLink = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
  await sendPasswordResetEmail({ to: user.email, name: user.name, resetLink });
};

// ─── Reset Password ───────────────────────────────────────────────────────────

const resetPassword = async ({ token, newPassword }) => {
  const userId = await redis.get(`pwd_reset:${token}`);
  if (!userId) {
    throw { status: 400, message: 'Reset token is invalid or has expired' };
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.isDeleted) {
    throw { status: 404, message: 'User not found' };
  }

  const hashed = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { id: userId },
    data: { password: hashed, mustChangePassword: false },
  });

  // consume the reset token
  await redis.del(`pwd_reset:${token}`);

  // invalidate all existing tokens
  await redis.set(`pw_changed:${userId}`, Math.floor(Date.now() / 1000));
  await redis.del(`user:${userId}`);
};

// ─── Get Profile ──────────────────────────────────────────────────────────────

const getProfile = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, lastLoginAt: true, mustChangePassword: true, createdAt: true },
  });
  if (!user) throw { status: 404, message: 'User not found' };
  return user;
};

module.exports = { login, refreshAccessToken, logout, changePassword, forgotPassword, resetPassword, getProfile };
