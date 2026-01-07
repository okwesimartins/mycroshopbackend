const express = require('express');
const router = express.Router();
const loyaltyController = require('../controllers/loyaltyController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get loyalty program settings
router.get('/program', loyaltyController.getLoyaltyProgram);

// Setup/update loyalty program (admin only)
router.post('/program', authorize('admin', 'manager'), loyaltyController.setupLoyaltyProgram);

// Get customer loyalty points
router.get('/customer/:customer_id', loyaltyController.getCustomerLoyaltyPoints);

// Get customer loyalty history
router.get('/customer/:customer_id/history', loyaltyController.getCustomerLoyaltyHistory);

// Earn points from transaction (usually called automatically)
router.post('/earn', authorize('admin', 'manager'), loyaltyController.earnPointsFromTransaction);

// Redeem points
router.post('/redeem', authorize('admin', 'manager'), loyaltyController.redeemPoints);

module.exports = router;

