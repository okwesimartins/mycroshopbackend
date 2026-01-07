const express = require('express');
const router = express.Router();
const orderController = require('../controllers/onlineStoreOrderController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get all orders
router.get('/', orderController.getAllOrders);

// Get order by ID
router.get('/:id', orderController.getOrderById);

// Create order (customer-facing, can be public with proper validation)
router.post('/', orderController.createOrder);

// Update order status (admin/manager only)
router.patch('/:id/status', authorize('admin', 'manager'), orderController.updateOrderStatus);

module.exports = router;

