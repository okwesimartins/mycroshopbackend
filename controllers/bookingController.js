const { Sequelize } = require('sequelize');
const moment = require('moment');

/**
 * Get all bookings (store-specific or all stores)
 */
async function getAllBookings(req, res) {
  try {
    const { page = 1, limit = 50, status, customer_id, store_id, service_id, start_date, end_date, all_stores } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    
    // Filter by store if store_id provided, unless all_stores is true
    if (store_id && all_stores !== 'true') {
      where.store_id = store_id;
    }
    
    if (status) {
      where.status = status;
    }
    if (customer_id) {
      where.customer_id = customer_id;
    }
    if (service_id) {
      where.service_id = service_id;
    }
    if (start_date || end_date) {
      where.scheduled_at = {};
      if (start_date) where.scheduled_at[Sequelize.Op.gte] = start_date;
      if (end_date) where.scheduled_at[Sequelize.Op.lte] = end_date;
    }

    const { count, rows } = await req.db.models.Booking.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type']
        },
        {
          model: req.db.models.StoreService,
          attributes: ['id', 'service_title', 'duration_minutes']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['scheduled_at', 'ASC']]
    });

    res.json({
      success: true,
      data: {
        bookings: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting bookings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get bookings'
    });
  }
}

/**
 * Get booking by ID
 */
async function getBookingById(req, res) {
  try {
    const booking = await req.db.models.Booking.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state']
        },
        {
          model: req.db.models.StoreService,
          attributes: ['id', 'service_title', 'description', 'duration_minutes', 'price', 'location_type']
        },
        {
          model: req.db.models.Customer
        }
      ]
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    res.json({
      success: true,
      data: { booking }
    });
  } catch (error) {
    console.error('Error getting booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get booking'
    });
  }
}

/**
 * Create booking (Calendly-like, store-specific)
 */
async function createBooking(req, res) {
  try {
    const {
      store_id,
      service_id,
      customer_id,
      customer_name,
      customer_email,
      customer_phone,
      scheduled_at,
      timezone = 'Africa/Lagos',
      location_type = 'in_person',
      meeting_link,
      staff_name,
      notes
    } = req.body;

    if (!store_id || !service_id || !scheduled_at) {
      return res.status(400).json({
        success: false,
        message: 'store_id, service_id, and scheduled_at are required'
      });
    }

    // Verify store exists
    const store = await req.db.models.Store.findByPk(store_id);
    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    // Verify service exists and belongs to store
    const service = await req.db.models.StoreService.findOne({
      where: { id: service_id, store_id, is_active: true }
    });
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found or not available for this store'
      });
    }

    // Check availability (Calendly-like conflict detection)
    const duration = service.duration_minutes || 60;
    const startTime = moment(scheduled_at);
    const endTime = moment(scheduled_at).add(duration, 'minutes');

    // Check for overlapping bookings
    const conflictingBooking = await req.db.models.Booking.findOne({
      where: {
        store_id,
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

    // Get or create customer if customer_id not provided
    let finalCustomerId = customer_id;
    if (!customer_id && (customer_email || customer_phone)) {
      let customer = null;
      if (customer_email) {
        customer = await req.db.models.Customer.findOne({ where: { email: customer_email } });
      }
      if (!customer && customer_phone) {
        customer = await req.db.models.Customer.findOne({ where: { phone: customer_phone } });
      }
      
      // Get tenant to check subscription plan
      const tenantId = req.user?.tenantId;
      const { getTenantById } = require('../config/tenant');
      let tenant = null;
      let isFreePlan = false;
      try {
        tenant = await getTenantById(tenantId);
        isFreePlan = tenant && tenant.subscription_plan === 'free';
      } catch (error) {
        console.warn('Could not fetch tenant:', error);
      }

      if (!customer && customer_name) {
        customer = await req.db.models.Customer.create({
          tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
          name: customer_name,
          email: customer_email || null,
          phone: customer_phone || null
        });
      }
      
      if (customer) {
        finalCustomerId = customer.id;
      }
    }

    // Get tenant info if not already fetched above
    let tenant = null;
    let isFreePlan = false;
    const tenantId = req.user?.tenantId;
    if (tenantId && !tenant) {
      const { getTenantById } = require('../config/tenant');
      try {
        tenant = await getTenantById(tenantId);
        isFreePlan = tenant && tenant.subscription_plan === 'free';
      } catch (error) {
        console.warn('Could not fetch tenant:', error);
      }
    }

    const booking = await req.db.models.Booking.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      store_id,
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
      status: 'pending',
      notes: notes || null
    });

    const completeBooking = await req.db.models.Booking.findByPk(booking.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state']
        },
        {
          model: req.db.models.StoreService,
          attributes: ['id', 'service_title', 'description', 'duration_minutes', 'price']
        },
        {
          model: req.db.models.Customer
        }
      ]
    });

    // Send booking confirmation email
    if (customer_email && tenant) {
      try {
        const { sendBookingConfirmationEmail } = require('../services/emailService');
        await sendBookingConfirmationEmail({
          tenant,
          booking: completeBooking,
          customerEmail: customer_email,
          customerName: customer_name || customer?.name || 'Customer'
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
      message: 'Failed to create booking'
    });
  }
}

/**
 * Update booking
 */
async function updateBooking(req, res) {
  try {
    const booking = await req.db.models.Booking.findByPk(req.params.id);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const {
      customer_id,
      service_type,
      service_name,
      description,
      scheduled_at,
      duration_minutes,
      staff_name,
      notes
    } = req.body;

    await booking.update({
      ...(customer_id !== undefined && { customer_id }),
      ...(service_type !== undefined && { service_type }),
      ...(service_name !== undefined && { service_name }),
      ...(description !== undefined && { description }),
      ...(scheduled_at !== undefined && { scheduled_at }),
      ...(duration_minutes !== undefined && { duration_minutes }),
      ...(staff_name !== undefined && { staff_name }),
      ...(notes !== undefined && { notes })
    });

    const updatedBooking = await req.db.models.Booking.findByPk(booking.id, {
      include: [
        {
          model: req.db.models.Customer
        }
      ]
    });

    res.json({
      success: true,
      message: 'Booking updated successfully',
      data: { booking: updatedBooking }
    });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking'
    });
  }
}

/**
 * Update booking status
 */
async function updateBookingStatus(req, res) {
  try {
    const { status } = req.body;
    
    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const booking = await req.db.models.Booking.findByPk(req.params.id);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    await booking.update({ status });

    res.json({
      success: true,
      message: 'Booking status updated successfully',
      data: { booking }
    });
  } catch (error) {
    console.error('Error updating booking status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking status'
    });
  }
}

/**
 * Delete booking
 */
async function deleteBooking(req, res) {
  try {
    const booking = await req.db.models.Booking.findByPk(req.params.id);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    await booking.destroy();

    res.json({
      success: true,
      message: 'Booking deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete booking'
    });
  }
}

/**
 * Get bookings by date range (for calendar view)
 */
async function getBookingsByDateRange(req, res) {
  try {
    const { store_id, service_id, start_date, end_date } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'Start date and end date are required'
      });
    }

    const where = {
      scheduled_at: {
        [Sequelize.Op.between]: [start_date, end_date]
      }
    };

    if (store_id) {
      where.store_id = store_id;
    }
    if (service_id) {
      where.service_id = service_id;
    }

    const bookings = await req.db.models.Booking.findAll({
      where,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type']
        },
        {
          model: req.db.models.StoreService,
          attributes: ['id', 'service_title', 'duration_minutes']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone']
        }
      ],
      order: [['scheduled_at', 'ASC']]
    });

    res.json({
      success: true,
      data: { bookings }
    });
  } catch (error) {
    console.error('Error getting bookings by date range:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get bookings'
    });
  }
}

/**
 * Get available time slots (Calendly-like availability)
 */
async function getAvailableTimeSlots(req, res) {
  try {
    const { store_id, service_id, date } = req.query;

    if (!store_id || !service_id || !date) {
      return res.status(400).json({
        success: false,
        message: 'store_id, service_id, and date are required'
      });
    }

    // Get service details
    const service = await req.db.models.StoreService.findOne({
      where: { id: service_id, store_id, is_active: true }
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Get availability settings for this store/service
    const availability = await req.db.models.BookingAvailability.findAll({
      where: {
        store_id,
        service_id: service_id,
        is_available: true
      }
    });

    // Get existing bookings for this date
    const startOfDay = moment(date).startOf('day');
    const endOfDay = moment(date).endOf('day');

    const existingBookings = await req.db.models.Booking.findAll({
      where: {
        store_id,
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
          duration_minutes: service.duration_minutes
        },
        date,
        available_slots: availableSlots
      }
    });
  } catch (error) {
    console.error('Error getting available time slots:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get available time slots'
    });
  }
}

module.exports = {
  getAllBookings,
  getBookingById,
  createBooking,
  updateBooking,
  updateBookingStatus,
  deleteBooking,
  getBookingsByDateRange,
  getAvailableTimeSlots
};

