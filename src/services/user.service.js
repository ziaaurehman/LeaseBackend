const bcrypt = require('bcryptjs');
const { prisma } = require('../config/db');
const { redis } = require('../config/redis');
const { generateTempPassword } = require('../utils/generatePassword');
const { sendWelcomeEmail } = require('./email.service');
const { ASSIGNABLE_BY_ADMIN, ASSIGNABLE_BY_SUPER_ADMIN } = require('../validations/user.validation');

// ─── helpers ──────────────────────────────────────────────────────────────────

const invalidateUserCache = async (userId) => {
  await redis.del(`user:${userId}`);
};

const invalidateAllUserTokens = async (userId) => {
  // set pw_changed so all existing access tokens are rejected
  await redis.set(`pw_changed:${userId}`, Math.floor(Date.now() / 1000));
  await invalidateUserCache(userId);
};

// role guard: can the actor manage the target role?
const assertCanManageRole = (actorRole, targetRole) => {
  if (targetRole === 'SUPER_ADMIN') {
    throw { status: 403, message: 'Cannot manage a Super Admin account' };
  }
  if (actorRole === 'ADMIN' && !ASSIGNABLE_BY_ADMIN.includes(targetRole)) {
    throw { status: 403, message: 'Admin cannot manage users with this role' };
  }
};

// role guard: can the actor assign this role to a new user?
const assertCanAssignRole = (actorRole, targetRole) => {
  if (actorRole === 'SUPER_ADMIN' && !ASSIGNABLE_BY_SUPER_ADMIN.includes(targetRole)) {
    throw { status: 400, message: 'Invalid role assignment' };
  }
  if (actorRole === 'ADMIN' && !ASSIGNABLE_BY_ADMIN.includes(targetRole)) {
    throw { status: 403, message: 'Admin cannot create users with this role' };
  }
};

// ─── Create User ──────────────────────────────────────────────────────────────

const createUser = async ({ name, email, role }, actorRole) => {
  assertCanAssignRole(actorRole, role);

  const existing = await prisma.user.findFirst({ where: { email, isDeleted: false } });
  if (existing) {
    throw { status: 409, message: 'A user with this email already exists' };
  }

  const tempPassword = generateTempPassword();
  const hashed = await bcrypt.hash(tempPassword, 12);

  const user = await prisma.user.create({
    data: { name, email, password: hashed, role, mustChangePassword: true },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  });

  // send welcome email — don't block the response on failure
  sendWelcomeEmail({ to: email, name, password: tempPassword }).catch((err) =>
    console.error('Welcome email failed:', err.message)
  );

  return user;
};

// ─── List Users ───────────────────────────────────────────────────────────────

const listUsers = async ({ page, limit, role, isActive, isDeleted, search }, actorRole) => {
  const where = {};

  // ADMIN cannot see SUPER_ADMIN accounts
  if (actorRole === 'ADMIN') {
    where.role = { not: 'SUPER_ADMIN' };
  }

  // default: show non-deleted users unless caller explicitly asks for deleted
  where.isDeleted = isDeleted !== undefined ? isDeleted : false;

  if (role) where.role = role;
  if (isActive !== undefined) where.isActive = isActive;

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        isDeleted: true,
        deletedAt: true,
        mustChangePassword: true,
        lastLoginAt: true,
        createdAt: true,
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
};

// ─── Get User By ID ───────────────────────────────────────────────────────────

const getUserById = async (id, actorRole) => {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      isDeleted: true,
      deletedAt: true,
      deletedBy: true,
      mustChangePassword: true,
      failedLoginAttempts: true,
      lockedUntil: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) throw { status: 404, message: 'User not found' };

  if (actorRole === 'ADMIN' && user.role === 'SUPER_ADMIN') {
    throw { status: 403, message: 'Cannot view this user' };
  }

  return user;
};

// ─── Update User ──────────────────────────────────────────────────────────────

const updateUser = async (id, { name, email }, actorRole) => {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.isDeleted) throw { status: 404, message: 'User not found' };

  assertCanManageRole(actorRole, user.role);

  if (email && email !== user.email) {
    const taken = await prisma.user.findFirst({ where: { email, isDeleted: false } });
    if (taken) throw { status: 409, message: 'Email is already in use' };
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { ...(name && { name }), ...(email && { email }) },
    select: { id: true, name: true, email: true, role: true, isActive: true, updatedAt: true },
  });

  await invalidateUserCache(id);
  return updated;
};

// ─── Toggle Status (Activate / Deactivate) ────────────────────────────────────

const toggleStatus = async (id, actorId, actorRole) => {
  if (id === actorId) throw { status: 400, message: 'You cannot change your own account status' };

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.isDeleted) throw { status: 404, message: 'User not found' };

  assertCanManageRole(actorRole, user.role);

  const newStatus = !user.isActive;

  await prisma.user.update({ where: { id }, data: { isActive: newStatus } });

  if (!newStatus) {
    // deactivating — record timestamp so auth middleware can reject existing tokens
    await redis.set(`deactivated_at:${id}`, Math.floor(Date.now() / 1000));
    await invalidateUserCache(id);
  } else {
    // reactivating — clear the deactivated flag
    await redis.del(`deactivated_at:${id}`);
    await invalidateUserCache(id);
  }

  return { isActive: newStatus };
};

// ─── Reset Password ───────────────────────────────────────────────────────────

const resetPassword = async (id, actorRole) => {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.isDeleted) throw { status: 404, message: 'User not found' };

  assertCanManageRole(actorRole, user.role);

  const tempPassword = generateTempPassword();
  const hashed = await bcrypt.hash(tempPassword, 12);

  await prisma.user.update({
    where: { id },
    data: { password: hashed, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null },
  });

  // invalidate all existing tokens
  await invalidateAllUserTokens(id);

  // send new temp password — non-blocking
  sendWelcomeEmail({ to: user.email, name: user.name, password: tempPassword }).catch((err) =>
    console.error('Reset password email failed:', err.message)
  );
};

// ─── Soft Delete ──────────────────────────────────────────────────────────────

const softDeleteUser = async (id, actorId, actorRole) => {
  if (id === actorId) throw { status: 400, message: 'You cannot delete your own account' };

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw { status: 404, message: 'User not found' };
  if (user.isDeleted) throw { status: 409, message: 'User is already deleted' };

  assertCanManageRole(actorRole, user.role);

  await prisma.user.update({
    where: { id },
    data: {
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: actorId,
      isActive: false,
    },
  });

  // invalidate all tokens and cache
  await invalidateAllUserTokens(id);
  await redis.set(`deactivated_at:${id}`, Math.floor(Date.now() / 1000));
};

// ─── Recover Soft-Deleted User ────────────────────────────────────────────────

const recoverUser = async (id, actorRole) => {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw { status: 404, message: 'User not found' };
  if (!user.isDeleted) throw { status: 409, message: 'User is not deleted' };

  assertCanManageRole(actorRole, user.role);

  await prisma.user.update({
    where: { id },
    data: { isDeleted: false, deletedAt: null, deletedBy: null },
  });

  // clear deactivated flag — admin can manually re-activate after recovery
  await redis.del(`deactivated_at:${id}`);
  await invalidateUserCache(id);
};

// ─── Hard Delete (SUPER_ADMIN only) ──────────────────────────────────────────

const hardDeleteUser = async (id, actorId) => {
  if (id === actorId) throw { status: 400, message: 'You cannot permanently delete your own account' };

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw { status: 404, message: 'User not found' };
  if (!user.isDeleted) {
    throw { status: 409, message: 'User must be soft-deleted before permanent deletion' };
  }

  await prisma.user.delete({ where: { id } });

  // clean up all Redis keys for this user
  await Promise.all([
    redis.del(`user:${id}`),
    redis.del(`pw_changed:${id}`),
    redis.del(`deactivated_at:${id}`),
  ]);
};

// ─── Auto-Cleanup Cron (called from server.js) ────────────────────────────────

const purgeExpiredDeletedUsers = async () => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

  const expired = await prisma.user.findMany({
    where: { isDeleted: true, deletedAt: { lte: cutoff } },
    select: { id: true },
  });

  if (expired.length === 0) return 0;

  const ids = expired.map((u) => u.id);

  await prisma.user.deleteMany({ where: { id: { in: ids } } });

  // clean Redis for each purged user
  await Promise.all(
    ids.flatMap((id) => [
      redis.del(`user:${id}`),
      redis.del(`pw_changed:${id}`),
      redis.del(`deactivated_at:${id}`),
    ])
  );

  return ids.length;
};

module.exports = {
  createUser,
  listUsers,
  getUserById,
  updateUser,
  toggleStatus,
  resetPassword,
  softDeleteUser,
  recoverUser,
  hardDeleteUser,
  purgeExpiredDeletedUsers,
};
