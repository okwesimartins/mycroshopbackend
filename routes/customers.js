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

