const { createClient } = require('redis');
const chalk = require('chalk');

const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redis.on('error', (err) => {
  console.error(chalk.red('✖ Redis error:'), err.message);
});

const connectRedis = async () => {
  try {
    await redis.connect();
    console.log(chalk.cyan('✔') + chalk.bold(' Redis connected    ') + chalk.dim(`→ ${process.env.REDIS_URL || 'redis://localhost:6379'}`));
  } catch (err) {
    console.warn(chalk.yellow('⚠ Redis not connected:'), err.message);
  }
};

module.exports = { redis, connectRedis };
