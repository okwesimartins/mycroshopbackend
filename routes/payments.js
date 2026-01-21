const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authenticate } = require('../middleware/auth');

// Initialize payment (public - for customers booking services or buying products)
router.post('/initialize', paymentController.initializePayment);

// Verify payment (public - called by payment gateway)
router.get('/verify', paymentController.verifyPayment);

// Payment webhook (public - called by payment gateway)
// Supports online_store_id as query parameter: /api/v1/payments/webhook?online_store_id=123
router.post('/webhook', paymentController.handlePaymentWebhook);

// Get webhook URL for online store (for Paystack dashboard configuration)
router.get('/webhook-url/:online_store_id', authenticate, paymentController.getWebhookUrl);

module.exports = router;

