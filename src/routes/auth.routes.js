const { Router } = require('express');
const {
  loginController,
  refreshController,
  logoutController,
  changePasswordController,
  forgotPasswordController,
  resetPasswordController,
  getMeController,
} = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { rateLimiter } = require('../middleware/rateLimiter');

const router = Router();

const loginLimiter = rateLimiter({
  keyPrefix: 'rl:login',
  max: 10,
  windowSeconds: 15 * 60,
  message: 'Too many login attempts. Try again in 15 minutes.',
});

const forgotLimiter = rateLimiter({
  keyPrefix: 'rl:forgot',
  max: 5,
  windowSeconds: 60 * 60,
  message: 'Too many password reset requests. Try again in 1 hour.',
});

const refreshLimiter = rateLimiter({
  keyPrefix: 'rl:refresh',
  max: 30,
  windowSeconds: 60 * 60,
});

// public
router.post('/login', loginLimiter, loginController);
router.post('/refresh', refreshLimiter, refreshController);
router.post('/forgot-password', forgotLimiter, forgotPasswordController);
router.post('/reset-password', resetPasswordController);

// protected
router.post('/logout', authenticate, logoutController);
router.post('/change-password', authenticate, changePasswordController);
router.get('/me', authenticate, getMeController);

module.exports = router;
