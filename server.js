require('dotenv').config();
require('express-async-errors');

const chalk = require('chalk');
// const cron = require('node-cron');
const app = require('./src/app');
const { connectDB } = require('./src/config/db');
const { connectRedis } = require('./src/config/redis');
// const { purgeExpiredDeletedUsers } = require('./src/services/user.service');

const PORT = process.env.PORT || 7865;

const start = async () => {
  await connectDB();

  if (process.env.REDIS_URL) {
    await connectRedis();
  } else {
    console.log(chalk.yellow('⚠ Redis skipped     → REDIS_URL not set'));
  }

  // // run daily at midnight — permanently delete users soft-deleted > 30 days ago
  // cron.schedule('0 0 * * *', async () => {
  //   try {
  //     const count = await purgeExpiredDeletedUsers();
  //     if (count > 0) {
  //       console.log(chalk.dim(`[cron] Purged ${count} expired deleted user(s)`));
  //     }
  //   } catch (err) {
  //     console.error(chalk.red('[cron] User purge failed:'), err.message);
  //   }
  // });

  app.listen(PORT, () => {
    console.log('');
    console.log(chalk.bgGreen.black.bold(' LEASE MANAGEMENT API '));
    console.log(chalk.green('✔') + chalk.bold(' Server running     ') + chalk.dim(`→ http://localhost:${PORT}`));
    console.log(chalk.green('✔') + chalk.bold(' Health check       ') + chalk.cyan(`→ http://localhost:${PORT}/health`));
    console.log(chalk.dim('─────────────────────────────────────────'));
    console.log(chalk.dim(`  ENV: ${process.env.NODE_ENV}  |  PORT: ${PORT}`));
    console.log('');
  });
};

start();
