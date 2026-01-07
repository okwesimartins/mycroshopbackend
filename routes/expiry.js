const express = require('express');
const router = express.Router();
const expiryController = require('../controllers/expiryController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get products expiring soon
router.get('/expiring', expiryController.getExpiringProducts);

// Get expired products
router.get('/expired', expiryController.getExpiredProducts);

// Mark expired products as inactive (admin/manager only)
router.post('/mark-inactive', authorize('admin', 'manager'), expiryController.markExpiredAsInactive);

module.exports = router;