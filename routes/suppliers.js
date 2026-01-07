const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplierController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get all suppliers
router.get('/', supplierController.getAllSuppliers);

// Get supplier by ID
router.get('/:id', supplierController.getSupplierById);

// Create supplier (admin/manager only)
router.post('/', authorize('admin', 'manager'), supplierController.createSupplier);

// Update supplier (admin/manager only)
router.put('/:id', authorize('admin', 'manager'), supplierController.updateSupplier);

// Delete supplier (admin only)
router.delete('/:id', authorize('admin'), supplierController.deleteSupplier);

module.exports = router;

