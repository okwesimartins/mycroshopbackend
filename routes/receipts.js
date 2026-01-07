const express = require('express');
const router = express.Router();
const receiptController = require('../controllers/receiptController');
const { authenticate } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Generate receipt HTML (for printing)
router.get('/:id', receiptController.generateReceipt);

// Generate receipt PDF
router.get('/:id/pdf', receiptController.generateReceiptPDF);

module.exports = router;

