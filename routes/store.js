const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const storeController = require('../controllers/storeController');

// Public routes (for online store frontend)
// Note: These require tenant_id query parameter or subdomain-based routing
// For production, implement subdomain-based tenant identification
router.get('/products', storeController.getPublishedProducts);
router.get('/products/:id', storeController.getPublishedProductById);

// Protected routes (for store management)
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Publish/unpublish product
router.post('/products/:id/publish', storeController.publishProduct);
router.post('/products/:id/unpublish', storeController.unpublishProduct);

// Update store product settings
router.put('/products/:id', storeController.updateStoreProduct);

// Get all store products (admin)
router.get('/admin/products', storeController.getAllStoreProducts);

module.exports = router;

