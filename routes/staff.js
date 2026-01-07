const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staffController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get all staff
router.get('/', staffController.getAllStaff);

// Get staff by ID
router.get('/:id', staffController.getStaffById);

// Create staff (admin/manager only)
router.post('/', authorize('admin', 'manager'), staffController.createStaff);

// Update staff (admin/manager only)
router.put('/:id', authorize('admin', 'manager'), staffController.updateStaff);

// Delete staff (admin only)
router.delete('/:id', authorize('admin'), staffController.deleteStaff);

module.exports = router;

