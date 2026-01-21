const express = require('express');
const router = express.Router();
const orderController = require('../controllers/onlineStoreOrderController');
const { authenticate, authorize } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');

// All routes require authentication and tenant DB/models
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get all orders
router.get('/', orderController.getAllOrders);

// Get order by ID
router.get('/:id', orderController.getOrderById);

// Create order (customer-facing, can be public with proper validation)
router.post('/', orderController.createOrder);

// Update order status (admin/manager only)
router.patch('/:id/status', authorize('admin', 'manager'), orderController.updateOrderStatus);

module.exports = router;

