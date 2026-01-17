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

    // Determine if this is a free user
    const isFreePlan = tenant.subscription_plan === 'free';

    // Get online store with basic info
    // For free users: don't include OnlineStoreLocation (they don't have physical stores)
    const onlineStore = await models.OnlineStore.findOne({
      where: { 
        username: username.toLowerCase(), 
        is_published: true 
      },
      include: isFreePlan 
        ? [] // Free users don't have physical stores
        : [
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
    
    // Parse social_links if it's a string (JSON stored as string in database)
    if (storeData.social_links) {
      if (typeof storeData.social_links === 'string') {
        try {
          storeData.social_links = JSON.parse(storeData.social_links);
        } catch (e) {
          console.error('[getPublicStore] Error parsing social_links:', e);
          storeData.social_links = [];
        }
      }
      // Ensure it's an array
      if (!Array.isArray(storeData.social_links)) {
        storeData.social_links = [];
      }
    } else {
      storeData.social_links = [];
    }
    
    // Normalize store image URLs
    if (storeData.profile_logo_url) storeData.profile_logo_url = getFullUrl(storeData.profile_logo_url);
    if (storeData.banner_image_url) storeData.banner_image_url = getFullUrl(storeData.banner_image_url);
    if (storeData.background_image_url) storeData.background_image_url = getFullUrl(storeData.background_image_url);

    // Check if products and services exist to determine toggle visibility
    // For free users: use raw SQL to avoid online_store_id issues
    let hasProducts = false;
    if (isFreePlan) {
      // Free users: use raw SQL
      const [productCountResult] = await sequelize.query(`
        SELECT COUNT(*) as count
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
        WHERE sp.tenant_id = :tenantId
          AND sp.is_published = 1
          AND p.is_active = 1
      `, {
        replacements: { tenantId: tenant_id },
        type: Sequelize.QueryTypes.SELECT
      });
      hasProducts = (parseInt(productCountResult?.count || 0) > 0);
    } else {
      // Enterprise users: use Sequelize
      hasProducts = await models.StoreProduct.count({
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
    }

    // Check if services exist
    let hasServices = false;
    if (isFreePlan) {
      // Free users: use raw SQL
      const [serviceCountResult] = await sequelize.query(`
        SELECT COUNT(*) as count
        FROM store_services ss
        INNER JOIN online_store_services oss ON ss.id = oss.service_id
        WHERE ss.tenant_id = :tenantId
          AND ss.is_active = 1
          AND oss.online_store_id = :onlineStoreId
          AND oss.is_visible = 1
      `, {
        replacements: { 
          tenantId: tenant_id,
          onlineStoreId: onlineStore.id
        },
        type: Sequelize.QueryTypes.SELECT
      });
      hasServices = (parseInt(serviceCountResult?.count || 0) > 0);
    } else {
      // Enterprise users: use Sequelize
      hasServices = await models.StoreService.count({
        where: { is_active: true },
        include: [{
          model: models.OnlineStoreService,
          where: {
            online_store_id: onlineStore.id,
            is_visible: true
          },
          required: true,
          attributes: []
        }]
      }) > 0;
    }

    // Get product collections (preview - limited items per collection)
    // For free users: filter by tenant_id (store_collections doesn't have online_store_id)
    const productCollections = await models.StoreCollection.findAll({
      where: {
        ...(isFreePlan ? { tenant_id: tenant_id } : { online_store_id: onlineStore.id }),
        is_visible: true,
        collection_type: 'product'
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
    // For free users: filter by tenant_id (store_collections doesn't have online_store_id)
    const serviceCollections = await models.StoreCollection.findAll({
      where: {
        ...(isFreePlan ? { tenant_id: tenant_id } : { online_store_id: onlineStore.id }),
        is_visible: true,
        collection_type: 'service'
      },
      include: [
        {
          model: models.StoreCollectionService,
          include: [
            {
              model: models.StoreService,
              where: { is_active: true },
              required: false,
              attributes: ['id', 'service_title', 'description', 'price', 'service_image_url', 'duration_minutes']
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
    // For free users: use raw SQL to avoid online_store_id issues
    let productsNotInCollections = [];
    if (isFreePlan) {
      // Free users: use raw SQL
      const productRows = await sequelize.query(`
        SELECT DISTINCT sp.id, sp.tenant_id, sp.product_id, sp.is_published, sp.featured, sp.sort_order, sp.created_at, sp.updated_at,
               p.id as 'Product.id', p.tenant_id as 'Product.tenant_id', p.name as 'Product.name', 
               p.description as 'Product.description', p.sku as 'Product.sku', p.barcode as 'Product.barcode',
               p.price as 'Product.price', p.stock as 'Product.stock', p.low_stock_threshold as 'Product.low_stock_threshold',
               p.category as 'Product.category', p.image_url as 'Product.image_url', p.expiry_date as 'Product.expiry_date',
               p.is_active as 'Product.is_active', p.created_at as 'Product.created_at', p.updated_at as 'Product.updated_at'
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
        LEFT JOIN store_collection_products scp ON p.id = scp.product_id
        WHERE sp.tenant_id = :tenantId
          AND sp.is_published = 1
          AND p.is_active = 1
          AND scp.id IS NULL
        ORDER BY sp.created_at DESC
        LIMIT :limit
      `, {
        replacements: { tenantId: tenant_id, limit: previewLimit },
        type: Sequelize.QueryTypes.SELECT
      });
      
      // Transform raw results to match Sequelize format
      productsNotInCollections = productRows.map(row => {
        const sp = {
          id: row.id,
          tenant_id: row.tenant_id,
          product_id: row.product_id,
          is_published: row.is_published,
          featured: row.featured,
          sort_order: row.sort_order,
          created_at: row.created_at,
          updated_at: row.updated_at,
          Product: {
            id: row['Product.id'],
            tenant_id: row['Product.tenant_id'],
            name: row['Product.name'],
            description: row['Product.description'],
            sku: row['Product.sku'],
            barcode: row['Product.barcode'],
            price: row['Product.price'],
            stock: row['Product.stock'],
            low_stock_threshold: row['Product.low_stock_threshold'],
            category: row['Product.category'],
            image_url: row['Product.image_url'],
            expiry_date: row['Product.expiry_date'],
            is_active: row['Product.is_active'],
            created_at: row['Product.created_at'],
            updated_at: row['Product.updated_at']
          }
        };
        sp.toJSON = () => sp;
        sp.Product.toJSON = () => sp.Product;
        return sp;
      });
    } else {
      // Enterprise users: use Sequelize
      productsNotInCollections = await models.StoreProduct.findAll({
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
    }

    // Get services NOT in any collection (preview)
    // Services are linked to online store via OnlineStoreService
    // For free users: use raw SQL to avoid online_store_id issues
    let servicesNotInCollections = [];
    if (isFreePlan) {
      // Free users: use raw SQL
      const serviceRows = await sequelize.query(`
        SELECT DISTINCT ss.id, ss.tenant_id, ss.service_title, ss.description, ss.price, ss.service_image_url, 
               ss.duration_minutes, ss.is_active, ss.created_at, ss.updated_at
        FROM store_services ss
        INNER JOIN online_store_services oss ON ss.id = oss.service_id
        LEFT JOIN store_collection_services scs ON ss.id = scs.service_id
        WHERE ss.is_active = 1
          AND oss.online_store_id = :onlineStoreId
          AND ss.tenant_id = :tenantId
          AND oss.is_visible = 1
          AND scs.id IS NULL
        ORDER BY ss.created_at DESC
        LIMIT :limit
      `, {
        replacements: { 
          onlineStoreId: onlineStore.id,
          tenantId: tenant_id,
          limit: previewLimit
        },
        type: Sequelize.QueryTypes.SELECT
      });
      
      // Transform raw results to match Sequelize format
      servicesNotInCollections = serviceRows.map(row => {
        const service = {
          id: row.id,
          tenant_id: row.tenant_id,
          service_title: row.service_title,
          description: row.description,
          price: row.price,
          service_image_url: row.service_image_url,
          duration_minutes: row.duration_minutes,
          is_active: row.is_active,
          created_at: row.created_at,
          updated_at: row.updated_at
        };
        service.toJSON = () => service;
        return service;
      });
    } else {
      // Enterprise users: use Sequelize
      servicesNotInCollections = await models.StoreService.findAll({
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
    }

    // Get total counts for pagination info
    // For free users: filter by tenant_id
    let totalProductCollections = 0;
    let totalServiceCollections = 0;
    
    if (isFreePlan) {
      // Free users: use raw SQL
      const [productCollectionsResult] = await sequelize.query(`
        SELECT COUNT(*) as count
        FROM store_collections
        WHERE tenant_id = :tenantId
          AND is_visible = 1
          AND collection_type = 'product'
      `, {
        replacements: { tenantId: tenant_id },
        type: Sequelize.QueryTypes.SELECT
      });
      totalProductCollections = parseInt(productCollectionsResult?.count || 0);
      
      const [serviceCollectionsResult] = await sequelize.query(`
        SELECT COUNT(*) as count
        FROM store_collections
        WHERE tenant_id = :tenantId
          AND is_visible = 1
          AND collection_type = 'service'
      `, {
        replacements: { tenantId: tenant_id },
        type: Sequelize.QueryTypes.SELECT
      });
      totalServiceCollections = parseInt(serviceCollectionsResult?.count || 0);
    } else {
      // Enterprise users: use Sequelize
      totalProductCollections = await models.StoreCollection.count({
        where: {
          online_store_id: onlineStore.id,
          is_visible: true,
          collection_type: 'product'
        }
      });

      totalServiceCollections = await models.StoreCollection.count({
        where: {
          online_store_id: onlineStore.id,
          is_visible: true,
          collection_type: 'service'
        }
      });
    }

    // Count products not in collections using a subquery approach
    // For free users: use tenant_id instead of online_store_id
    let totalProductsNotInCollections = 0;
    if (isFreePlan) {
      const [productsNotInCollectionsCountResult] = await sequelize.query(`
        SELECT COUNT(DISTINCT sp.id) as count
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
        LEFT JOIN store_collection_products scp ON p.id = scp.product_id
        WHERE sp.tenant_id = :tenantId
          AND sp.is_published = 1
          AND p.is_active = 1
          AND scp.id IS NULL
      `, {
        replacements: { tenantId: tenant_id },
        type: Sequelize.QueryTypes.SELECT
      });
      totalProductsNotInCollections = parseInt(productsNotInCollectionsCountResult?.count || 0);
    } else {
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
      totalProductsNotInCollections = parseInt(productsNotInCollectionsCountResult?.count || 0);
    }

    // Count services not in collections (linked to this online store)
    // For free users: use tenant_id
    let totalServicesNotInCollections = 0;
    if (isFreePlan) {
      const [servicesNotInCollectionsCountResult] = await sequelize.query(`
        SELECT COUNT(DISTINCT ss.id) as count
        FROM store_services ss
        INNER JOIN online_store_services oss ON ss.id = oss.service_id
        LEFT JOIN store_collection_services scs ON ss.id = scs.service_id
        WHERE ss.is_active = 1
          AND oss.online_store_id = :onlineStoreId
          AND ss.tenant_id = :tenantId
          AND oss.is_visible = 1
          AND scs.id IS NULL
      `, {
        replacements: { 
          onlineStoreId: onlineStore.id,
          tenantId: tenant_id
        },
        type: Sequelize.QueryTypes.SELECT
      });
      totalServicesNotInCollections = parseInt(servicesNotInCollectionsCountResult?.count || 0);
    } else {
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
      totalServicesNotInCollections = parseInt(servicesNotInCollectionsCountResult?.count || 0);
    }

    // Normalize collection data
    // Handles both Sequelize instances and plain objects (from raw SQL)
    const normalizeCollection = (collection) => {
      // Handle both Sequelize instances and plain objects
      const collectionData = collection && typeof collection.toJSON === 'function' 
        ? collection.toJSON() 
        : collection;
      
      if (collectionData.StoreCollectionProducts) {
        collectionData.StoreCollectionProducts = collectionData.StoreCollectionProducts.map(cp => {
          // Handle both Sequelize instances and plain objects
          const cpData = cp && typeof cp.toJSON === 'function' ? cp.toJSON() : cp;
          const productData = cpData.Product 
            ? (cpData.Product && typeof cpData.Product.toJSON === 'function' 
                ? cpData.Product.toJSON() 
                : cpData.Product)
            : null;
          
          if (productData && productData.image_url) {
            productData.image_url = getFullUrl(productData.image_url);
          }
          return {
            ...cpData,
            Product: productData
          };
        });
      }
      if (collectionData.StoreCollectionServices) {
        collectionData.StoreCollectionServices = collectionData.StoreCollectionServices.map(cs => {
          // Handle both Sequelize instances and plain objects
          const csData = cs && typeof cs.toJSON === 'function' ? cs.toJSON() : cs;
          const serviceData = csData.StoreService 
            ? (csData.StoreService && typeof csData.StoreService.toJSON === 'function' 
                ? csData.StoreService.toJSON() 
                : csData.StoreService)
            : null;
          
          if (serviceData && serviceData.service_image_url) {
            serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
          }
          return {
            ...csData,
            StoreService: serviceData
          };
        });
      }
      return collectionData;
    };

    // Normalize products - handle both Sequelize instances and plain objects
    const normalizedProducts = productsNotInCollections.map(sp => {
      const productData = sp.Product && typeof sp.Product.toJSON === 'function' 
        ? sp.Product.toJSON() 
        : (sp.Product || sp);
      if (productData && productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      return productData;
    });

    // Normalize services - handle both Sequelize instances and plain objects
    const normalizedServices = servicesNotInCollections.map(service => {
      const serviceData = service && typeof service.toJSON === 'function' 
        ? service.toJSON() 
        : service;
      if (serviceData && serviceData.service_image_url) {
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
    const { Sequelize, Op } = require('sequelize');

    // Determine if this is a free user
    // CRITICAL: Free users don't have online_store_id in store_products table
    // Also, they don't have seo_title, seo_description, seo_keywords columns
    // Default to 'free' if subscription_plan is not explicitly 'enterprise'
    const subscriptionPlan = tenant.subscription_plan || 'free';
    const isFreePlan = subscriptionPlan !== 'enterprise';
    
    // Log for debugging (remove in production if needed)
    if (process.env.NODE_ENV === 'development') {
      console.log('[getPublicProducts] Plan detection:', {
        tenant_id,
        subscription_plan: tenant.subscription_plan,
        subscriptionPlan,
        isFreePlan
      });
    }

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

    let products = [];
    let totalCount = 0;

    // CRITICAL: For free users, ALWAYS use raw SQL to avoid:
    // 1. online_store_id column (doesn't exist in store_products for free users)
    // 2. seo_title, seo_description, seo_keywords columns (don't exist for free users)
    if (isFreePlan) {
      // Free users: use raw SQL to avoid online_store_id and SEO column issues
      // Build WHERE conditions
      let whereConditions = [
        'sp.tenant_id = :tenantId',
        'sp.is_published = 1',
        'p.is_active = 1'
      ];
      const replacements = { tenantId: tenant_id };

      // Add search filter
      if (search) {
        whereConditions.push('(p.name LIKE :search OR p.sku LIKE :search)');
        replacements.search = `%${search}%`;
      }

      // Add category filter
      if (category) {
        whereConditions.push('p.category = :category');
        replacements.category = category;
      }

      // Add collection filter
      if (collection_id) {
        whereConditions.push('scp.collection_id = :collectionId');
        replacements.collectionId = collection_id;
      }

      const whereClause = whereConditions.join(' AND ');

      // Build the query
      let countQuery = `
        SELECT COUNT(DISTINCT sp.id) as count
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
      `;
      
      let dataQuery = `
        SELECT DISTINCT sp.id, sp.tenant_id, sp.product_id, sp.is_published, sp.featured, sp.sort_order, sp.created_at, sp.updated_at,
               p.id as 'Product.id', p.tenant_id as 'Product.tenant_id', p.name as 'Product.name', 
               p.description as 'Product.description', p.sku as 'Product.sku', p.barcode as 'Product.barcode',
               p.price as 'Product.price', p.stock as 'Product.stock', p.low_stock_threshold as 'Product.low_stock_threshold',
               p.category as 'Product.category', p.image_url as 'Product.image_url', p.expiry_date as 'Product.expiry_date',
               p.is_active as 'Product.is_active', p.created_at as 'Product.created_at', p.updated_at as 'Product.updated_at'
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
      `;

      // Add collection join if filtering by collection
      if (collection_id) {
        countQuery += ` INNER JOIN store_collection_products scp ON p.id = scp.product_id`;
        dataQuery += ` INNER JOIN store_collection_products scp ON p.id = scp.product_id`;
      } else {
        // If not filtering by collection, we still want to exclude products in collections (optional)
        // But for now, let's return all products
      }

      countQuery += ` WHERE ${whereClause}`;
      dataQuery += ` WHERE ${whereClause}`;
      dataQuery += ` ORDER BY sp.created_at DESC LIMIT :limit OFFSET :offset`;
      
      replacements.limit = limitNum;
      replacements.offset = offset;

      // Get count
      const [countResult] = await sequelize.query(countQuery, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });
      totalCount = parseInt(countResult?.count || 0);

      // Get products
      const productRows = await sequelize.query(dataQuery, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });

      // Transform raw results to match expected format
      products = productRows.map(row => {
        const productData = {
          id: row['Product.id'],
          tenant_id: row['Product.tenant_id'],
          name: row['Product.name'],
          description: row['Product.description'],
          sku: row['Product.sku'],
          barcode: row['Product.barcode'],
          price: row['Product.price'],
          stock: row['Product.stock'],
          low_stock_threshold: row['Product.low_stock_threshold'],
          category: row['Product.category'],
          image_url: row['Product.image_url'],
          expiry_date: row['Product.expiry_date'],
          is_active: row['Product.is_active'],
          created_at: row['Product.created_at'],
          updated_at: row['Product.updated_at']
        };
        
        if (productData.image_url) {
          productData.image_url = getFullUrl(productData.image_url);
        }
        
        return productData;
      });
    } else {
      // Enterprise users: use Sequelize
      // SAFETY CHECK: If somehow we got here for a free user, use raw SQL instead
      if (isFreePlan || subscriptionPlan !== 'enterprise') {
        console.error('[getPublicProducts] SAFETY: Preventing enterprise query for free user', {
          tenant_id,
          subscription_plan: tenant.subscription_plan,
          subscriptionPlan,
          isFreePlan
        });
        // Force raw SQL path for free users (fallback)
        // This should never happen, but safety check
        throw new Error('Invalid plan detection: free user detected in enterprise path');
      }
      
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
      if (store_id) {
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
      // Explicitly specify attributes to avoid selecting columns that don't exist
      // StoreProduct attributes: only include columns that exist for both free and enterprise
      const storeProductAttributes = ['id', 'tenant_id', 'product_id', 'online_store_id', 'is_published', 'featured', 'sort_order', 'created_at', 'updated_at'];
      
      const { count, rows } = await models.StoreProduct.findAndCountAll({
        where: storeProductWhere,
        attributes: storeProductAttributes, // Explicitly set attributes to avoid SEO columns
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

      totalCount = Array.isArray(count) ? count.length : count;
      
      products = rows.map(sp => {
        const productData = sp.Product.toJSON();
        if (productData.image_url) {
          productData.image_url = getFullUrl(productData.image_url);
        }
        return productData;
      });
    }

    res.json({
      success: true,
      data: { 
        products,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(totalCount / limitNum),
          total_items: totalCount
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
    const { Sequelize } = require('sequelize');

    // Determine if this is a free user
    // CRITICAL: Free users don't have store_id in products table
    // Also, they don't have cost, batch_number, unit_of_measure columns
    const subscriptionPlan = tenant.subscription_plan || 'free';
    const isFreePlan = subscriptionPlan !== 'enterprise';

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

    let product;

    if (isFreePlan) {
      // Free users: use raw SQL to avoid store_id and other enterprise-only columns
      const productRows = await sequelize.query(`
        SELECT p.id, p.tenant_id, p.name, p.description, p.sku, p.barcode, p.price, p.stock, 
               p.low_stock_threshold, p.category, p.image_url, p.expiry_date, p.is_active, 
               p.created_at, p.updated_at
        FROM products p
        INNER JOIN store_products sp ON p.id = sp.product_id
        WHERE p.id = :productId
          AND p.is_active = 1
          AND sp.tenant_id = :tenantId
          AND sp.is_published = 1
        LIMIT 1
      `, {
        replacements: { 
          productId: product_id,
          tenantId: tenant_id
        },
        type: Sequelize.QueryTypes.SELECT
      });

      if (!productRows || productRows.length === 0 || !productRows[0] || !productRows[0].id) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      const row = productRows[0];

      // Get product variations with options
      // For free users: product_variation_options table doesn't have barcode column
      const variationWhereClause = isFreePlan 
        ? 'WHERE pv.product_id = :productId AND pv.tenant_id = :tenantId'
        : 'WHERE pv.product_id = :productId';
      
      const variations = await sequelize.query(`
        SELECT pv.id, pv.variation_name, pv.variation_type, pv.is_required, pv.sort_order,
               pvo.id as 'option_id', pvo.option_value, pvo.option_display_name, 
               pvo.price_adjustment, pvo.stock, pvo.sku, pvo.image_url, 
               pvo.is_default, pvo.is_available, pvo.sort_order as 'option_sort_order',
               pvo.created_at as 'option_created_at'
        FROM product_variations pv
        LEFT JOIN product_variation_options pvo ON pv.id = pvo.variation_id
          ${isFreePlan ? 'AND pvo.tenant_id = :tenantId' : ''}
        ${variationWhereClause}
        ORDER BY pv.sort_order ASC, pvo.sort_order ASC
      `, {
        replacements: { 
          productId: product_id,
          ...(isFreePlan ? { tenantId: tenant_id } : {})
        },
        type: Sequelize.QueryTypes.SELECT
      });

      // Group variations and their options
      const variationsMap = {};
      variations.forEach(v => {
        if (!variationsMap[v.id]) {
          variationsMap[v.id] = {
            id: v.id,
            variation_name: v.variation_name,
            variation_type: v.variation_type,
            is_required: v.is_required,
            sort_order: v.sort_order,
            options: []
          };
        }
        if (v.option_id) {
          // For free users: barcode column doesn't exist in product_variation_options table
          const optionData = {
            id: v.option_id,
            option_value: v.option_value,
            option_display_name: v.option_display_name,
            price_adjustment: v.price_adjustment,
            stock: v.stock,
            sku: v.sku,
            image_url: v.image_url ? getFullUrl(v.image_url) : null,
            is_default: v.is_default,
            is_available: v.is_available,
            sort_order: v.option_sort_order,
            created_at: v.option_created_at
          };
          // Only include barcode for enterprise users (free users don't have this column)
          if (!isFreePlan && v.barcode !== undefined) {
            optionData.barcode = v.barcode;
          }
          variationsMap[v.id].options.push(optionData);
        }
      });

      product = {
        id: row.id,
        tenant_id: row.tenant_id,
        name: row.name,
        description: row.description,
        sku: row.sku,
        barcode: row.barcode,
        price: row.price,
        stock: row.stock,
        low_stock_threshold: row.low_stock_threshold,
        category: row.category,
        image_url: row.image_url ? getFullUrl(row.image_url) : null,
        expiry_date: row.expiry_date,
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at,
        variations: Object.values(variationsMap)
      };
    } else {
      // Enterprise users: use Sequelize
      product = await models.Product.findOne({
        where: {
          id: product_id,
          is_active: true
        },
        include: [
          {
            model: models.StoreProduct,
            where: {
              online_store_id: onlineStore.id,
              is_published: true
            },
            required: true,
            attributes: [] // Don't include StoreProduct data in response
          },
          {
            model: models.ProductVariation,
            include: [{
              model: models.ProductVariationOption,
              order: [['sort_order', 'ASC']]
            }],
            order: [['sort_order', 'ASC']],
            required: false
          }
        ]
      });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      // Normalize product data and variations
      const productData = product.toJSON();
      
      // Normalize product image URL
      if (productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }

      // Normalize variation option image URLs
      if (productData.ProductVariations) {
        productData.variations = productData.ProductVariations.map(variation => {
          const variationData = {
            id: variation.id,
            variation_name: variation.variation_name,
            variation_type: variation.variation_type,
            is_required: variation.is_required,
            sort_order: variation.sort_order,
            options: (variation.ProductVariationOptions || []).map(option => {
              const optionData = {
                id: option.id,
                option_value: option.option_value,
                option_display_name: option.option_display_name,
                price_adjustment: option.price_adjustment,
                stock: option.stock,
                sku: option.sku,
                image_url: option.image_url ? getFullUrl(option.image_url) : null,
                is_default: option.is_default,
                is_available: option.is_available,
                sort_order: option.sort_order,
                created_at: option.created_at
              };
              
              // Include barcode for enterprise users if it exists
              if (option.barcode !== undefined) {
                optionData.barcode = option.barcode;
              }
              
              return optionData;
            })
          };
          return variationData;
        });
        
        // Remove ProductVariations from response (we've converted it to variations)
        delete productData.ProductVariations;
      }

      product = productData;
    }

    res.json({
      success: true,
      data: { product }
    });
  } catch (error) {
    console.error('Error getting public product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
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

