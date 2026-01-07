const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticate } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Dashboard overview
router.get('/dashboard', reportController.getDashboardOverview);

// Sales report
router.get('/sales', reportController.getSalesReport);

// Product performance report
router.get('/products', reportController.getProductPerformanceReport);

// Customer analytics
router.get('/customers', reportController.getCustomerAnalytics);

module.exports = router;

