const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrderController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get all purchase orders
router.get('/', purchaseOrderController.getAllPurchaseOrders);

// Get purchase order by ID
router.get('/:id', purchaseOrderController.getPurchaseOrderById);

// Create purchase order (admin/manager only)
router.post('/', authorize('admin', 'manager'), purchaseOrderController.createPurchaseOrder);

// Receive purchase order (update stock)
router.post('/:id/receive', authorize('admin', 'manager'), purchaseOrderController.receivePurchaseOrder);

// Update purchase order status
router.patch('/:id/status', authorize('admin', 'manager'), purchaseOrderController.updatePurchaseOrderStatus);

module.exports = router;

