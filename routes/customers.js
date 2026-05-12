const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const customerController = require('../controllers/customerController');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get all customers
router.get('/', customerController.getAllCustomers);

// ── Purchase history routes (MUST come before /:id) ─────────────────────────

// Unified customer list from invoices, receipts, and online store orders
// Query: ?source=invoice|receipt|online_store  &page=1 &limit=50 &search=
router.get('/purchase-history', customerController.getPurchaseCustomers);

// All orders for a specific customer across all channels
// Query: ?email=xxx  OR  ?phone=xxx
router.get('/purchase-history/orders', customerController.getCustomerOrderHistory);

// ── Standard CRUD ────────────────────────────────────────────────────────────

// Get customer by ID
router.get('/:id', customerController.getCustomerById);

// Create customer
router.post('/',
  [
    body('name').notEmpty().withMessage('Customer name is required')
  ],
  customerController.createCustomer
);

// Update customer
router.put('/:id', customerController.updateCustomer);

// Delete customer
router.delete('/:id', customerController.deleteCustomer);

// Get customer interactions
router.get('/:id/interactions', customerController.getCustomerInteractions);

// Add customer interaction
router.post('/:id/interactions', customerController.addCustomerInteraction);

// Get customer invoices
router.get('/:id/invoices', customerController.getCustomerInvoices);

module.exports = router;

