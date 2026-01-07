const { Sequelize } = require('sequelize');
const path = require('path');
const fs = require('fs');
const initModels = require('../models');

/**
 * Helper function to generate full URL from relative path
 */
function getFullUrl(req, relativePath) {
  if (!relativePath) return null;
  const protocol = req.protocol || 'https';
  const host = req.get('host') || 'backend.mycroshop.com';
  // Remove leading slash if present to avoid double slashes
  const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `${protocol}://${host}${cleanPath}`;
}

/**
 * Helper function to normalize service data for API responses
 * - Parses availability from string to object/array if needed
 */
function normalizeServiceData(service) {
  if (!service) return service;
  
  // Convert Sequelize instance to plain object if needed
  const serviceData = service.toJSON ? service.toJSON() : service;
  
  // Parse availability if it's a string
  if (serviceData.availability) {
    if (typeof serviceData.availability === 'string') {
      try {
        serviceData.availability = JSON.parse(serviceData.availability);
      } catch (e) {
        // If parsing fails, set to null
        console.error('Error parsing availability:', e);
        serviceData.availability = null;
      }
    }
  } else {
    serviceData.availability = null;
  }
  
  return serviceData;
}

/**
 * Helper function to normalize multiple services
 */
function normalizeServicesData(services) {
  if (!services || !Array.isArray(services)) return services;
  return services.map(service => normalizeServiceData(service));
}

/**
 * Get all store services (for a specific store or all stores)
 * Includes services from physical stores and services linked to online stores
 */
async function getAllStoreServices(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const { page = 1, limit = 50, store_id, isActive, all_stores, include_online_services } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    
    // Filter by store if store_id provided, unless all_stores is true
    if (store_id && all_stores !== 'true') {
      where.store_id = store_id;
    }
    
    if (isActive !== undefined) {
      where.is_active = isActive === 'true';
    }

    const { count, rows } = await models.StoreService.findAndCountAll({
      where,
      include: [
        {
          model: models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state'],
          required: false
        },
        // Include online store links if requested
        ...(include_online_services === 'true' ? [{
          model: models.OnlineStoreService,
          as: 'OnlineStoreServices', // Association alias
          required: false,
          include: [{
            model: models.OnlineStore,
            attributes: ['id', 'username', 'store_name'],
            required: false
          }]
        }] : [])
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['sort_order', 'ASC'], ['created_at', 'DESC']],
      distinct: true // Important for count with multiple associations
    });

    // Normalize services data (parse availability from string to JSON)
    const normalizedServices = normalizeServicesData(rows);

    // Add online store information if included
    const servicesWithOnlineInfo = normalizedServices.map(service => {
      const serviceData = { ...service };
      if (include_online_services === 'true' && service.OnlineStoreServices && service.OnlineStoreServices.length > 0) {
        serviceData.linked_online_stores = service.OnlineStoreServices.map(oss => ({
          online_store_id: oss.online_store_id,
          online_store_name: oss.OnlineStore ? oss.OnlineStore.store_name : null,
          is_visible: oss.is_visible,
          sort_order: oss.sort_order
        }));
        // Remove the raw association data
        delete serviceData.OnlineStoreServices;
      }
      return serviceData;
    });

    res.json({
      success: true,
      data: {
        services: servicesWithOnlineInfo,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting store services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store services',
      error: error.message
    });
  }
}

/**
 * Get store service by ID
 */
async function getStoreServiceById(req, res) {
  try {
    const service = await req.db.models.StoreService.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state']
        }
      ]
    });
    
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Store service not found'
      });
    }

    const normalizedService = normalizeServiceData(service);
    res.json({
      success: true,
      data: { service: normalizedService }
    });
  } catch (error) {
    console.error('Error getting store service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store service'
    });
  }
}

/**
 * Create store service (tied to physical store)
 * Supports both file upload (service_image) and service_image_url
 * Supports both form-data and raw JSON
 */
async function createStoreService(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const {
      store_id,
      online_store_id, // Optional: auto-link service to online store
      service_title,
      description,
      price,
      service_image_url,
      duration_minutes,
      location_type,
      availability,
      sort_order,
      is_visible // Optional: visibility in online store (defaults to true)
    } = req.body;

    if (!store_id || !service_title) {
      // Delete uploaded file on validation error
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        message: 'store_id and service_title are required'
      });
    }

    // Get tenant to check subscription plan
    const tenantId = req.user.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // Determine service image URL: prioritize uploaded file over URL
    let finalServiceImageUrl = null;
    if (req.file) {
      // File was uploaded via multer
      finalServiceImageUrl = `/uploads/services/${req.file.filename}`;
    } else if (service_image_url) {
      // Use provided URL
      finalServiceImageUrl = service_image_url;
    }

    // Parse availability if it comes as a string (from form-data)
    let parsedAvailability = null;
    if (availability !== undefined && availability !== null && availability !== '') {
      if (typeof availability === 'string') {
        try {
          // Trim whitespace and parse JSON string
          const trimmedAvailability = availability.trim();
          parsedAvailability = JSON.parse(trimmedAvailability);
        } catch (parseError) {
          // Delete uploaded file on parse error
          if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
          console.error('Error parsing availability JSON:', parseError);
          return res.status(400).json({
            success: false,
            message: 'Invalid availability format. Must be valid JSON.',
            error: parseError.message
          });
        }
      } else if (typeof availability === 'object') {
        // Already an object (from raw JSON)
        parsedAvailability = availability;
      }
    }

    // Verify store exists
    const store = await models.Store.findByPk(store_id);
    if (!store) {
      // Delete uploaded file on error
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    // Check for duplicate service title within this store (case-insensitive)
    const existingService = await models.StoreService.findOne({
      where: {
        store_id,
        service_title: Sequelize.where(
          Sequelize.fn('LOWER', Sequelize.col('service_title')),
          service_title.toLowerCase()
        )
      }
    });

    if (existingService) {
      // Delete uploaded file on duplicate error
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(409).json({
        success: false,
        message: `A service with the title "${service_title}" already exists for this store`
      });
    }

    // Handle smart sort order: determine target sort_order
    let serviceSortOrder;
    if (sort_order !== undefined && sort_order !== null) {
      serviceSortOrder = parseInt(sort_order) || 1;
    } else {
      // No sort_order specified - get max for this store or use 1
      const maxSortOrder = await models.StoreService.max('sort_order', {
        where: store_id ? { store_id } : {}
      });
      serviceSortOrder = (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) 
        ? 1 
        : (parseInt(maxSortOrder) || 0) + 1;
    }

    const service = await models.StoreService.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      store_id,
      service_title,
      description: description || null,
      price: price || 0.00,
      service_image_url: finalServiceImageUrl,
      duration_minutes: duration_minutes || 30,
      location_type: location_type || 'in_person',
      availability: parsedAvailability || null,
      is_active: true,
      sort_order: serviceSortOrder
    });

    const completeService = await models.StoreService.findByPk(service.id, {
      include: [
        {
          model: models.Store,
          required: false
        }
      ]
    });

    // Optionally link service to online store if online_store_id provided
    let onlineStoreService = null;
    if (online_store_id) {
      // Verify online store exists
      const onlineStore = await models.OnlineStore.findByPk(online_store_id);
      if (!onlineStore) {
        // Delete uploaded file and service on error
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        await service.destroy();
        return res.status(404).json({
          success: false,
          message: 'Online store not found'
        });
      }

      // Check if service is already linked to this online store
      const existingLink = await models.OnlineStoreService.findOne({
        where: {
          online_store_id,
          service_id: service.id
        }
      });

      if (!existingLink) {
        // Handle smart sort_order: determine target sort_order and rearrange existing services
        let finalSortOrder;
        if (sort_order !== undefined && sort_order !== null) {
          // User specified a sort_order - use smart rearrangement
          finalSortOrder = parseInt(sort_order) || 1;
          
          // Find all existing OnlineStoreService entries for this online store with sort_order >= targetSortOrder
          const existingServicesToShift = await models.OnlineStoreService.findAll({
            where: {
              online_store_id,
              sort_order: {
                [Sequelize.Op.gte]: finalSortOrder
              }
            },
            order: [['sort_order', 'DESC']] // Start from highest to avoid conflicts
          });

          // Increment sort_order for all services that need to be shifted
          if (existingServicesToShift.length > 0) {
            for (const existingService of existingServicesToShift) {
              await existingService.update({
                sort_order: (parseInt(existingService.sort_order) || 0) + 1
              });
            }
          }
        } else {
          // If no sort_order provided, append at the end (max + 1) or use 1 if no records exist
          const maxSortOrder = await models.OnlineStoreService.max('sort_order', {
            where: { online_store_id }
          });
          
          if (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) {
            finalSortOrder = 1; // First service
          } else {
            finalSortOrder = (parseInt(maxSortOrder) || 0) + 1; // Append at end
          }
        }

        // Create link between service and online store
        onlineStoreService = await models.OnlineStoreService.create({
          tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
          online_store_id,
          service_id: service.id,
          is_visible: is_visible !== undefined ? is_visible : true,
          sort_order: finalSortOrder
        });
      } else {
        onlineStoreService = existingLink;
      }
    }

    const normalizedService = normalizeServiceData(completeService);
    
    // Convert service_image_url to full URL if it's a relative path
    if (normalizedService.service_image_url && normalizedService.service_image_url.startsWith('/uploads/')) {
      normalizedService.service_image_url = getFullUrl(req, normalizedService.service_image_url);
    }

    const responseData = {
      service: normalizedService
    };

    if (onlineStoreService) {
      responseData.online_store_service = onlineStoreService;
    }

    res.status(201).json({
      success: true,
      message: onlineStoreService 
        ? 'Store service created and linked to online store successfully' 
        : 'Store service created successfully',
      data: responseData
    });
  } catch (error) {
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error creating store service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create store service',
      error: error.message
    });
  }
}

/**
 * Update store service
 * Supports both file upload (service_image) and service_image_url
 * Supports both form-data and raw JSON
 */
async function updateStoreService(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const service = await models.StoreService.findByPk(req.params.id);
    
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Store service not found'
      });
    }

    const {
      service_title,
      description,
      price,
      service_image_url,
      duration_minutes,
      location_type,
      availability,
      is_active,
      sort_order
    } = req.body;

    // Determine service image URL: prioritize uploaded file over URL
    let finalServiceImageUrl = undefined;
    if (req.file) {
      // File was uploaded via multer - delete old image first
      if (service.service_image_url) {
        const oldImagePath = path.join(__dirname, '../', service.service_image_url);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
      finalServiceImageUrl = `/uploads/services/${req.file.filename}`;
    } else if (service_image_url !== undefined) {
      // Use provided URL (or null if explicitly set to null)
      finalServiceImageUrl = service_image_url;
    }

    // Parse availability if it comes as a string (from form-data)
    let parsedAvailability = undefined;
    if (availability !== undefined && availability !== null && availability !== '') {
      if (typeof availability === 'string') {
        try {
          // Trim whitespace and parse JSON string
          const trimmedAvailability = availability.trim();
          parsedAvailability = JSON.parse(trimmedAvailability);
        } catch (parseError) {
          console.error('Error parsing availability JSON:', parseError);
          return res.status(400).json({
            success: false,
            message: 'Invalid availability format. Must be valid JSON.',
            error: parseError.message
          });
        }
      } else if (typeof availability === 'object') {
        // Already an object (from raw JSON)
        parsedAvailability = availability;
      }
    } else if (availability === null || availability === '') {
      // Explicitly set to null
      parsedAvailability = null;
    }

    // Handle smart sort_order rearrangement if sort_order is being updated
    // Check if service is linked to any online stores
    if (sort_order !== undefined && sort_order !== service.sort_order) {
      const oldSortOrder = service.sort_order;
      const newSortOrder = sort_order;

      // Find all OnlineStoreService entries linked to this service
      const onlineStoreServices = await models.OnlineStoreService.findAll({
        where: { service_id: service.id }
      });

      // For each online store link, rearrange sort orders independently
      for (const onlineStoreService of onlineStoreServices) {
        const online_store_id = onlineStoreService.online_store_id;
        const oldLinkSortOrder = onlineStoreService.sort_order;

        // Only rearrange if the sort_order is actually changing for this online store
        if (newSortOrder !== oldLinkSortOrder) {
          if (newSortOrder > oldLinkSortOrder) {
            // Moving down: shift services between old and new position up
            const servicesToShift = await models.OnlineStoreService.findAll({
              where: {
                online_store_id,
                service_id: { [Sequelize.Op.ne]: service.id },
                sort_order: {
                  [Sequelize.Op.gt]: oldLinkSortOrder,
                  [Sequelize.Op.lte]: newSortOrder
                }
              },
              order: [['sort_order', 'ASC']]
            });

            for (const svc of servicesToShift) {
              await svc.update({ sort_order: svc.sort_order - 1 });
            }
          } else if (newSortOrder < oldLinkSortOrder) {
            // Moving up: shift services between new and old position down
            const servicesToShift = await models.OnlineStoreService.findAll({
              where: {
                online_store_id,
                service_id: { [Sequelize.Op.ne]: service.id },
                sort_order: {
                  [Sequelize.Op.gte]: newSortOrder,
                  [Sequelize.Op.lt]: oldLinkSortOrder
                }
              },
              order: [['sort_order', 'DESC']]
            });

            for (const svc of servicesToShift) {
              await svc.update({ sort_order: svc.sort_order + 1 });
            }
          }

          // Update the OnlineStoreService sort_order
          await onlineStoreService.update({ sort_order: newSortOrder });
        }
      }
    }

    const updateData = {};
    if (service_title !== undefined) updateData.service_title = service_title;
    if (description !== undefined) updateData.description = description;
    if (price !== undefined) updateData.price = price;
    if (finalServiceImageUrl !== undefined) updateData.service_image_url = finalServiceImageUrl;
    if (duration_minutes !== undefined) updateData.duration_minutes = duration_minutes;
    if (location_type !== undefined) updateData.location_type = location_type;
    if (parsedAvailability !== undefined) updateData.availability = parsedAvailability;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (sort_order !== undefined) updateData.sort_order = sort_order;

    await service.update(updateData);

    const updatedService = await models.StoreService.findByPk(service.id, {
      include: [
        {
          model: models.Store,
          required: false
        }
      ]
    });

    const normalizedService = normalizeServiceData(updatedService);
    
    // Convert service_image_url to full URL if it's a relative path
    if (normalizedService.service_image_url && normalizedService.service_image_url.startsWith('/uploads/')) {
      normalizedService.service_image_url = getFullUrl(req, normalizedService.service_image_url);
    }

    res.json({
      success: true,
      message: 'Store service updated successfully',
      data: { service: normalizedService }
    });
  } catch (error) {
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error updating store service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update store service',
      error: error.message
    });
  }
}

/**
 * Delete store service
 */
async function deleteStoreService(req, res) {
  try {
    const service = await req.db.models.StoreService.findByPk(req.params.id);
    
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Store service not found'
      });
    }

    // Check if service has bookings
    const bookingCount = await req.db.models.Booking.count({
      where: { service_id: service.id }
    });

    if (bookingCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete service with ${bookingCount} booking(s). Please cancel or complete bookings first.`
      });
    }

    await service.destroy();

    res.json({
      success: true,
      message: 'Store service deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting store service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete store service'
    });
  }
}

/**
 * Set availability for a store service (Calendly-like)
 */
async function setServiceAvailability(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const { service_id } = req.params;
    const numericServiceId = parseInt(service_id, 10);
    const { availability_slots } = req.body; // Array of { day_of_week, start_time, end_time, is_available, max_bookings_per_slot }

    if (!numericServiceId || isNaN(numericServiceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid service_id'
      });
    }

    const service = await models.StoreService.findByPk(numericServiceId);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Store service not found'
      });
    }

    // Get tenant to check if free user (store_id can be null)
    const tenantId = req.user.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // Delete existing availability for this service
    await models.BookingAvailability.destroy({
      where: { service_id: numericServiceId }
    });

    // For free users, store_id can be null (they don't have physical stores)
    // For enterprise users, we should have a store_id, but allow null for flexibility
    const storeId = isFreePlan ? null : (service.store_id || null);

    // Create new availability slots
    const created = [];
    for (const slot of availability_slots) {
      const availability = await models.BookingAvailability.create({
        store_id: storeId, // null for free users, service.store_id for enterprise
        service_id: numericServiceId,
        day_of_week: slot.day_of_week,
        start_time: slot.start_time,
        end_time: slot.end_time,
        is_available: slot.is_available !== false,
        max_bookings_per_slot: slot.max_bookings_per_slot || 1
      });
      created.push(availability);
    }

    res.json({
      success: true,
      message: 'Service availability updated successfully',
      data: { availability_slots: created }
    });
  } catch (error) {
    console.error('Error setting service availability:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set service availability',
      error: error.message
    });
  }
}

/**
 * Get availability for a store service
 */
async function getServiceAvailability(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const { service_id } = req.params;
    const numericServiceId = parseInt(service_id, 10);

    if (!numericServiceId || isNaN(numericServiceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid service_id'
      });
    }

    const service = await models.StoreService.findByPk(numericServiceId);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Store service not found'
      });
    }

    // Try to get availability from BookingAvailability table (time slots)
    let bookingAvailability = await models.BookingAvailability.findAll({
      where: { service_id: numericServiceId },
      order: [['day_of_week', 'ASC'], ['start_time', 'ASC']]
    });

    // If no BookingAvailability records found, check if availability is stored in StoreService.availability JSON field
    if (bookingAvailability.length === 0) {
      // Return the availability from the JSON field as fallback
      const serviceData = normalizeServiceData(service);
      const jsonAvailability = serviceData.availability;
      
      res.json({
        success: true,
        data: {
          service: {
            id: service.id,
            service_title: service.service_title
          },
          availability: jsonAvailability || null,
          availability_type: jsonAvailability ? 'json_field' : 'none',
          message: jsonAvailability 
            ? 'Using availability from service JSON field' 
            : 'No availability records found. Use POST /availability to set time slots.'
        }
      });
      return;
    }

    res.json({
      success: true,
      data: {
        service: {
          id: service.id,
          service_title: service.service_title
        },
        availability: bookingAvailability,
        availability_type: 'booking_slots'
      }
    });
  } catch (error) {
    console.error('Error getting service availability:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get service availability',
      error: error.message
    });
  }
}

/**
 * Get all services for an online store (matches Figma flow)
 */
async function getOnlineStoreServices(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const { online_store_id } = req.params;
    const { isActive } = req.query;

    // Verify online store exists
    const onlineStore = await models.OnlineStore.findByPk(online_store_id);
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // Get services linked to this online store via OnlineStoreService
    const onlineStoreServices = await models.OnlineStoreService.findAll({
      where: { online_store_id },
      include: [
        {
          model: models.StoreService,
          where: isActive !== undefined ? { is_active: isActive === 'true' } : {},
          required: false,
          include: [
            {
              model: models.Store,
              attributes: ['id', 'name', 'store_type'],
              required: false
            }
          ]
        }
      ],
      order: [['sort_order', 'ASC']]
    });

    const services = onlineStoreServices
      .filter(oss => oss.StoreService) // Filter out null services
      .map(oss => {
        const serviceData = normalizeServiceData(oss.StoreService);
        return {
          ...serviceData,
          is_visible: oss.is_visible,
          sort_order: oss.sort_order,
          online_store_service_id: oss.id
        };
      });

    res.json({
      success: true,
      data: {
        services,
        total: services.length
      }
    });
  } catch (error) {
    console.error('Error getting online store services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get online store services'
    });
  }
}

/**
 * Create service for online store (works for free users - no physical store required)
 * Matches Figma flow: POST /api/v1/stores/online/:online_store_id/services
 * Supports both file upload and service_image_url
 */
async function createOnlineStoreService(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const { online_store_id } = req.params;
    const {
      store_id, // Optional - for enterprise users with physical stores
      service_title,
      description,
      price,
      service_image_url,
      duration_minutes,
      location_type,
      availability,
      sort_order,
      is_visible
    } = req.body;

      // Determine service image URL: prioritize uploaded file over URL
      let finalServiceImageUrl = null;
      if (req.file) {
        // File was uploaded via multer
        finalServiceImageUrl = `/uploads/services/${req.file.filename}`;
      } else if (service_image_url) {
        // Use provided URL
        finalServiceImageUrl = service_image_url;
      }

      // Parse availability if it comes as a string (from form-data)
      let parsedAvailability = null;
      if (availability !== undefined && availability !== null && availability !== '') {
        if (typeof availability === 'string') {
          try {
            // Trim whitespace and parse JSON string
            const trimmedAvailability = availability.trim();
            parsedAvailability = JSON.parse(trimmedAvailability);
          } catch (parseError) {
            console.error('Error parsing availability JSON:', parseError);
            return res.status(400).json({
              success: false,
              message: 'Invalid availability format. Must be valid JSON.',
              error: parseError.message
            });
          }
        } else if (typeof availability === 'object') {
          // Already an object (from raw JSON)
          parsedAvailability = availability;
        }
      }

      if (!service_title) {
      return res.status(400).json({
        success: false,
        message: 'service_title is required'
      });
    }

    // Verify online store exists
    const onlineStore = await models.OnlineStore.findByPk(online_store_id);
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // Check for duplicate service title within this online store
    // Find all services already linked to this online store
    const existingOnlineStoreServices = await models.OnlineStoreService.findAll({
      where: { online_store_id },
      include: [
        {
          model: models.StoreService,
          attributes: ['id', 'service_title']
        }
      ]
    });

    // Check if a service with the same title already exists for this online store
    const duplicateService = existingOnlineStoreServices.find(
      oss => oss.StoreService && 
             oss.StoreService.service_title.toLowerCase() === service_title.toLowerCase()
    );

    if (duplicateService) {
      return res.status(409).json({
        success: false,
        message: `A service with the title "${service_title}" already exists for this online store`
      });
    }

    // Get tenant to check subscription plan
    const tenantId = req.user.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // For free users, store_id is optional (they don't have physical stores)
    // For enterprise users, store_id can be provided to link to physical store
    // Only validate physical store for enterprise users
    if (store_id && !isFreePlan) {
      // Enterprise users: validate physical store exists
      const physicalStore = await models.Store.findByPk(store_id);
      if (!physicalStore) {
        return res.status(404).json({
          success: false,
          message: 'Physical store not found'
        });
      }
    } else if (store_id && isFreePlan) {
      // Free users: ignore store_id if provided (they don't have physical stores)
      console.warn('Free user provided store_id, ignoring it');
    } else if (!store_id && tenant && tenant.subscription_plan === 'enterprise') {
      // Enterprise users should provide store_id, but we'll allow null for flexibility
      console.warn('Enterprise user creating service without store_id');
    }

    // Handle smart sort order: determine target sort_order and rearrange existing services
    let targetSortOrder;
    if (sort_order !== undefined && sort_order !== null) {
      // User specified a sort_order - use smart rearrangement
      targetSortOrder = parseInt(sort_order) || 1;
      
      // Find all existing OnlineStoreService entries for this online store with sort_order >= targetSortOrder
      const existingServicesToShift = await models.OnlineStoreService.findAll({
        where: {
          online_store_id,
          sort_order: {
            [Sequelize.Op.gte]: targetSortOrder
          }
        },
        order: [['sort_order', 'DESC']] // Start from highest to avoid conflicts
      });

      // Increment sort_order for all services that need to be shifted
      if (existingServicesToShift.length > 0) {
        for (const existingService of existingServicesToShift) {
          await existingService.update({
            sort_order: (parseInt(existingService.sort_order) || 0) + 1
          });
        }
      }
    } else {
      // No sort_order specified - append at the end (max + 1) or use 1 if no records exist
      const maxSortOrder = await models.OnlineStoreService.max('sort_order', {
        where: { online_store_id }
      });
      
      if (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) {
        targetSortOrder = 1; // First service
      } else {
        targetSortOrder = (parseInt(maxSortOrder) || 0) + 1; // Append at end
      }
    }

    // Create the service (store_id is null for free users, optional for enterprise)
    const service = await models.StoreService.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      store_id: isFreePlan ? null : (store_id || null), // Always null for free users
      service_title,
      description: description || null,
      price: price || 0.00,
      service_image_url: finalServiceImageUrl, // Use uploaded file or provided URL
      duration_minutes: duration_minutes || 30,
      location_type: location_type || 'in_person',
      availability: parsedAvailability, // Use parsed availability (object from string or already object)
      is_active: true,
      sort_order: targetSortOrder
    });

    // Link service to online store via OnlineStoreService
    const onlineStoreService = await models.OnlineStoreService.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      online_store_id,
      service_id: service.id,
      is_visible: is_visible !== undefined ? is_visible : true,
      sort_order: targetSortOrder
    });

    // Fetch complete service with relations
    const completeService = await models.StoreService.findByPk(service.id, {
      include: [
        {
          model: models.Store,
          required: false,
          attributes: ['id', 'name', 'store_type']
        }
      ]
    });

    const normalizedService = normalizeServiceData(completeService);
    
    // Convert service_image_url to full URL if it's a relative path
    if (normalizedService.service_image_url && normalizedService.service_image_url.startsWith('/uploads/')) {
      normalizedService.service_image_url = getFullUrl(req, normalizedService.service_image_url);
    }

    res.status(201).json({
      success: true,
      message: 'Service created and linked to online store successfully',
      data: {
        service: normalizedService,
        online_store_service: onlineStoreService
      }
    });
  } catch (error) {
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error creating online store service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create online store service',
      error: error.message
    });
  }
}

/**
 * Upload service image
 * Separate endpoint for uploading/updating service image
 */
async function uploadServiceImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    if (!req.db) {
      // Delete uploaded file if DB connection not available
      fs.unlinkSync(req.file.path);
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const { service_id } = req.params;
    const numericServiceId = parseInt(service_id, 10);

    if (!numericServiceId || isNaN(numericServiceId)) {
      // Delete uploaded file if service_id is invalid
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        message: 'Invalid service_id'
      });
    }

    const service = await models.StoreService.findByPk(numericServiceId);
    
    if (!service) {
      // Delete uploaded file if service not found
      fs.unlinkSync(req.file.path);
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Delete old image if exists
    if (service.service_image_url) {
      const oldImagePath = path.join(__dirname, '../', service.service_image_url);
      if (fs.existsSync(oldImagePath)) {
        fs.unlinkSync(oldImagePath);
      }
    }

    // Update with new image URL
    const relativeImageUrl = `/uploads/services/${req.file.filename}`;
    await service.update({
      service_image_url: relativeImageUrl
    });

    // Refresh the service
    await service.reload();
    
    // Normalize the service data
    const normalizedService = normalizeServiceData(service);
    
    // Convert to full URL
    normalizedService.service_image_url = getFullUrl(req, relativeImageUrl);

    res.json({
      success: true,
      message: 'Service image uploaded successfully',
      data: {
        service_image_url: normalizedService.service_image_url,
        service: normalizedService
      }
    });
  } catch (error) {
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error uploading service image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload service image',
      error: error.message
    });
  }
}

/**
 * Link existing service to online store
 * Useful for linking services created via storeServices route to online stores
 */
async function linkServiceToOnlineStore(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models for this request
    const models = initModels(req.db);

    const { service_id } = req.params;
    const { online_store_id, is_visible, sort_order } = req.body;

    if (!online_store_id) {
      return res.status(400).json({
        success: false,
        message: 'online_store_id is required'
      });
    }

    // Get tenant to check subscription plan
    const tenantId = req.user.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // Verify service exists
    const service = await models.StoreService.findByPk(service_id);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Verify online store exists
    const onlineStore = await models.OnlineStore.findByPk(online_store_id);
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // Check if service is already linked to this online store
    const existingLink = await models.OnlineStoreService.findOne({
      where: {
        online_store_id,
        service_id
      }
    });

    if (existingLink) {
      return res.status(409).json({
        success: false,
        message: 'Service is already linked to this online store'
      });
    }

    // Get the highest sort_order for this online store if sort_order not provided
    let finalSortOrder = sort_order;
    if (finalSortOrder === undefined || finalSortOrder === null) {
      const maxSortOrder = await models.OnlineStoreService.max('sort_order', {
        where: { online_store_id }
      }) || 0;
      finalSortOrder = maxSortOrder + 1;
    }

    // Create link between service and online store
    const onlineStoreService = await models.OnlineStoreService.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      online_store_id,
      service_id,
      is_visible: is_visible !== undefined ? is_visible : true,
      sort_order: finalSortOrder
    });

    res.status(201).json({
      success: true,
      message: 'Service linked to online store successfully',
      data: {
        online_store_service: onlineStoreService
      }
    });
  } catch (error) {
    console.error('Error linking service to online store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to link service to online store',
      error: error.message
    });
  }
}

/**
 * Get available services for adding to collections
 * Returns services linked to an online store that can be added to collections
 */
async function getAvailableServices(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { online_store_id } = req.params;
    const { search, location_type } = req.query;

    // Verify online store exists
    const onlineStore = await models.OnlineStore.findByPk(online_store_id);
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // Get services linked to this online store via OnlineStoreService
    const onlineStoreServices = await models.OnlineStoreService.findAll({
      where: { online_store_id },
      include: [
        {
          model: models.StoreService,
          where: {
            is_active: true,
            ...(search && {
              service_title: { [require('sequelize').Op.like]: `%${search}%` }
            }),
            ...(location_type && { location_type })
          },
          required: true,
          include: [
            {
              model: models.Store,
              attributes: ['id', 'name', 'store_type'],
              required: false
            }
          ]
        }
      ]
    });

    const services = onlineStoreServices
      .filter(oss => oss.StoreService)
      .map(oss => ({
        id: oss.StoreService.id,
        service_title: oss.StoreService.service_title,
        description: oss.StoreService.description,
        price: oss.StoreService.price,
        service_image_url: oss.StoreService.service_image_url,
        duration_minutes: oss.StoreService.duration_minutes,
        location_type: oss.StoreService.location_type,
        is_visible: oss.is_visible,
        Store: oss.StoreService.Store
      }));

    res.json({
      success: true,
      data: {
        services,
        total: services.length
      }
    });
  } catch (error) {
    console.error('Error getting available services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get available services',
      error: error.message
    });
  }
}

module.exports = {
  getAllStoreServices,
  getStoreServiceById,
  createStoreService,
  createOnlineStoreService,
  getOnlineStoreServices,
  updateStoreService,
  deleteStoreService,
  setServiceAvailability,
  getServiceAvailability,
  uploadServiceImage,
  linkServiceToOnlineStore,
  getAvailableServices
};
