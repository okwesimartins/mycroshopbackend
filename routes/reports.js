const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');

// All routes require authentication + tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Dashboard overview
router.get('/dashboard', reportController.getDashboardOverview);

// Dashboard stats (total products, revenue, active orders, recent activity)
router.get('/dashboard/stats', reportController.getDashboardStats);

// Weekly summary card (headline + body + motivation text)
router.get('/dashboard/weekly-summary', reportController.getWeeklySummary);

// Sales report
router.get('/sales', reportController.getSalesReport);

// Product performance report
router.get('/products', reportController.getProductPerformanceReport);

// Customer analytics
router.get('/customers', reportController.getCustomerAnalytics);

module.exports = router;

