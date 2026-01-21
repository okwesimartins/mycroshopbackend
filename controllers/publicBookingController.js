/**
 * Public Booking Controller
 * Handles customer service bookings without authentication
 */

const { getTenantConnection } = require('../config/database');
const { getTenantById } = require('../config/tenant');
const initModels = require('../models');
const { Sequelize } = require('sequelize');
const moment = require('moment');
const { sendBookingConfirmationEmail } = require('../services/emailService');

/**
 * Get available time slots for a service (public)
 * GET /api/v1/public-bookings/availability?tenant_id=123&store_id=1&service_id=1&date=2024-01-15
 */
async function getAvailableTimeSlots(req, res) {
  try {
    const { tenant_id, store_id, service_id, date } = req.query;

    if (!tenant_id || !service_id || !date) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id, service_id, and date are required'
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Determine final store_id
    let finalStoreId = store_id;

    // For free users or when store_id is not provided, try to infer from OnlineStoreService
    if (!finalStoreId) {
      const onlineStoreService = await models.OnlineStoreService.findOne({
        where: { service_id: service_id }
      });

      if (onlineStoreService && onlineStoreService.store_id) {
        finalStoreId = onlineStoreService.store_id;
      }
    }

    if (!finalStoreId) {
      return res.status(400).json({
        success: false,
        message: 'store_id is required or could not be inferred for this service'
      });
    }

    // Get service details
    const service = await models.StoreService.findOne({
      where: { id: service_id, store_id: finalStoreId, is_active: true }
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Get availability settings for this store/service
    const availability = await models.BookingAvailability.findAll({
      where: {
        store_id: finalStoreId,
        service_id: service_id,
        is_available: true
      }
    });

    // Get existing bookings for this date
    const startOfDay = moment(date).startOf('day');
    const endOfDay = moment(date).endOf('day');

    const existingBookings = await models.Booking.findAll({
      where: {
        store_id: finalStoreId,
        service_id,
        scheduled_at: {
          [Sequelize.Op.between]: [startOfDay.toDate(), endOfDay.toDate()]
        },
        status: {
          [Sequelize.Op.in]: ['pending', 'confirmed']
        }
      }
    });

    // Get day of week (0 = Sunday, 1 = Monday, etc.)
    const dayOfWeek = moment(date).day();
    const dayAvailability = availability.filter(a => a.day_of_week === dayOfWeek);

    // Generate available time slots
    const availableSlots = [];
    const duration = service.duration_minutes || 60;

    for (const avail of dayAvailability) {
      const startTime = moment(`${date} ${avail.start_time}`, 'YYYY-MM-DD HH:mm:ss');
      const endTime = moment(`${date} ${avail.end_time}`, 'YYYY-MM-DD HH:mm:ss');

      let currentSlot = moment(startTime);
      while (currentSlot.add(duration, 'minutes').isBefore(endTime) || currentSlot.isSame(endTime)) {
        const slotStart = moment(currentSlot).subtract(duration, 'minutes');
        const slotEnd = moment(currentSlot);

        // Check if this slot conflicts with existing bookings
        const hasConflict = existingBookings.some(booking => {
          const bookingStart = moment(booking.scheduled_at);
          const bookingEnd = moment(booking.scheduled_at).add(booking.duration_minutes, 'minutes');
          return (slotStart.isBefore(bookingEnd) && slotEnd.isAfter(bookingStart));
        });

        if (!hasConflict) {
          availableSlots.push({
            start_time: slotStart.format('YYYY-MM-DD HH:mm:ss'),
            end_time: slotEnd.format('YYYY-MM-DD HH:mm:ss'),
            duration_minutes: duration
          });
        }
      }
    }

    res.json({
      success: true,
      data: {
        service: {
          id: service.id,
          service_title: service.service_title,
          duration_minutes: service.duration_minutes,
          price: service.price
        },
        date,
        available_slots: availableSlots
      }
    });
  } catch (error) {
    console.error('Error getting available time slots:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get available time slots',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Create booking (public - for customers)
 * POST /api/v1/public-bookings
 */
async function createPublicBooking(req, res) {
  try {
    const {
      tenant_id, // Required - to identify which tenant database
      store_id,
      service_id,
      customer_name,
      customer_email,
      customer_phone,
      scheduled_at,
      timezone = 'Africa/Lagos',
      location_type = 'in_person',
      meeting_link,
      staff_name,
      notes,
      payment_transaction_id, // Payment transaction ID (required for paid services)
      payment_reference // Payment reference from gateway (alternative to transaction_id)
    } = req.body;

    if (!tenant_id || !service_id || !scheduled_at) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id, service_id, and scheduled_at are required'
      });
    }

    if (!customer_name || !customer_email) {
      return res.status(400).json({
        success: false,
        message: 'customer_name and customer_email are required'
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Determine final store_id (for free users, store_id may not be provided)
    let finalStoreId = store_id;

    // Check if this is an online store booking (only online store bookings require payment)
    const onlineStoreService = await models.OnlineStoreService.findOne({
      where: { service_id: service_id }
    });

    const isOnlineStoreBooking = !!onlineStoreService;

    // If store_id is not provided (common for free users), try to infer from OnlineStoreService
    if (!finalStoreId && onlineStoreService && onlineStoreService.store_id) {
      finalStoreId = onlineStoreService.store_id;
    }

    if (!finalStoreId) {
      return res.status(400).json({
        success: false,
        message: 'store_id is required or could not be inferred for this service'
      });
    }

    // Verify store exists
    const store = await models.Store.findByPk(finalStoreId);
    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    // Verify service exists and belongs to store
    const service = await models.StoreService.findOne({
      where: { id: service_id, store_id: finalStoreId, is_active: true }
    });
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found or not available for this store'
      });
    }

    const servicePrice = parseFloat(service.price || 0);

    // Only online store bookings require payment
    if (isOnlineStoreBooking && servicePrice > 0) {
      // Online store booking requires payment - verify payment was made
      if (!payment_transaction_id && !payment_reference) {
        return res.status(400).json({
          success: false,
          message: 'Payment is required for online store bookings. Please initialize payment first and provide payment_transaction_id or payment_reference.'
        });
      }

      // Verify payment transaction exists and is successful
      if (payment_transaction_id) {
        const paymentTransaction = await models.PaymentTransaction.findByPk(payment_transaction_id);
        if (!paymentTransaction || paymentTransaction.status !== 'success') {
          return res.status(400).json({
            success: false,
            message: 'Invalid or unsuccessful payment transaction. Please complete payment first.'
          });
        }
      } else if (payment_reference) {
        const paymentTransaction = await models.PaymentTransaction.findOne({
          where: { transaction_reference: payment_reference }
        });
        if (!paymentTransaction || paymentTransaction.status !== 'success') {
          return res.status(400).json({
            success: false,
            message: 'Invalid or unsuccessful payment. Please complete payment first.'
          });
        }
      }
    }

    // Check availability (Calendly-like conflict detection)
    const duration = service.duration_minutes || 60;
    const startTime = moment(scheduled_at);
    const endTime = moment(scheduled_at).add(duration, 'minutes');

    // Check for overlapping bookings
    const conflictingBooking = await models.Booking.findOne({
      where: {
        store_id: finalStoreId,
        service_id,
        scheduled_at: {
          [Sequelize.Op.between]: [startTime.toDate(), endTime.toDate()]
        },
        status: {
          [Sequelize.Op.in]: ['pending', 'confirmed']
        }
      }
    });

    if (conflictingBooking) {
      return res.status(409).json({
        success: false,
        message: 'Time slot already booked'
      });
    }

    // Get or create customer
    let customer = null;
    let finalCustomerId = null;

    if (customer_email) {
      customer = await models.Customer.findOne({ where: { email: customer_email } });
    }
    if (!customer && customer_phone) {
      customer = await models.Customer.findOne({ where: { phone: customer_phone } });
    }

    const isFreePlan = tenant.subscription_plan === 'free';
    const orderTenantId = isFreePlan ? tenant_id : null;

    if (!customer && customer_name) {
      customer = await models.Customer.create({
        tenant_id: orderTenantId,
        name: customer_name,
        email: customer_email || null,
        phone: customer_phone || null
      });
    }

    if (customer) {
      finalCustomerId = customer.id;
    }

    // Create booking
    const booking = await models.Booking.create({
      tenant_id: orderTenantId,
      store_id: finalStoreId,
      service_id,
      customer_id: finalCustomerId,
      customer_name: customer_name || null,
      customer_email: customer_email || null,
      customer_phone: customer_phone || null,
      service_title: service.service_title,
      description: service.description || null,
      scheduled_at,
      duration_minutes: duration,
      timezone,
      location_type: location_type || service.location_type,
      meeting_link: meeting_link || null,
      staff_name: staff_name || null,
      status: (isOnlineStoreBooking && servicePrice > 0) ? 'confirmed' : 'pending', // Auto-confirm if online store booking with payment
      payment_transaction_id: (isOnlineStoreBooking && servicePrice > 0) ? (payment_transaction_id || null) : null,
      notes: notes || null
    });

    const completeBooking = await models.Booking.findByPk(booking.id, {
      include: [
        {
          model: models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state', 'phone', 'email']
        },
        {
          model: models.StoreService,
          attributes: ['id', 'service_title', 'description', 'duration_minutes', 'price']
        },
        {
          model: models.Customer,
          required: false
        }
      ]
    });

    // Send booking confirmation email
    if (customer_email) {
      try {
        await sendBookingConfirmationEmail({
          tenant,
          booking: completeBooking,
          customerEmail: customer_email,
          customerName: customer_name
        });
      } catch (emailError) {
        console.error('Error sending booking confirmation email:', emailError);
        // Don't fail the booking creation if email fails
      }
    }

    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      data: { booking: completeBooking }
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  getAvailableTimeSlots,
  createPublicBooking
};

