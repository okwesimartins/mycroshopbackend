const express = require('express');
const router = express.Router();
const staffAnalyticsController = require('../controllers/staffAnalyticsController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get comprehensive staff analytics
router.get('/', authorize('admin', 'manager'), staffAnalyticsController.getStaffAnalytics);

// Get individual staff member analytics
router.get('/staff/:staff_id', authorize('admin', 'manager'), staffAnalyticsController.getStaffMemberAnalytics);

// Get attendance summary by period
router.get('/summary', authorize('admin', 'manager'), staffAnalyticsController.getAttendanceSummary);

// Get top performers
router.get('/top-performers', authorize('admin', 'manager'), staffAnalyticsController.getTopPerformers);

// Get attendance trends
router.get('/trends', authorize('admin', 'manager'), staffAnalyticsController.getAttendanceTrends);

module.exports = router;

