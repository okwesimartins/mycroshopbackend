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
router.get('/collections',                                publicStoreController.getPublicCollections);
router.get('/collections/:collection_id/products',        publicStoreController.getPublicCollectionProducts);
router.get('/collections/:collection_id/services',        publicStoreController.getPublicCollectionServices);
router.get('/services',                                   publicStoreController.getPublicServices);
router.get('/services/:service_id',                       publicStoreController.getPublicService);
router.get('/shipping-rates',                             publicStoreController.getPublicShippingRates);
router.get('/categories',                                 publicStoreController.getPublicCategories);

// ── Explicit username routes (username in path) ───────────────────────────────
// Dev/fallback: used when calling from a non-store domain with ?tenant_id=
router.get('/:username',                                            publicStoreController.getPublicStore);
router.get('/:username/products',                                   publicStoreController.getPublicProducts);
router.get('/:username/products/:product_id',                       publicStoreController.getPublicProduct);
router.get('/:username/collections',                                publicStoreController.getPublicCollections);
router.get('/:username/collections/:collection_id/products',        publicStoreController.getPublicCollectionProducts);
router.get('/:username/collections/:collection_id/services',        publicStoreController.getPublicCollectionServices);
router.get('/:username/services',                                   publicStoreController.getPublicServices);
router.get('/:username/services/:service_id',                       publicStoreController.getPublicService);
router.get('/:username/shipping-rates',                             publicStoreController.getPublicShippingRates);
router.get('/:username/categories',                                 publicStoreController.getPublicCategories);

module.exports = router;

