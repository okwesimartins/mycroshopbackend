const express = require('express');
const router = express.Router();
const bundleController = require('../controllers/productBundleController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get all bundles
router.get('/', bundleController.getAllBundles);

// Get bundle by ID
router.get('/:id', bundleController.getBundleById);

// Create bundle (admin/manager only)
router.post('/', authorize('admin', 'manager'), bundleController.createBundle);

module.exports = router;

