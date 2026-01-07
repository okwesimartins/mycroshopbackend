const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const invoiceController = require('../controllers/invoiceController');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get all invoices
router.get('/', invoiceController.getAllInvoices);

// Get invoice by ID
router.get('/:id', invoiceController.getInvoiceById);

// Generate AI invoice templates, previews, and PDFs
router.post('/:id/ai-templates', invoiceController.generateAiTemplatesForInvoice);

// Create invoice
router.post('/',
  [
    body('customer_id').optional().isInt().withMessage('Customer ID must be an integer'),
    body('issue_date').notEmpty().withMessage('Issue date is required'),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.item_name').notEmpty().withMessage('Item name is required'),
    body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be positive'),
    body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be positive')
  ],
  invoiceController.createInvoice
);

// Update invoice
router.put('/:id', invoiceController.updateInvoice);

// Update invoice status
router.patch('/:id/status', invoiceController.updateInvoiceStatus);

// Delete invoice
router.delete('/:id', authorize('admin', 'manager'), invoiceController.deleteInvoice);

module.exports = router;

