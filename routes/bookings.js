const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const bookingController = require('../controllers/bookingController');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get all bookings
router.get('/', bookingController.getAllBookings);

// Get booking by ID
router.get('/:id', bookingController.getBookingById);

// Create booking
router.post('/',
  [
    body('store_id').notEmpty().withMessage('Store ID is required'),
    body('service_id').notEmpty().withMessage('Service ID is required'),
    body('scheduled_at').notEmpty().withMessage('Scheduled date/time is required')
  ],
  bookingController.createBooking
);

// Update booking
router.put('/:id', bookingController.updateBooking);

// Update booking status
router.patch('/:id/status', bookingController.updateBookingStatus);

// Delete booking
router.delete('/:id', bookingController.deleteBooking);

// Get bookings by date range
router.get('/calendar/range', bookingController.getBookingsByDateRange);

// Get available time slots (Calendly-like)
router.get('/availability', bookingController.getAvailableTimeSlots);

module.exports = router;

