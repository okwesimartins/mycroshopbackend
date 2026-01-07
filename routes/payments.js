const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authenticate } = require('../middleware/auth');

// Initialize payment (authenticated users)
router.post('/initialize', authenticate, paymentController.initializePayment);

// Verify payment (public - called by payment gateway)
router.get('/verify', paymentController.verifyPayment);

// Payment webhook (public - called by payment gateway)
router.post('/webhook', paymentController.handlePaymentWebhook);

module.exports = router;

