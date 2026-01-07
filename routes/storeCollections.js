const express = require('express');
const router = express.Router();
const storeCollectionController = require('../controllers/storeCollectionController');
const storeProductController = require('../controllers/storeProductController');
const storeServiceController = require('../controllers/storeServiceController');
const { authenticate, authorize } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get all collections for an online store
router.get('/online/:online_store_id/collections', storeCollectionController.getStoreCollections);

// Get collection by ID
router.get('/collections/:id', storeCollectionController.getCollectionById);

// Create collection
router.post('/online/:online_store_id/collections', authorize('admin', 'manager'), storeCollectionController.createCollection);

// Update collection
router.put('/collections/:id', authorize('admin', 'manager'), storeCollectionController.updateCollection);

// Update collection sort order (bulk reorder)
router.patch('/online/:online_store_id/collections/sort-order', authorize('admin', 'manager'), storeCollectionController.updateCollectionSortOrder);

// Delete collection
router.delete('/collections/:id', authorize('admin', 'manager'), storeCollectionController.deleteCollection);

// Get available products for adding to collections
router.get('/online/:online_store_id/products/available', storeProductController.getAvailableProducts);

// Get available services for adding to collections
router.get('/online/:online_store_id/services/available', storeServiceController.getAvailableServices);

// Get products in a collection
router.get('/collections/:collection_id/products', storeProductController.getCollectionProducts);

// Add product to collection
router.post('/collections/:collection_id/products', authorize('admin', 'manager'), storeCollectionController.addProductToCollection);

// Add multiple products to collection (bulk)
router.post('/collections/:collection_id/products/bulk', authorize('admin', 'manager'), storeCollectionController.addProductsToCollection);

// Remove product from collection
router.delete('/collections/:collection_id/products/:product_id', authorize('admin', 'manager'), storeCollectionController.removeProductFromCollection);

// Update product in collection (pin, sort order)
router.patch('/collections/:collection_id/products/:product_id', authorize('admin', 'manager'), storeCollectionController.updateProductInCollection);

// Get services in a collection
router.get('/collections/:collection_id/services', storeCollectionController.getCollectionServices);

// Add service to collection
router.post('/collections/:collection_id/services', authorize('admin', 'manager'), storeCollectionController.addServiceToCollection);

// Add multiple services to collection (bulk)
router.post('/collections/:collection_id/services/bulk', authorize('admin', 'manager'), storeCollectionController.addServicesToCollection);

// Remove service from collection
router.delete('/collections/:collection_id/services/:service_id', authorize('admin', 'manager'), storeCollectionController.removeServiceFromCollection);

// Update service in collection (pin, sort order)
router.patch('/collections/:collection_id/services/:service_id', authorize('admin', 'manager'), storeCollectionController.updateServiceInCollection);

module.exports = router;

