const { Router } = require('express');
const authRoutes     = require('./auth.routes');
const adminRoutes    = require('./admin.routes');
const userRoutes     = require('./user.routes');
const propertyRoutes = require('./property.routes');
const tenantRoutes   = require('./tenant.routes');
const leaseRoutes    = require('./lease.routes');

const router = Router();

router.use('/auth',       authRoutes);
router.use('/admin',      adminRoutes);
router.use('/users',      userRoutes);
router.use('/properties', propertyRoutes);
router.use('/tenants',    tenantRoutes);
router.use('/leases',     leaseRoutes);

module.exports = router;
