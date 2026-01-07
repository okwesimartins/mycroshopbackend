const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Clock in
router.post('/clock-in', attendanceController.clockIn);

// Clock out
router.post('/clock-out', attendanceController.clockOut);

// Record break
router.post('/break', attendanceController.recordBreak);

// Get attendance records
router.get('/', attendanceController.getStaffAttendance);

// Get currently clocked-in staff
router.get('/clocked-in', attendanceController.getClockedInStaff);

// Get attendance summary
router.get('/summary', attendanceController.getAttendanceSummary);

module.exports = router;

