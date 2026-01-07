const { Sequelize } = require('sequelize');

/**
 * Get published products (public endpoint with location-based filtering)
 * Requires tenant_id query parameter or authentication
 * Supports location-based filtering: city, state, store_id
 */
async function getPublishedProducts(req, res) {
  try {
    // Get tenant_id from query or authenticated user
    let tenantId = req.query.tenant_id;
    
    if (!tenantId && req.user) {
      tenantId = req.user.tenantId;
    }

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id is required for public access'
      });
    }

    // Get tenant database connection (supports free & enterprise plans)
    const { getTenantConnection } = require('../config/database');
    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    const sequelize = await getTenantConnection(tenantId, tenant.subscription_plan || 'enterprise');
    const initializeModels = require('../models');
    const models = initializeModels(sequelize);

    const { page = 1, limit = 20, category, featured, city, state, store_id, online_store_id } = req.query;
    const offset = (page - 1) * limit;

    const { Sequelize } = require('sequelize');
    const where = {
      is_published: true
    };

    if (category) {
      where['$Product.category$'] = category;
    }
    if (featured === 'true') {
      where.featured = true;
    }

    // Location-based filtering
    const productWhere = { is_active: true };
    if (store_id) {
      // Filter products by specific store
      productWhere.store_id = store_id;
    } else if (city || state) {
      // Filter products by location (city/state) - get stores in that location first
      const storeWhere = {};
      if (city) storeWhere.city = city;
      if (state) storeWhere.state = state;
      
      const storesInLocation = await models.Store.findAll({
        where: storeWhere,
        attributes: ['id']
      });
      
      if (storesInLocation.length > 0) {
        const storeIds = storesInLocation.map(s => s.id);
        productWhere[Sequelize.Op.or] = [
          { store_id: { [Sequelize.Op.in]: storeIds } },
          { '$ProductStores.store_id$': { [Sequelize.Op.in]: storeIds } }
        ];
      } else {
        // No stores in location, return empty
        return res.json({
          success: true,
          data: {
            products: [],
            pagination: {
              total: 0,
              page: parseInt(page),
              limit: parseInt(limit),
              totalPages: 0
            }
          }
        });
      }
    } else if (online_store_id) {
      // Get products from stores linked to this online store
      const onlineStoreLocations = await models.OnlineStoreLocation.findAll({
        where: { online_store_id },
        attributes: ['store_id']
      });
      
      if (onlineStoreLocations.length > 0) {
        const storeIds = onlineStoreLocations.map(l => l.store_id);
        productWhere[Sequelize.Op.or] = [
          { store_id: { [Sequelize.Op.in]: storeIds } },
          { '$ProductStores.store_id$': { [Sequelize.Op.in]: storeIds } }
        ];
      }
    }

    const { count, rows } = await models.StoreProduct.findAndCountAll({
      where,
      include: [
        {
          model: models.Product,
          where: productWhere,
          required: true,
          include: [
            {
              model: models.Store,
              attributes: ['id', 'name', 'store_type', 'city', 'state']
            },
            {
              model: models.Store,
              as: 'ProductStores',
              through: { attributes: ['stock', 'price_override'] },
              attributes: ['id', 'name', 'store_type', 'city', 'state']
            }
          ]
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['sort_order', 'ASC'], ['created_at', 'DESC']],
      distinct: true
    });

    res.json({
      success: true,
      data: {
        products: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting published products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get products'
    });
  }
}

/**
 * Get published product by ID (public endpoint)
 * Requires tenant_id query parameter or authentication
 */
async function getPublishedProductById(req, res) {
  try {
    // Get tenant_id from query or authenticated user
    let tenantId = req.query.tenant_id;
    
    if (!tenantId && req.user) {
      tenantId = req.user.tenantId;
    }

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id is required for public access'
      });
    }

    // Get tenant database connection (supports free & enterprise plans)
    const { getTenantConnection } = require('../config/database');
    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    const sequelize = await getTenantConnection(tenantId, tenant.subscription_plan || 'enterprise');
    const initializeModels = require('../models');
    const models = initializeModels(sequelize);

    const storeProduct = await models.StoreProduct.findOne({
      where: {
        id: req.params.id,
        is_published: true
      },
      include: [
        {
          model: models.Product,
          where: { is_active: true },
          required: true
        }
      ]
    });

    if (!storeProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      data: { product: storeProduct }
    });
  } catch (error) {
    console.error('Error getting product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product'
    });
  }
}

/**
 * Publish product to store
 */
async function publishProduct(req, res) {
  try {
    const product = await req.db.models.Product.findByPk(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Get or create store product
    let storeProduct = await req.db.models.StoreProduct.findOne({
      where: { product_id: req.params.id }
    });

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

    if (storeProduct) {
      await storeProduct.update({ is_published: true });
    } else {
      storeProduct = await req.db.models.StoreProduct.create({
        tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
        product_id: req.params.id,
        is_published: true
      });
    }

    const completeStoreProduct = await req.db.models.StoreProduct.findByPk(storeProduct.id, {
      include: [
        {
          model: req.db.models.Product
        }
      ]
    });

    res.json({
      success: true,
      message: 'Product published successfully',
      data: { storeProduct: completeStoreProduct }
    });
  } catch (error) {
    console.error('Error publishing product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to publish product'
    });
  }
}

/**
 * Unpublish product from store
 */
async function unpublishProduct(req, res) {
  try {
    const storeProduct = await req.db.models.StoreProduct.findOne({
      where: { product_id: req.params.id }
    });

    if (!storeProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found in store'
      });
    }

    await storeProduct.update({ is_published: false });

    res.json({
      success: true,
      message: 'Product unpublished successfully'
    });
  } catch (error) {
    console.error('Error unpublishing product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unpublish product'
    });
  }
}

/**
 * Update store product settings
 */
async function updateStoreProduct(req, res) {
  try {
    const {
      seo_title,
      seo_description,
      seo_keywords,
      featured,
      sort_order
    } = req.body;

    let storeProduct = await req.db.models.StoreProduct.findOne({
      where: { product_id: req.params.id }
    });

    if (!storeProduct) {
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
      
      // Create if doesn't exist
      storeProduct = await req.db.models.StoreProduct.create({
        tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
        product_id: req.params.id,
        is_published: false
      });
    }

    await storeProduct.update({
      ...(seo_title !== undefined && { seo_title }),
      ...(seo_description !== undefined && { seo_description }),
      ...(seo_keywords !== undefined && { seo_keywords }),
      ...(featured !== undefined && { featured }),
      ...(sort_order !== undefined && { sort_order })
    });

    const updatedStoreProduct = await req.db.models.StoreProduct.findByPk(storeProduct.id, {
      include: [
        {
          model: req.db.models.Product
        }
      ]
    });

    res.json({
      success: true,
      message: 'Store product updated successfully',
      data: { storeProduct: updatedStoreProduct }
    });
  } catch (error) {
    console.error('Error updating store product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update store product'
    });
  }
}

/**
 * Get all store products (admin)
 */
async function getAllStoreProducts(req, res) {
  try {
    const { page = 1, limit = 50, is_published } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (is_published !== undefined) {
      where.is_published = is_published === 'true';
    }

    const { count, rows } = await req.db.models.StoreProduct.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.Product
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['sort_order', 'ASC'], ['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        storeProducts: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting store products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store products'
    });
  }
}

module.exports = {
  getPublishedProducts,
  getPublishedProductById,
  publishProduct,
  unpublishProduct,
  updateStoreProduct,
  getAllStoreProducts
};

