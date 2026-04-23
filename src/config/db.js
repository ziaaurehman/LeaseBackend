const { PrismaClient } = require('@prisma/client');
const chalk = require('chalk');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

const connectDB = async () => {
  try {
    await prisma.$connect();
    console.log(chalk.green('✔') + chalk.bold(' Database connected ') + chalk.dim(`→ ${process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'Neon PostgreSQL'}`));
  } catch (err) {
    console.error(chalk.red('✖ Database connection failed:'), err.message);
    process.exit(1);
  }
};

module.exports = { prisma, connectDB };
