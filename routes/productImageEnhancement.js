const express = require('express');
const router = express.Router();
const productImageEnhancementController = require('../controllers/productImageEnhancementController');
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get available presets
router.get('/presets', productImageEnhancementController.getPresets);

// Enhance existing product image
router.post('/enhance', productImageEnhancementController.enhanceProductImageEndpoint);

// Generate product image for catalog makeover
router.post('/generate', productImageEnhancementController.generateProductImageEndpoint);

// Save enhanced image as product's main image
router.post('/save', productImageEnhancementController.saveEnhancedImage);

module.exports = router;

