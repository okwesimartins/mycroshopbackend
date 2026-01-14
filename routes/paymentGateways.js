const express = require('express');
const router = express.Router();
const paymentGatewayController = require('../controllers/paymentGatewayController');
const { authenticate, authorize } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get payment gateways
router.get('/', paymentGatewayController.getPaymentGateways);

// Add payment gateway (admin only)
router.post('/', authorize('admin'), paymentGatewayController.addPaymentGateway);

// Update payment gateway (admin only)
router.put('/:id', authorize('admin'), paymentGatewayController.updatePaymentGateway);

// Delete payment gateway (admin only)
router.delete('/:id', authorize('admin'), paymentGatewayController.deletePaymentGateway);

module.exports = router;

