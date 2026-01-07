const express = require('express');
const router = express.Router();
const storeManagementController = require('../controllers/storeManagementController');
const { authenticate, authorize } = require('../middleware/auth');
const { restrictPhysicalStores } = require('../middleware/subscriptionPlan');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get all stores
router.get('/', storeManagementController.getAllStores);

// Get store overview
router.get('/:id/overview', storeManagementController.getStoreOverview);

// Get store by ID
router.get('/:id', storeManagementController.getStoreById);

// Create store (admin/manager only) - RESTRICTED for free users
router.post('/', authorize('admin', 'manager'), restrictPhysicalStores, storeManagementController.createStore);

// Update store (admin/manager only) - RESTRICTED for free users
router.put('/:id', authorize('admin', 'manager'), restrictPhysicalStores, storeManagementController.updateStore);

// Delete store (admin only) - RESTRICTED for free users
router.delete('/:id', authorize('admin'), restrictPhysicalStores, storeManagementController.deleteStore);

module.exports = router;
