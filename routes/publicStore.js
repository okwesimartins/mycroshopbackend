const express = require('express');
const router = express.Router();
const publicStoreController = require('../controllers/publicStoreController');

// Public routes - no authentication required
// These routes are for customers viewing the online store

// Get online store by username (public)
router.get('/:username', publicStoreController.getPublicStore);

// Get all products for an online store (public - ALL products with filters)
// Filters: collection_id, search, category, store_id
router.get('/:username/products', publicStoreController.getPublicProducts);

// Get product by ID (public)
router.get('/:username/products/:product_id', publicStoreController.getPublicProduct);

// Get all services for an online store (public - ALL services with filters)
// Filters: collection_id, search
router.get('/:username/services', publicStoreController.getPublicServices);

// Get service by ID (public)
router.get('/:username/services/:service_id', publicStoreController.getPublicService);

module.exports = router;

