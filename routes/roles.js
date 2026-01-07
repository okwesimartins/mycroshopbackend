const express = require('express');
const router = express.Router();
const roleController = require('../controllers/roleController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get all roles
router.get('/', roleController.getAllRoles);

// Get all permissions
router.get('/permissions', roleController.getAllPermissions);

// Create role (admin only)
router.post('/', authorize('admin'), roleController.createRole);

// Update role permissions (admin only)
router.put('/:id/permissions', authorize('admin'), roleController.updateRolePermissions);

module.exports = router;

