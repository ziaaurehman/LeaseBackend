const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: 'admin@lms.com' } });

  if (existing) {
    console.log('Seed admin already exists — skipping.');
    return;
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
  });

  console.log(`Seed admin created: ${admin.email} (${admin.role})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
