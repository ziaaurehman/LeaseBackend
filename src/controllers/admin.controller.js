const bcrypt = require('bcryptjs');
const { prisma } = require('../config/db');
const { sendSuccess, sendError } = require('../utils/response');

// POST /admin/seed  — creates the initial SUPER_ADMIN if none exists
// This endpoint is only accessible with SUPER_ADMIN role (or before any admin exists)
const seedAdmin = async (req, res) => {
  try {
    const existing = await prisma.user.findFirst({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
    });

    if (existing) {
      return sendError(res, 'Admin already exists. Seed is disabled.', 409);
    }

    const hashed = await bcrypt.hash('Admin@lms12345', 12);

    const admin = await prisma.user.create({
      data: {
        name: 'Super Admin',
        email: 'admin@lms.com',
        password: hashed,
        role: 'SUPER_ADMIN',
        mustChangePassword: false,
      },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });

    return sendSuccess(res, { user: admin }, 'Admin seeded successfully', 201);
  } catch (err) {
    console.error(err);
    return sendError(res, 'Seed failed', 500);
  }
};

module.exports = { seedAdmin };
