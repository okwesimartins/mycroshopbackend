const { Sequelize } = require('sequelize');
const initModels = require('../models');

/**
 * Helper function to get full URL from relative path
 */
function getFullUrl(req, relativePath) {
  if (!relativePath) return null;
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
    return relativePath;
  }
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}${relativePath}`;
}

/**
 * Helper function to verify online store belongs to current tenant
 * Returns the online store if valid, null otherwise
 */
async function verifyOnlineStoreOwnership(req, online_store_id) {
  if (!req.db) {
    return null;
  }

  const models = initModels(req.db);
  const tenant = req.tenant;
  const tenantId = req.user?.tenantId;
  const isFreePlan = tenant && tenant.subscription_plan === 'free';

  const numericId = Number(online_store_id);
  if (!numericId || Number.isNaN(numericId)) {
    return null;
  }

  if (isFreePlan) {
    // For free users, check tenant_id in shared database
    const [rows] = await req.db.query(
      'SELECT id FROM online_stores WHERE id = ? AND tenant_id = ? LIMIT 1',
      { replacements: [numericId, tenantId] }
    );
    if (!rows || rows.length === 0) {
      return null; // Either not found or belongs to another tenant
    }
  }

  // For enterprise users, database is already tenant-isolated
  // So any online store found belongs to this tenant
  return await models.OnlineStore.findByPk(numericId);
}

/**
 * Helper function to verify collection belongs to current tenant's online store
 */
async function verifyCollectionOwnership(req, collection_id) {
  if (!req.db) {
    return null;
  }

  const models = initModels(req.db);
  const collection = await models.StoreCollection.findByPk(collection_id);
  if (!collection) {
    return null;
  }

  // Verify the collection's online store belongs to the tenant
  const onlineStore = await verifyOnlineStoreOwnership(req, collection.online_store_id);
  if (!onlineStore) {
    return null;
  }

  return collection;
}

/**
 * Get products available for adding to store collections
 * This shows products from inventory that can be added to collections
 * Supports pagination with page and limit query parameters
 */
async function getAvailableProducts(req, res) {
  try {
    // Initialize models
    const models = initModels(req.db);
    
    const { online_store_id } = req.params;
    const { search, category, store_id, page = 1, limit = 20 } = req.query;
    
    // Parse pagination parameters
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    // Get online store to check if it's linked to a physical store
    const onlineStore = await models.OnlineStore.findByPk(online_store_id);
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // Build where clause
    const where = {
      is_active: true
    };

    if (search) {
      where[Sequelize.Op.or] = [
        { name: { [Sequelize.Op.like]: `%${search}%` } },
        { sku: { [Sequelize.Op.like]: `%${search}%` } }
      ];
    }

    if (category) {
      where.category = category;
    }

    if (store_id) {
      where.store_id = store_id;
    }

    // Get all product IDs that are already in collections for this online store
    const productsInCollections = await models.StoreCollectionProduct.findAll({
      attributes: ['product_id'],
      include: [
        {
          model: models.StoreCollection,
          where: { online_store_id: online_store_id },
          attributes: []
        }
      ],
      raw: true
    });

    const productIdsInCollections = productsInCollections.map(p => p.product_id).filter(Boolean);

    // Exclude products that are already in collections
    if (productIdsInCollections.length > 0) {
      where.id = {
        [Sequelize.Op.notIn]: productIdsInCollections
      };
    }

    // Get products with pagination using findAndCountAll
    const { count, rows } = await models.Product.findAndCountAll({
      where,
      attributes: ['id', 'name', 'sku', 'price', 'image_url', 'category', 'stock', 'description'],
      order: [['created_at', 'DESC']],
      limit: limitNum,
      offset: offset
    });

    // Convert image_url to full URL for each product
    const products = rows.map(product => {
      const productData = product.toJSON();
      if (productData.image_url) {
        productData.image_url = getFullUrl(req, productData.image_url);
      }
      return productData;
    });

    // If store_id is provided, filter products by store
    // (This would require a store_products relationship if you want to filter by store)
    // For now, return all products

    res.json({
      success: true,
      data: {
        products,
        total: count,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(count / limitNum),
          total_items: count
        }
      }
    });
  } catch (error) {
    console.error('Error getting available products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get available products',
      error: error.message
    });
  }
}

/**
 * Get products already in a collection
 * Works for both free and enterprise users
 * Verifies collection ownership and handles products without store_id (free users)
 */
async function getCollectionProducts(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id } = req.params;

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    // Get tenant info to determine if free user
    const tenant = req.tenant;
    const isFreePlan = tenant && tenant.subscription_plan === 'free';

    // Build Product include with conditional Store association
    // Free users may not have store_id, so Store should be optional
    const productInclude = {
      model: models.Product,
      include: []
    };

    // Only include Store if not free plan (enterprise users have stores)
    // For free users, products might not have store_id
    if (!isFreePlan) {
      productInclude.include.push({
        model: models.Store,
        attributes: ['id', 'name', 'store_type'],
        required: false // Optional in case some products don't have store_id
      });
    }

    const collectionProducts = await models.StoreCollectionProduct.findAll({
      where: { collection_id },
      include: [productInclude],
      order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
    });

    // Normalize product data and convert image URLs
    const products = collectionProducts.map(cp => {
      if (!cp.Product) {
        return null; // Skip if product was deleted
      }
      
      const productData = cp.Product.toJSON();
      
      // Convert image_url to full URL
      if (productData.image_url) {
        productData.image_url = getFullUrl(req, productData.image_url);
      }
      
      // For free users, ensure store_id is not included if null
      if (isFreePlan && productData.store_id === null) {
        delete productData.store_id;
      }
      
      return {
        ...productData,
        is_pinned: cp.is_pinned,
        sort_order: cp.sort_order,
        collection_product_id: cp.id
      };
    }).filter(Boolean); // Remove null entries

    res.json({
      success: true,
      data: {
        collection: {
          id: collection.id,
          collection_name: collection.collection_name,
          collection_type: collection.collection_type
        },
        products
      }
    });
  } catch (error) {
    console.error('Error getting collection products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get collection products',
      error: error.message
    });
  }
}

module.exports = {
  getAvailableProducts,
  getCollectionProducts
};

