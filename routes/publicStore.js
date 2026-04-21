const express = require('express');
const router = express.Router();
const publicStoreController = require('../controllers/publicStoreController');

// Public routes - no authentication required
// These routes are for customers viewing the online store

// ── Subdomain-resolved routes (no username in path) ──────────────────────────
// Used when the frontend is served from stride.mycroshop.com and calls
// /api/v1/public-store — the middleware sets req.onlineStoreUsername automatically.
router.get('/',                                           publicStoreController.getPublicStore);
router.get('/products',                                   publicStoreController.getPublicProducts);
router.get('/products/:product_id',                       publicStoreController.getPublicProduct);
router.get('/collections/:collection_id/products',        publicStoreController.getPublicCollectionProducts);
router.get('/services',                                   publicStoreController.getPublicServices);
router.get('/services/:service_id',                       publicStoreController.getPublicService);
router.get('/collections/:collection_id/services',        publicStoreController.getPublicCollectionServices);

// ── Explicit username routes (username in path) ───────────────────────────────
// Used when calling from a non-store domain, e.g. /api/v1/public-store/stride
// Get online store by username (public)
router.get('/:username', publicStoreController.getPublicStore);

// Get all products for an online store (public - ALL products with filters)
// Filters: collection_id, search, category, store_id
router.get('/:username/products', publicStoreController.getPublicProducts);

// Get product by ID (public)
router.get('/:username/products/:product_id', publicStoreController.getPublicProduct);

// Get products in a specific collection (public)
router.get('/:username/collections/:collection_id/products', publicStoreController.getPublicCollectionProducts);

// Get all services for an online store (public - ALL services with filters)
// Filters: collection_id, search
router.get('/:username/services', publicStoreController.getPublicServices);

// Get service by ID (public)
router.get('/:username/services/:service_id', publicStoreController.getPublicService);

// Get services in a specific collection (public)
router.get('/:username/collections/:collection_id/services', publicStoreController.getPublicCollectionServices);

module.exports = router;

