const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const aiAgentController = require('../controllers/aiAgentController');

// Public webhook endpoint (for Meta/Google Cloud)
router.post('/webhook', aiAgentController.handleWebhook);

// Protected routes
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// AI Agent configuration
router.get('/config', aiAgentController.getConfig);
router.put('/config', aiAgentController.updateConfig);

// Check product (for AI agent to query)
router.get('/check-product', aiAgentController.checkProduct);

// Get product info (for AI agent)
router.get('/product-info', aiAgentController.getProductInfo);

module.exports = router;

