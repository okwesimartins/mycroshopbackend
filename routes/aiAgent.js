const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const aiAgentController = require('../controllers/aiAgentController');

// Public webhook endpoint (for Meta/Google Cloud)
router.post('/webhook', aiAgentController.handleWebhook);

// AI Agent API (x-api-key only – used by Google Cloud, no JWT)
router.get('/resolve-tenant', aiAgentController.resolveTenant);
router.post('/resolve-tenant', aiAgentController.resolveTenant);
// Resolve by phone_number_id (same as resolve-tenant; explicit name for lookup)
router.get('/resolve-phone-number-id', aiAgentController.resolveTenant);
router.post('/resolve-phone-number-id', aiAgentController.resolveTenant);
router.get('/check-product', aiAgentController.checkProduct);
router.get('/product-info', aiAgentController.getProductInfo);
router.get('/list-products', aiAgentController.listProducts);

// Protected routes
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// AI Agent configuration
router.get('/config', aiAgentController.getConfig);
router.put('/config', aiAgentController.updateConfig);

module.exports = router;

