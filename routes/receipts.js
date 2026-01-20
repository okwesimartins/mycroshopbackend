const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const receiptController = require('../controllers/receiptController');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Generate receipt from invoice
router.post('/invoices/:id/generate', receiptController.generateReceiptFromInvoice);

// Generate standalone receipt (walk-in customers, quick sales)
router.post('/standalone', receiptController.generateStandaloneReceipt);

// Sync receipt from offline client (for offline-first mobile apps)
router.post('/sync', receiptController.syncReceipt);

// Get receipt by ID
router.get('/:id', receiptController.getReceiptById);

// Get all receipts for an invoice
router.get('/invoices/:id/receipts', receiptController.getReceiptsByInvoice);

module.exports = router;
