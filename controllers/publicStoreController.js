/**
 * Public Store Controller
 * Handles public-facing endpoints for customers viewing online stores
 * No authentication required
 */

const { getTenantConnection } = require('../config/database');
const { getTenantBySubdomain } = require('../config/tenant');
const initModels = require('../models');

// Note: All public store endpoints require tenant_id as query parameter
// This is because we need to know which tenant database to query

/**
 * Get public online store by username
 * GET /api/v1/public-store/:username?tenant_id=123&preview_limit=5
 * 
 * Returns comprehensive store overview with:
 * - Store basic information
 * - Toggle states (show_products, show_services)
 * - Product collections (preview - limited items)
 * - Service collections (preview - limited items)
 * - Products not in collections (preview - limited items)
 * - Services not in collections (preview - limited items)
 * 
 * Use other endpoints for full pagination/details:
 * - GET /api/v1/public-store/:username/collections/:id/products (full pagination)
 * - GET /api/v1/public-store/:username/products (full pagination)
 * - GET /api/v1/public-store/:username/services (full pagination)
 */
async function getPublicStore(req, res) {
  try {
    const { username } = req.params;
    const { tenant_id, preview_limit = 5 } = req.query;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    // Parse preview limit (max 20 items per section)
    const previewLimit = Math.min(parseInt(preview_limit) || 5, 20);

    // Get tenant database connection
    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);
    const { Sequelize, Op } = require('sequelize');

    // Get online store with basic info
    const onlineStore = await models.OnlineStore.findOne({
      where: { 
        username: username.toLowerCase(), 
        is_published: true 
      },
      include: [
        {
          model: models.OnlineStoreLocation,
          include: [{ 
            model: models.Store, 
            attributes: ['id', 'name', 'address', 'city', 'state', 'country'] 
          }]
        }
      ]
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Store not found or not published'
      });
    }

    // Helper to normalize URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const storeData = onlineStore.toJSON();
    
    // Normalize store image URLs
    if (storeData.profile_logo_url) storeData.profile_logo_url = getFullUrl(storeData.profile_logo_url);
    if (storeData.banner_image_url) storeData.banner_image_url = getFullUrl(storeData.banner_image_url);
    if (storeData.background_image_url) storeData.background_image_url = getFullUrl(storeData.background_image_url);

    // Check if products and services exist to determine toggle visibility
    // Note: If show_products/show_services fields exist in DB, use those instead
    const hasProducts = await models.StoreProduct.count({
      where: {
        online_store_id: onlineStore.id,
        is_published: true
      },
      include: [{
        model: models.Product,
        where: { is_active: true },
        required: true
      }]
    }) > 0;

    const hasServices = await models.StoreService.count({
      where: { is_active: true }
    }) > 0;

    // Get product collections (preview - limited items per collection)
    const productCollections = await models.StoreCollection.findAll({
      where: {
        online_store_id: onlineStore.id,
        is_visible: true,
        collection_type: 'product' // Assuming collections have a type field, or we filter by having products
      },
      include: [
        {
          model: models.StoreCollectionProduct,
          include: [
            {
              model: models.Product,
              where: { is_active: true },
              required: false,
              attributes: ['id', 'name', 'sku', 'price', 'image_url', 'category']
            }
          ],
          limit: previewLimit, // Limit products per collection
          order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
        }
      ],
      order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']],
      limit: 10 // Limit number of collections shown
    });

    // Get service collections (preview - limited items per collection)
    const serviceCollections = await models.StoreCollection.findAll({
      where: {
        online_store_id: onlineStore.id,
        is_visible: true,
        collection_type: 'service' // Assuming collections have a type field
      },
      include: [
        {
          model: models.StoreCollectionService,
          include: [
            {
              model: models.StoreService,
              where: { is_active: true },
              required: false,
              attributes: ['id', 'name', 'description', 'price', 'service_image_url', 'duration']
            }
          ],
          limit: previewLimit, // Limit services per collection
          order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
        }
      ],
      order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']],
      limit: 10 // Limit number of collections shown
    });

    // Get products NOT in any collection (preview)
    const productsNotInCollections = await models.StoreProduct.findAll({
      where: {
        online_store_id: onlineStore.id,
        is_published: true,
        '$Product.StoreCollectionProducts.id$': { [Op.eq]: null }
      },
      include: [
        {
          model: models.Product,
          where: { is_active: true },
          required: true,
          include: [{
            model: models.StoreCollectionProduct,
            required: false,
            attributes: []
          }]
        }
      ],
      limit: previewLimit,
      order: [['created_at', 'DESC']],
      subQuery: false,
      group: ['StoreProduct.id']
    });

    // Get services NOT in any collection (preview)
    // Services are linked to online store via OnlineStoreService
    const servicesNotInCollections = await models.StoreService.findAll({
      where: {
        is_active: true,
        '$OnlineStoreServices.online_store_id$': onlineStore.id,
        '$StoreCollectionServices.id$': { [Op.eq]: null }
      },
      include: [
        {
          model: models.OnlineStoreService,
          where: { 
            online_store_id: onlineStore.id,
            is_visible: true
          },
          required: true,
          attributes: []
        },
        {
          model: models.StoreCollectionService,
          required: false,
          attributes: []
        }
      ],
      limit: previewLimit,
      order: [['created_at', 'DESC']],
      subQuery: false,
      group: ['StoreService.id']
    });

    // Get total counts for pagination info
    const totalProductCollections = await models.StoreCollection.count({
      where: {
        online_store_id: onlineStore.id,
        is_visible: true,
        collection_type: 'product'
      }
    });

    const totalServiceCollections = await models.StoreCollection.count({
      where: {
        online_store_id: onlineStore.id,
        is_visible: true,
        collection_type: 'service'
      }
    });

    // Count products not in collections using a subquery approach
    const [productsNotInCollectionsCountResult] = await sequelize.query(`
      SELECT COUNT(DISTINCT sp.id) as count
      FROM store_products sp
      INNER JOIN products p ON sp.product_id = p.id
      LEFT JOIN store_collection_products scp ON p.id = scp.product_id
      WHERE sp.online_store_id = :onlineStoreId
        AND sp.is_published = 1
        AND p.is_active = 1
        AND scp.id IS NULL
    `, {
      replacements: { onlineStoreId: onlineStore.id },
      type: Sequelize.QueryTypes.SELECT
    });
    const totalProductsNotInCollections = productsNotInCollectionsCountResult?.count || 0;

    // Count services not in collections (linked to this online store)
    const [servicesNotInCollectionsCountResult] = await sequelize.query(`
      SELECT COUNT(DISTINCT ss.id) as count
      FROM store_services ss
      INNER JOIN online_store_services oss ON ss.id = oss.service_id
      LEFT JOIN store_collection_services scs ON ss.id = scs.service_id
      WHERE ss.is_active = 1
        AND oss.online_store_id = :onlineStoreId
        AND oss.is_visible = 1
        AND scs.id IS NULL
    `, {
      replacements: { onlineStoreId: onlineStore.id },
      type: Sequelize.QueryTypes.SELECT
    });
    const totalServicesNotInCollections = servicesNotInCollectionsCountResult?.count || 0;

    // Normalize collection data
    const normalizeCollection = (collection) => {
      const collectionData = collection.toJSON();
      if (collectionData.StoreCollectionProducts) {
        collectionData.StoreCollectionProducts = collectionData.StoreCollectionProducts.map(cp => {
          const productData = cp.Product ? cp.Product.toJSON() : null;
          if (productData && productData.image_url) {
            productData.image_url = getFullUrl(productData.image_url);
          }
          return {
            ...cp.toJSON(),
            Product: productData
          };
        });
      }
      if (collectionData.StoreCollectionServices) {
        collectionData.StoreCollectionServices = collectionData.StoreCollectionServices.map(cs => {
          const serviceData = cs.StoreService ? cs.StoreService.toJSON() : null;
          if (serviceData && serviceData.service_image_url) {
            serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
          }
          return {
            ...cs.toJSON(),
            StoreService: serviceData
          };
        });
      }
      return collectionData;
    };

    // Normalize products
    const normalizedProducts = productsNotInCollections.map(sp => {
      const productData = sp.Product.toJSON();
      if (productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      return productData;
    });

    // Normalize services
    const normalizedServices = servicesNotInCollections.map(service => {
      const serviceData = service.toJSON();
      if (serviceData.service_image_url) {
        serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
      }
      return serviceData;
    });

    res.json({
      success: true,
      data: {
        store: {
          id: storeData.id,
          username: storeData.username,
          store_name: storeData.store_name,
          store_description: storeData.store_description,
          profile_logo_url: storeData.profile_logo_url,
          banner_image_url: storeData.banner_image_url,
          background_image_url: storeData.background_image_url,
          background_color: storeData.background_color,
          button_style: storeData.button_style,
          button_color: storeData.button_color,
          button_font_color: storeData.button_font_color,
          social_links: storeData.social_links,
          is_location_based: storeData.is_location_based,
          show_location: storeData.show_location,
          allow_delivery_datetime: storeData.allow_delivery_datetime,
          OnlineStoreLocations: storeData.OnlineStoreLocations
        },
        toggles: {
          show_products: hasProducts, // TODO: Replace with actual show_products field from DB if it exists
          show_services: hasServices  // TODO: Replace with actual show_services field from DB if it exists
        },
        product_collections: {
          items: productCollections.map(normalizeCollection),
          total: totalProductCollections,
          preview_limit: previewLimit,
          has_more: totalProductCollections > productCollections.length
        },
        service_collections: {
          items: serviceCollections.map(normalizeCollection),
          total: totalServiceCollections,
          preview_limit: previewLimit,
          has_more: totalServiceCollections > serviceCollections.length
        },
        products_not_in_collections: {
          items: normalizedProducts,
          total: parseInt(totalProductsNotInCollections) || 0,
          preview_limit: previewLimit,
          has_more: (parseInt(totalProductsNotInCollections) || 0) > normalizedProducts.length
        },
        services_not_in_collections: {
          items: normalizedServices,
          total: parseInt(totalServicesNotInCollections) || 0,
          preview_limit: previewLimit,
          has_more: (parseInt(totalServicesNotInCollections) || 0) > normalizedServices.length
        }
      }
    });
  } catch (error) {
    console.error('Error getting public store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get products in a collection (public)
 * GET /api/v1/public-store/:username/collections/:collection_id/products
 * Supports pagination with page and limit query parameters
 */
async function getPublicCollectionProducts(req, res) {
  try {
    const { username, collection_id } = req.params;
    const { tenant_id, page = 1, limit = 20 } = req.query;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    // Parse pagination parameters
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Find online store
    const onlineStore = await models.OnlineStore.findOne({
      where: { 
        username: username.toLowerCase(), 
        is_published: true 
      }
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Store not found or not published'
      });
    }

    // Get collection products with pagination
    const { count, rows } = await models.StoreCollectionProduct.findAndCountAll({
      where: {
        collection_id: collection_id
      },
      include: [
        {
          model: models.Product,
          where: { is_active: true },
          required: true
        }
      ],
      order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']],
      limit: limitNum,
      offset: offset,
      distinct: true
    });

    // Normalize image URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const products = rows.map(cp => {
      const productData = cp.Product ? cp.Product.toJSON() : null;
      if (productData && productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      return {
        ...cp.toJSON(),
        Product: productData
      };
    });

    res.json({
      success: true,
      data: { 
        products,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(count / limitNum),
          total_items: count
        }
      }
    });
  } catch (error) {
    console.error('Error getting public collection products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get collection products',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get services in a collection (public)
 * GET /api/v1/public-store/:username/collections/:collection_id/services
 * Supports pagination with page and limit query parameters
 */
async function getPublicCollectionServices(req, res) {
  try {
    const { username, collection_id } = req.params;
    const { tenant_id, page = 1, limit = 20 } = req.query;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    // Parse pagination parameters
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Find online store
    const onlineStore = await models.OnlineStore.findOne({
      where: { 
        username: username.toLowerCase(), 
        is_published: true 
      }
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Store not found or not published'
      });
    }

    // Get collection services with pagination
    const { count, rows } = await models.StoreCollectionService.findAndCountAll({
      where: {
        collection_id: collection_id
      },
      include: [
        {
          model: models.StoreService,
          where: { is_active: true },
          required: true
        }
      ],
      order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']],
      limit: limitNum,
      offset: offset,
      distinct: true
    });

    // Normalize image URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const services = rows.map(cs => {
      const serviceData = cs.StoreService ? cs.StoreService.toJSON() : null;
      if (serviceData && serviceData.service_image_url) {
        serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
      }
      return {
        ...cs.toJSON(),
        StoreService: serviceData
      };
    });

    res.json({
      success: true,
      data: { 
        services,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(count / limitNum),
          total_items: count
        }
      }
    });
  } catch (error) {
    console.error('Error getting public collection services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get collection services',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get all services for an online store (public - ALL services with filters)
 * GET /api/v1/public-store/:username/services?collection_id=123&search=keyword
 * Supports pagination with page and limit query parameters
 * Filters:
 *   - collection_id: Filter services by collection
 *   - search: Search by service name or description
 */
async function getPublicServices(req, res) {
  try {
    const { username } = req.params;
    const { tenant_id, collection_id, search, page = 1, limit = 20 } = req.query;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    // Parse pagination parameters
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Find online store
    const onlineStore = await models.OnlineStore.findOne({
      where: { 
        username: username.toLowerCase(), 
        is_published: true 
      },
      attributes: ['id']
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Store not found or not published'
      });
    }

    // Build where clause
    const { Op } = require('sequelize');
    const where = {
      is_active: true
    };

    if (search) {
      where[Op.or] = [
        { service_title: { [Op.like]: `%${search}%` } },
        { description: { [Op.like]: `%${search}%` } }
      ];
    }

    // Build include clause - services linked to this online store
    const includeClause = [{
      model: models.OnlineStoreService,
      where: { 
        online_store_id: onlineStore.id,
        is_visible: true
      },
      required: true,
      attributes: []
    }];

    // If collection_id is provided, filter services in that collection
    if (collection_id) {
      includeClause.push({
        model: models.StoreCollectionService,
        where: { collection_id },
        required: true,
        attributes: []
      });
    }

    // Get ALL services for this online store (with optional collection filter)
    const { count, rows } = await models.StoreService.findAndCountAll({
      where,
      include: includeClause,
      order: [['created_at', 'DESC']],
      limit: limitNum,
      offset: offset,
      distinct: true
    });

    // Normalize image URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const services = rows.map(service => {
      const serviceData = service.toJSON();
      if (serviceData.service_image_url) {
        serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
      }
      return serviceData;
    });

    res.json({
      success: true,
      data: { 
        services,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(count / limitNum),
          total_items: count
        }
      }
    });
  } catch (error) {
    console.error('Error getting public services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get services',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get service by ID (public)
 * GET /api/v1/public-store/:username/services/:service_id
 */
async function getPublicService(req, res) {
  try {
    const { username, service_id } = req.params;
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Find online store
    const onlineStore = await models.OnlineStore.findOne({
      where: { 
        username: username.toLowerCase(), 
        is_published: true 
      }
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Store not found or not published'
      });
    }

    // Get service
    const service = await models.StoreService.findOne({
      where: {
        id: service_id,
        is_active: true
      }
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.json({
      success: true,
      data: { service }
    });
  } catch (error) {
    console.error('Error getting public service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get service'
    });
  }
}

/**
 * Get all products for an online store (public - ALL products with filters)
 * GET /api/v1/public-store/:username/products?collection_id=123&search=keyword&category=electronics&store_id=1
 * Supports pagination with page and limit query parameters
 * Filters:
 *   - collection_id: Filter products by collection
 *   - search: Search by product name or SKU
 *   - category: Filter by category
 *   - store_id: Filter by physical store (enterprise only)
 */
async function getPublicProducts(req, res) {
  try {
    const { username } = req.params;
    const { tenant_id, collection_id, search, category, store_id, page = 1, limit = 20 } = req.query;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    // Parse pagination parameters
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Find online store
    const onlineStore = await models.OnlineStore.findOne({
      where: { 
        username: username.toLowerCase(), 
        is_published: true 
      },
      attributes: ['id']
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Store not found or not published'
      });
    }

    const { Op } = require('sequelize');

    // Build product where clause
    const productWhere = { is_active: true };
    if (search) {
      productWhere[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { sku: { [Op.like]: `%${search}%` } }
      ];
    }
    if (category) {
      productWhere.category = category;
    }

    // For enterprise users, filter by physical store if store_id is provided
    if (tenant.subscription_plan !== 'free' && store_id) {
      productWhere.store_id = store_id;
    }

    // Build StoreProduct where clause
    const storeProductWhere = {
      online_store_id: onlineStore.id,
      is_published: true
    };

    // If collection_id is provided, filter products in that collection
    if (collection_id) {
      storeProductWhere['$Product.StoreCollectionProducts.collection_id$'] = collection_id;
    }

    // Get ALL products for this online store (with optional collection filter)
    const { count, rows } = await models.StoreProduct.findAndCountAll({
      where: storeProductWhere,
      include: [
        {
          model: models.Product,
          where: productWhere,
          required: true,
          include: [{
            model: models.StoreCollectionProduct,
            required: collection_id ? true : false, // Required only if filtering by collection
            attributes: ['id', 'collection_id'],
            ...(collection_id ? { where: { collection_id } } : {})
          }]
        }
      ],
      limit: limitNum,
      offset: offset,
      order: [['created_at', 'DESC']],
      subQuery: false,
      group: ['StoreProduct.id'],
      distinct: true
    });

    // Normalize image URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const products = rows.map(sp => {
      const productData = sp.Product.toJSON();
      if (productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      return productData;
    });

    res.json({
      success: true,
      data: { 
        products,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(count.length / limitNum),
          total_items: count.length
        }
      }
    });
  } catch (error) {
    console.error('Error getting public products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get products',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get product by ID (public)
 * GET /api/v1/public-store/:username/products/:product_id
 */
async function getPublicProduct(req, res) {
  try {
    const { username, product_id } = req.params;
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Find online store
    const onlineStore = await models.OnlineStore.findOne({
      where: { 
        username: username.toLowerCase(), 
        is_published: true 
      }
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Store not found or not published'
      });
    }

    // Get product
    const product = await models.Product.findOne({
      where: {
        id: product_id,
        is_active: true
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      data: { product }
    });
  } catch (error) {
    console.error('Error getting public product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product'
    });
  }
}

module.exports = {
  getPublicStore,
  getPublicProducts,
  getPublicProduct,
  getPublicServices,
  getPublicService
};

