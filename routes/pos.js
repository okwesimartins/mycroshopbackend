const express = require('express');
const router = express.Router();
const posController = require('../controllers/posController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Lookup product by barcode (for scanning)
router.get('/lookup', posController.lookupProductByBarcode);

// Get all transactions
router.get('/transactions', posController.getAllTransactions);

// Get transaction by ID
router.get('/transactions/:id', posController.getTransactionById);

// Create transaction (checkout)
router.post('/transactions', posController.createTransaction);

// Refund transaction
router.post('/transactions/:id/refund', authorize('admin', 'manager'), posController.refundTransaction);

module.exports = router;

