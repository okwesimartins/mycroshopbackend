const express = require('express');
const router = express.Router();
const platformAdminController = require('../controllers/platformAdminController');
const platformSettingsController = require('../controllers/platformSettingsController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require platform admin authentication
router.use(authenticate);
router.use(authorize('platform_admin')); // Only platform admins can access

// Get all tenants (clients)
router.get('/tenants', platformAdminController.getAllTenants);

// Get tenant by ID
router.get('/tenants/:id', platformAdminController.getTenantById);

// Suspend tenant
router.post('/tenants/:id/suspend', platformAdminController.suspendTenant);

// Activate tenant
router.post('/tenants/:id/activate', platformAdminController.activateTenant);

// Get platform statistics
router.get('/stats', platformAdminController.getPlatformStats);

// Upgrade free user to enterprise
const upgradeController = require('../controllers/upgradeController');
router.post('/upgrade-tenant', upgradeController.upgradeToEnterprise);

// ── Platform Settings (Paystack keys, Gemini key, etc.) ──────────────────────
router.get('/settings',                    platformSettingsController.getSettings);
router.put('/settings/:key',               platformSettingsController.upsertSetting);
router.delete('/settings/:key',            platformSettingsController.deleteSetting);
router.post('/settings/test-paystack',     platformSettingsController.testPaystackKeys);

module.exports = router;

