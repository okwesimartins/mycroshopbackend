const express = require('express');
const router = express.Router();
const paymentGatewayController = require('../controllers/paymentGatewayController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get payment gateways
router.get('/', paymentGatewayController.getPaymentGateways);

// Add payment gateway (admin only)
router.post('/', authorize('admin'), paymentGatewayController.addPaymentGateway);

// Update payment gateway (admin only)
router.put('/:id', authorize('admin'), paymentGatewayController.updatePaymentGateway);

// Delete payment gateway (admin only)
router.delete('/:id', authorize('admin'), paymentGatewayController.deletePaymentGateway);

module.exports = router;

