const express = require('express');
const router = express.Router();
const publicCheckoutController = require('../controllers/publicCheckoutController');

// Public checkout routes - no authentication required
// These routes are for customers to checkout and make payments

// Create order (checkout) - public
router.post('/orders', publicCheckoutController.createPublicOrder);

// Initialize payment for order - public
router.post('/payments/initialize', publicCheckoutController.initializePublicPayment);

// Get order by order number (public - for customers to track orders)
router.get('/orders/:order_number', publicCheckoutController.getPublicOrderByNumber);

// Verify payment - public (already exists but keeping for consistency)
// This uses the existing verifyPayment endpoint

module.exports = router;

