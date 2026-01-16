const express = require('express');
const router = express.Router();
const publicBookingController = require('../controllers/publicBookingController');

// Public booking routes - no authentication required
// These routes are for customers to book services

// Get available time slots for a service (public)
// GET /api/v1/public-bookings/availability?tenant_id=123&store_id=1&service_id=1&date=2024-01-15
router.get('/availability', publicBookingController.getAvailableTimeSlots);

// Create booking (public - for customers)
// POST /api/v1/public-bookings
router.post('/', publicBookingController.createPublicBooking);

module.exports = router;

