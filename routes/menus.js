const express = require('express');
const router = express.Router();
const menuController = require('../controllers/menuController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get all menus
router.get('/', menuController.getAllMenus);

// Create menu (admin/manager only)
router.post('/', authorize('admin', 'manager'), menuController.createMenu);

// Add menu item (admin/manager only)
router.post('/items', authorize('admin', 'manager'), menuController.addMenuItem);

// Update menu item availability
router.patch('/items/:id/availability', authorize('admin', 'manager'), menuController.updateMenuItemAvailability);

module.exports = router;

