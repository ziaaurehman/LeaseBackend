const { sendSuccess, sendError } = require('../utils/response');
const {
  login,
  refreshAccessToken,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  getProfile,
} = require('../services/auth.service');
const {
  loginSchema,
  refreshTokenSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} = require('../validations/auth.validation');

const handleServiceError = (res, err) => {
  if (err.status) return sendError(res, err.message, err.status);
  console.error(err);
  return sendError(res, 'Something went wrong', 500);
};

// POST /auth/login
const loginController = async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 'Validation failed', 422, parsed.error.flatten().fieldErrors);
  }

  try {
    const result = await login(parsed.data);
    return sendSuccess(res, result, 'Login successful');
  } catch (err) {
    return handleServiceError(res, err);
  }
};

// POST /auth/refresh
const refreshController = async (req, res) => {
  const parsed = refreshTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 'Validation failed', 422, parsed.error.flatten().fieldErrors);
  }

  try {
    const tokens = await refreshAccessToken(parsed.data.refreshToken);
    return sendSuccess(res, tokens, 'Token refreshed');
  } catch (err) {
    return handleServiceError(res, err);
  }
};

// POST /auth/logout
const logoutController = async (req, res) => {
  const authHeader = req.headers.authorization;
  const accessToken = authHeader?.split(' ')[1];
  const { refreshToken } = req.body;

  try {
    await logout(accessToken, refreshToken);
    return sendSuccess(res, {}, 'Logged out successfully');
  } catch (err) {
    return handleServiceError(res, err);
  }
};

// POST /auth/change-password
const changePasswordController = async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 'Validation failed', 422, parsed.error.flatten().fieldErrors);
  }

  const accessToken = req.headers.authorization?.split(' ')[1];

  try {
    await changePassword(req.user.id, parsed.data, accessToken);
    return sendSuccess(res, {}, 'Password changed successfully. Please log in again.');
  } catch (err) {
    return handleServiceError(res, err);
  }
};

// POST /auth/forgot-password
const forgotPasswordController = async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 'Validation failed', 422, parsed.error.flatten().fieldErrors);
  }

  try {
    await forgotPassword(parsed.data.email);
    // always return success to prevent enumeration
    return sendSuccess(res, {}, 'If that email exists, a reset link has been sent.');
  } catch (err) {
    return handleServiceError(res, err);
  }
};

// POST /auth/reset-password
const resetPasswordController = async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 'Validation failed', 422, parsed.error.flatten().fieldErrors);
  }

  try {
    await resetPassword(parsed.data);
    return sendSuccess(res, {}, 'Password reset successfully. You can now log in.');
  } catch (err) {
    return handleServiceError(res, err);
  }
};

// GET /auth/me
const getMeController = async (req, res) => {
  try {
    const user = await getProfile(req.user.id);
    return sendSuccess(res, { user }, 'Profile retrieved');
  } catch (err) {
    return handleServiceError(res, err);
  }
};

module.exports = {
  loginController,
  refreshController,
  logoutController,
  changePasswordController,
  forgotPasswordController,
  resetPasswordController,
  getMeController,
};
