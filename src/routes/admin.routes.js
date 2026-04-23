const { Router } = require('express');
const { seedAdmin } = require('../controllers/admin.controller');

const router = Router();

// Unprotected seed — only works when no admin exists (self-guards internally)
router.post('/seed', seedAdmin);

module.exports = router;
