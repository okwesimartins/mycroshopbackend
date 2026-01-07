const { Sequelize } = require('sequelize');
const initModels = require('../models');

/**
 * Get all stores
 */
async function getAllStores(req, res) {
  try {
    const { page = 1, limit = 50, search, store_type, isActive } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (search) {
      where[Sequelize.Op.or] = [
        { name: { [Sequelize.Op.like]: `%${search}%` } },
        { city: { [Sequelize.Op.like]: `%${search}%` } },
        { state: { [Sequelize.Op.like]: `%${search}%` } }
      ];
    }
    if (store_type) {
      where.store_type = store_type;
    }
    if (isActive !== undefined) {
      where.is_active = isActive === 'true';
    }

    const { count, rows } = await req.db.models.Store.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        stores: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting stores:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get stores'
    });
  }
}

/**
 * Get store by ID
 */
async function getStoreById(req, res) {
  try {
    const store = await req.db.models.Store.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Product,
          attributes: ['id', 'name', 'sku', 'price', 'stock'],
          limit: 10
        }
      ]
    });
    
    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    res.json({
      success: true,
      data: { store }
    });
  } catch (error) {
    console.error('Error getting store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store'
    });
  }
}

/**
 * Create store
 * For users upgrading from free to enterprise: automatically assigns existing services with store_id=null to this first store
 */
async function createStore(req, res) {
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
      name,
      store_type,
      address,
      city,
      state,
      country,
      phone,
      email,
      description
    } = req.body;

    if (!name || !store_type) {
      return res.status(400).json({
        success: false,
        message: 'Name and store_type are required'
      });
    }

    // Check if this is the first store being created for this tenant
    const existingStoreCount = await models.Store.count();
    const isFirstStore = existingStoreCount === 0;

    // Create the store
    const store = await models.Store.create({
      name,
      store_type,
      address: address || null,
      city: city || null,
      state: state || null,
      country: country || 'Nigeria',
      phone: phone || null,
      email: email || null,
      description: description || null,
      is_active: true
    });

    // If this is the first store, assign all existing services with store_id = null to this store
    // This handles the upgrade scenario where free users had services without physical stores
    if (isFirstStore) {
      try {
        const servicesToMigrate = await models.StoreService.findAll({
          where: {
            store_id: null
          }
        });

        if (servicesToMigrate.length > 0) {
          // Bulk update all services to link them to the new store
          await models.StoreService.update(
            { store_id: store.id },
            {
              where: {
                store_id: null
              }
            }
          );

          console.log(`Migrated ${servicesToMigrate.length} service(s) to new store (ID: ${store.id})`);
        }
      } catch (migrationError) {
        // Log error but don't fail the store creation
        console.error('Error migrating services to new store:', migrationError);
      }
    }

    res.status(201).json({
      success: true,
      message: isFirstStore 
        ? 'Store created successfully. Existing services have been assigned to this store.'
        : 'Store created successfully',
      data: { store }
    });
  } catch (error) {
    console.error('Error creating store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create store',
      error: error.message
    });
  }
}

/**
 * Update store
 */
async function updateStore(req, res) {
  try {
    const store = await req.db.models.Store.findByPk(req.params.id);
    
    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const {
      name,
      store_type,
      address,
      city,
      state,
      country,
      phone,
      email,
      description,
      is_active
    } = req.body;

    await store.update({
      ...(name !== undefined && { name }),
      ...(store_type !== undefined && { store_type }),
      ...(address !== undefined && { address }),
      ...(city !== undefined && { city }),
      ...(state !== undefined && { state }),
      ...(country !== undefined && { country }),
      ...(phone !== undefined && { phone }),
      ...(email !== undefined && { email }),
      ...(description !== undefined && { description }),
      ...(is_active !== undefined && { is_active })
    });

    res.json({
      success: true,
      message: 'Store updated successfully',
      data: { store }
    });
  } catch (error) {
    console.error('Error updating store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update store'
    });
  }
}

/**
 * Delete store
 */
async function deleteStore(req, res) {
  try {
    const store = await req.db.models.Store.findByPk(req.params.id);
    
    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    // Check if store has products
    const productCount = await req.db.models.Product.count({
      where: { store_id: store.id }
    });

    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete store with ${productCount} product(s). Please remove or transfer products first.`
      });
    }

    await store.destroy();

    res.json({
      success: true,
      message: 'Store deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete store'
    });
  }
}

/**
 * Get store overview (products, invoices, bookings count)
 */
async function getStoreOverview(req, res) {
  try {
    const store = await req.db.models.Store.findByPk(req.params.id);
    
    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const [productCount, invoiceCount, bookingCount, lowStockCount] = await Promise.all([
      req.db.models.Product.count({ where: { store_id: store.id } }),
      req.db.models.Invoice.count({ where: { store_id: store.id } }),
      req.db.models.Booking.count({ where: { store_id: store.id } }),
      req.db.models.Product.count({
        where: {
          store_id: store.id,
          stock: { [Sequelize.Op.lte]: Sequelize.col('low_stock_threshold') }
        }
      })
    ]);

    res.json({
      success: true,
      data: {
        store: {
          id: store.id,
          name: store.name,
          store_type: store.store_type
        },
        overview: {
          products: productCount,
          invoices: invoiceCount,
          bookings: bookingCount,
          low_stock_products: lowStockCount
        }
      }
    });
  } catch (error) {
    console.error('Error getting store overview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store overview'
    });
  }
}

module.exports = {
  getAllStores,
  getStoreById,
  createStore,
  updateStore,
  deleteStore,
  getStoreOverview
};
