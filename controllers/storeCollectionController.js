const { Sequelize } = require('sequelize');
const initModels = require('../models');

/**
 * Helper function to normalize service data (parse availability from string to JSON)
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
 * Get all collections for an online store
 */
async function getStoreCollections(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { online_store_id } = req.params;
    const { is_visible, collection_type } = req.query;

    // Verify online store belongs to current tenant
    const onlineStore = await verifyOnlineStoreOwnership(req, online_store_id);
    if (!onlineStore) {
      return res.status(403).json({
        success: false,
        message: 'Online store not found or access denied'
      });
    }

    const where = { online_store_id };
    if (is_visible !== undefined) {
      where.is_visible = is_visible === 'true';
    }
    if (collection_type) {
      where.collection_type = collection_type; // 'product' or 'service'
    }

    const collections = await models.StoreCollection.findAll({
      where,
      order: [['sort_order', 'ASC'], ['created_at', 'DESC']]
    });

    // Count items in each collection based on collection type
    const collectionsWithCounts = await Promise.all(collections.map(async (collection) => {
      let productCount = 0;
      let serviceCount = 0;

      if (collection.collection_type === 'product') {
        productCount = await models.StoreCollectionProduct.count({
        where: { collection_id: collection.id }
      });
      } else if (collection.collection_type === 'service') {
        serviceCount = await models.StoreCollectionService.count({
          where: { collection_id: collection.id }
        });
      }

      return {
        ...collection.toJSON(),
        productCount,
        serviceCount,
        totalItems: productCount + serviceCount
      };
    }));

    res.json({
      success: true,
      data: { collections: collectionsWithCounts }
    });
  } catch (error) {
    console.error('Error getting store collections:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store collections'
    });
  }
}

/**
 * Get collection by ID
 */
async function getCollectionById(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, req.params.id);
    
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    // Build includes based on collection type
    const includes = [];
    
    if (collection.collection_type === 'product') {
      includes.push({
        model: models.StoreCollectionProduct,
        required: false,
      include: [
        {
            model: models.Product
          }
        ],
        order: [['sort_order', 'ASC']]
      });
    } else if (collection.collection_type === 'service') {
      includes.push({
        model: models.StoreCollectionService,
        required: false,
          include: [
            {
            model: models.StoreService,
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
    }

    // Reload with appropriate includes
    const collectionWithItems = await models.StoreCollection.findByPk(req.params.id, {
      include: includes
    });

    // Get counts based on collection type
    let productCount = 0;
    let serviceCount = 0;
    
    if (collection.collection_type === 'product') {
      productCount = await models.StoreCollectionProduct.count({
        where: { collection_id: collection.id }
      });
    } else {
      serviceCount = await models.StoreCollectionService.count({
        where: { collection_id: collection.id }
      });
    }

    const collectionData = collectionWithItems.toJSON();
    collectionData.productCount = productCount;
    collectionData.serviceCount = serviceCount;
    collectionData.totalItems = productCount + serviceCount;

    // Normalize availability for services if this is a service collection
    if (collection.collection_type === 'service' && collectionData.StoreCollectionServices) {
      // Normalize availability in nested StoreService objects
      collectionData.StoreCollectionServices = collectionData.StoreCollectionServices.map(cs => {
        if (cs.StoreService) {
          cs.StoreService = normalizeServiceData(cs.StoreService);
        }
        return cs;
      });
    }

    res.json({
      success: true,
      data: { collection: collectionData }
    });
  } catch (error) {
    console.error('Error getting collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get collection'
    });
  }
}

/**
 * Create collection
 */
async function createCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { online_store_id } = req.params;
    const {
      collection_name,
      collection_type, // Required: 'product' or 'service'
      layout_type,
      is_pinned,
      is_visible,
      sort_order
    } = req.body;

    // Validate collection_type
    if (!collection_type || !['product', 'service'].includes(collection_type)) {
      return res.status(400).json({
        success: false,
        message: 'collection_type is required and must be either "product" or "service"'
      });
    }

    // Verify online store belongs to current tenant
    const onlineStore = await verifyOnlineStoreOwnership(req, online_store_id);
    if (!onlineStore) {
      return res.status(403).json({
        success: false,
        message: 'Online store not found or access denied'
      });
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

    // Handle smart sort order: determine target sort_order and rearrange existing collections
    let targetSortOrder;
    if (sort_order !== undefined && sort_order !== null) {
      // User specified a sort_order - use smart rearrangement
      targetSortOrder = parseInt(sort_order) || 1;
      
      // Find all existing collections for this online store with sort_order >= targetSortOrder
      const existingCollectionsToShift = await models.StoreCollection.findAll({
        where: {
          online_store_id,
          sort_order: {
            [Sequelize.Op.gte]: targetSortOrder
          }
        },
        order: [['sort_order', 'DESC']] // Start from highest to avoid conflicts
      });

      // Increment sort_order for all collections that need to be shifted
      if (existingCollectionsToShift.length > 0) {
        for (const existingCollection of existingCollectionsToShift) {
          await existingCollection.update({
            sort_order: (parseInt(existingCollection.sort_order) || 0) + 1
          });
        }
      }
    } else {
      // No sort_order specified - append at the end (max + 1) or use 1 if no records exist
      const maxSortOrder = await models.StoreCollection.max('sort_order', {
        where: { online_store_id }
      });
      
      if (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) {
        targetSortOrder = 1; // First collection
      } else {
        targetSortOrder = (parseInt(maxSortOrder) || 0) + 1; // Append at end
      }
    }

    const collection = await models.StoreCollection.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      online_store_id,
      collection_name,
      collection_type,
      layout_type: layout_type || 'grid',
      is_pinned: is_pinned || false,
      is_visible: is_visible !== undefined ? is_visible : true,
      sort_order: targetSortOrder
    });

    res.status(201).json({
      success: true,
      message: 'Collection created successfully',
      data: { collection }
    });
  } catch (error) {
    console.error('Error creating collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create collection'
    });
  }
}

/**
 * Update collection
 */
async function updateCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, req.params.id);
    
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    const {
      collection_name,
      collection_type,
      layout_type,
      is_pinned,
      is_visible,
      sort_order
    } = req.body;

    // Validate collection_type if provided
    if (collection_type !== undefined && !['product', 'service'].includes(collection_type)) {
      return res.status(400).json({
        success: false,
        message: 'collection_type must be either "product" or "service"'
      });
    }

    // Handle smart sort_order rearrangement if sort_order is being updated
    if (sort_order !== undefined && sort_order !== collection.sort_order) {
      const oldSortOrder = collection.sort_order;
      const newSortOrder = sort_order;
      const online_store_id = collection.online_store_id;

      if (newSortOrder > oldSortOrder) {
        // Moving down: shift collections between old and new position up
        const collectionsToShift = await models.StoreCollection.findAll({
          where: {
            online_store_id,
            id: { [Sequelize.Op.ne]: collection.id },
            sort_order: {
              [Sequelize.Op.gt]: oldSortOrder,
              [Sequelize.Op.lte]: newSortOrder
            }
          },
          order: [['sort_order', 'ASC']]
        });

        for (const col of collectionsToShift) {
          await col.update({ sort_order: col.sort_order - 1 });
        }
      } else if (newSortOrder < oldSortOrder) {
        // Moving up: shift collections between new and old position down
        const collectionsToShift = await models.StoreCollection.findAll({
          where: {
            online_store_id,
            id: { [Sequelize.Op.ne]: collection.id },
            sort_order: {
              [Sequelize.Op.gte]: newSortOrder,
              [Sequelize.Op.lt]: oldSortOrder
            }
          },
          order: [['sort_order', 'DESC']]
        });

        for (const col of collectionsToShift) {
          await col.update({ sort_order: col.sort_order + 1 });
        }
      }
    }

    await collection.update({
      ...(collection_name !== undefined && { collection_name }),
      ...(collection_type !== undefined && { collection_type }),
      ...(layout_type !== undefined && { layout_type }),
      ...(is_pinned !== undefined && { is_pinned }),
      ...(is_visible !== undefined && { is_visible }),
      ...(sort_order !== undefined && { sort_order })
    });

    res.json({
      success: true,
      message: 'Collection updated successfully',
      data: { collection }
    });
  } catch (error) {
    console.error('Error updating collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update collection'
    });
  }
}

/**
 * Update collection sort order (for drag and drop reordering)
 * Accepts array of collection IDs in new order
 */
async function updateCollectionSortOrder(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { online_store_id } = req.params;
    const { collection_ids } = req.body; // Array of collection IDs in new order

    if (!Array.isArray(collection_ids) || collection_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'collection_ids must be a non-empty array'
      });
    }

    // Verify online store belongs to current tenant
    const onlineStore = await verifyOnlineStoreOwnership(req, online_store_id);
    if (!onlineStore) {
      return res.status(403).json({
        success: false,
        message: 'Online store not found or access denied'
      });
    }

    // Verify all collections belong to this online store and tenant
    for (const collectionId of collection_ids) {
      const collection = await verifyCollectionOwnership(req, collectionId);
      if (!collection || collection.online_store_id !== Number(online_store_id)) {
        return res.status(403).json({
          success: false,
          message: `Collection ${collectionId} not found or does not belong to this online store`
        });
      }
    }

    // Update sort_order for each collection based on its position in array
    const updatePromises = collection_ids.map((collectionId, index) => {
      return models.StoreCollection.update(
        { sort_order: index + 1 },
        {
          where: {
            id: collectionId,
            online_store_id: online_store_id
          }
        }
      );
    });

    await Promise.all(updatePromises);

    // Fetch updated collections
    const collections = await models.StoreCollection.findAll({
      where: { online_store_id },
      order: [['sort_order', 'ASC']]
    });

    res.json({
      success: true,
      message: 'Collection sort order updated successfully',
      data: { collections }
    });
  } catch (error) {
    console.error('Error updating collection sort order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update collection sort order',
      error: error.message
    });
  }
}

/**
 * Delete collection
 */
async function deleteCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, req.params.id);
    
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    await collection.destroy();

    res.json({
      success: true,
      message: 'Collection deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete collection'
    });
  }
}

/**
 * Add product to collection
 */
async function addProductToCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id } = req.params;
    const { product_id, is_pinned, sort_order } = req.body;

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    // Validate collection type
    if (collection.collection_type !== 'product') {
      return res.status(400).json({
        success: false,
        message: 'Cannot add products to a service collection. Use a product collection instead.'
      });
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

    // Check if product exists
    // For free users, exclude advanced inventory fields that don't exist in the table
    let product;
    if (isFreePlan) {
      // For free users, exclude columns that don't exist in free tier database
      // Columns NOT available for free users: store_id, barcode, cost, low_stock_threshold, expiry_date, batch_number, unit_of_measure
      product = await models.Product.findOne({
        where: { id: product_id },
        attributes: {
          exclude: ['store_id', 'barcode', 'cost', 'low_stock_threshold', 'expiry_date', 'batch_number', 'unit_of_measure']
        },
        include: [] // Explicitly exclude all associations
      });
    } else {
      product = await models.Product.findByPk(product_id);
    }
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check if already in collection
    const existing = await models.StoreCollectionProduct.findOne({
      where: { collection_id, product_id }
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Product already in collection'
      });
    }

    // Handle smart sort_order: determine target sort_order and rearrange existing products
    let targetSortOrder;
    if (sort_order !== undefined && sort_order !== null) {
      // User specified a sort_order - use smart rearrangement
      targetSortOrder = parseInt(sort_order) || 1;
      
      // Find all existing products in this collection with sort_order >= targetSortOrder
      const existingProductsToShift = await models.StoreCollectionProduct.findAll({
        where: {
          collection_id,
          sort_order: {
            [Sequelize.Op.gte]: targetSortOrder
          }
        },
        order: [['sort_order', 'DESC']] // Start from highest to avoid conflicts
      });

      // Increment sort_order for all products that need to be shifted
      if (existingProductsToShift.length > 0) {
        for (const existingProduct of existingProductsToShift) {
          await existingProduct.update({
            sort_order: (parseInt(existingProduct.sort_order) || 0) + 1
          });
        }
      }
    } else {
      // No sort_order specified - append at the end (max + 1) or use 1 if no records exist
      const maxSortOrder = await models.StoreCollectionProduct.max('sort_order', {
        where: { collection_id }
      });
      
      if (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) {
        targetSortOrder = 1; // First product
      } else {
        targetSortOrder = (parseInt(maxSortOrder) || 0) + 1; // Append at end
      }
    }

    const collectionProduct = await models.StoreCollectionProduct.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      collection_id,
      product_id,
      is_pinned: is_pinned || false,
      sort_order: targetSortOrder
    });

    res.status(201).json({
      success: true,
      message: 'Product added to collection successfully',
      data: { collectionProduct }
    });
  } catch (error) {
    console.error('Error adding product to collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add product to collection'
    });
  }
}

/**
 * Remove product from collection
 */
async function removeProductFromCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id, product_id } = req.params;

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    const collectionProduct = await models.StoreCollectionProduct.findOne({
      where: { collection_id, product_id }
    });

    if (!collectionProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found in collection'
      });
    }

    await collectionProduct.destroy();

    res.json({
      success: true,
      message: 'Product removed from collection successfully'
    });
  } catch (error) {
    console.error('Error removing product from collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove product from collection'
    });
  }
}

/**
 * Update product in collection (pin, sort order)
 */
async function updateProductInCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id, product_id } = req.params;
    const { is_pinned, sort_order } = req.body;

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    const collectionProduct = await models.StoreCollectionProduct.findOne({
      where: { collection_id, product_id }
    });

    if (!collectionProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found in collection'
      });
    }

    // Handle smart sort_order rearrangement if sort_order is being updated
    if (sort_order !== undefined && sort_order !== null) {
      // Convert 0 to 1 (minimum sort_order is 1)
      const oldSortOrder = Math.max(parseInt(collectionProduct.sort_order) || 0, 0);
      let newSortOrder = parseInt(sort_order) || 1;
      if (newSortOrder < 1) newSortOrder = 1; // Ensure minimum is 1

      if (newSortOrder !== oldSortOrder && oldSortOrder > 0) {
        if (newSortOrder > oldSortOrder) {
          // Moving down: shift products between old and new position up (decrease their sort_order)
          const productsToShift = await models.StoreCollectionProduct.findAll({
            where: {
              collection_id,
              id: { [Sequelize.Op.ne]: collectionProduct.id },
              [Sequelize.Op.and]: [
                { sort_order: { [Sequelize.Op.gt]: oldSortOrder } },
                { sort_order: { [Sequelize.Op.lte]: newSortOrder } }
              ]
            },
            order: [['sort_order', 'ASC']]
          });

          for (const prod of productsToShift) {
            const currentSortOrder = parseInt(prod.sort_order) || 0;
            await models.StoreCollectionProduct.update(
              { sort_order: currentSortOrder - 1 },
              { where: { id: prod.id } }
            );
          }
        } else if (newSortOrder < oldSortOrder) {
          // Moving up: shift products between new and old position down (increase their sort_order)
          const productsToShift = await models.StoreCollectionProduct.findAll({
            where: {
              collection_id,
              id: { [Sequelize.Op.ne]: collectionProduct.id },
              [Sequelize.Op.and]: [
                { sort_order: { [Sequelize.Op.gte]: newSortOrder } },
                { sort_order: { [Sequelize.Op.lt]: oldSortOrder } }
              ]
            },
            order: [['sort_order', 'DESC']]
          });

          for (const prod of productsToShift) {
            const currentSortOrder = parseInt(prod.sort_order) || 0;
            await models.StoreCollectionProduct.update(
              { sort_order: currentSortOrder + 1 },
              { where: { id: prod.id } }
            );
          }
        }
      }
    }

    // Ensure sort_order is at least 1
    const finalSortOrder = (sort_order !== undefined && sort_order !== null) 
      ? Math.max(parseInt(sort_order) || 1, 1) 
      : undefined;

    await collectionProduct.update({
      ...(is_pinned !== undefined && { is_pinned: is_pinned ? true : false }),
      ...(finalSortOrder !== undefined && { sort_order: finalSortOrder })
    });

    res.json({
      success: true,
      message: 'Product in collection updated successfully',
      data: { collectionProduct }
    });
  } catch (error) {
    console.error('Error updating product in collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product in collection'
    });
  }
}

/**
 * Add multiple products to collection
 */
async function addProductsToCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id } = req.params;
    const { product_ids } = req.body; // Array of product IDs

    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'product_ids must be a non-empty array'
      });
    }

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
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

    // Add products (skip if already exists)
    const added = [];
    const skipped = [];

    for (const product_id of product_ids) {
      const existing = await models.StoreCollectionProduct.findOne({
        where: { collection_id, product_id }
      });

      if (!existing) {
        // Get max sort_order for this collection and assign next position
        const maxSortOrder = await models.StoreCollectionProduct.max('sort_order', {
          where: { collection_id }
        });
        const nextSortOrder = (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) 
          ? 1 
          : (parseInt(maxSortOrder) || 0) + 1;

        const collectionProduct = await models.StoreCollectionProduct.create({
          tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
          collection_id,
          product_id,
          sort_order: nextSortOrder
        });
        added.push(collectionProduct);
      } else {
        skipped.push(product_id);
      }
    }

    res.json({
      success: true,
      message: `Added ${added.length} product(s) to collection`,
      data: {
        added: added.length,
        skipped: skipped.length,
        skipped_ids: skipped
      }
    });
  } catch (error) {
    console.error('Error adding products to collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add products to collection'
    });
  }
}

/**
 * Get services in a collection
 */
async function getCollectionServices(req, res) {
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

    const collectionServices = await models.StoreCollectionService.findAll({
      where: { collection_id },
      include: [
        {
          model: models.StoreService,
          include: [
            {
              model: models.Store,
              attributes: ['id', 'name', 'store_type'],
              required: false
            }
          ]
        }
      ],
      order: [['sort_order', 'ASC'], ['created_at', 'ASC']]
    });

    // Normalize service data (parse availability from string to JSON)
    const services = collectionServices.map(cs => {
      const normalizedService = normalizeServiceData(cs.StoreService);
      return {
        ...normalizedService,
        is_pinned: cs.is_pinned,
        sort_order: cs.sort_order,
        collection_service_id: cs.id
      };
    });

    res.json({
      success: true,
      data: {
        collection: {
          id: collection.id,
          collection_name: collection.collection_name
        },
        services
      }
    });
  } catch (error) {
    console.error('Error getting collection services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get collection services',
      error: error.message
    });
  }
}

/**
 * Add service to collection
 */
async function addServiceToCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id } = req.params;
    const { service_id, is_pinned, sort_order } = req.body;

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    // Validate collection type
    if (collection.collection_type !== 'service') {
      return res.status(400).json({
        success: false,
        message: 'Cannot add services to a product collection. Use a service collection instead.'
      });
    }

    // Check if service exists
    const service = await models.StoreService.findByPk(service_id);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Check if already in collection
    const existing = await models.StoreCollectionService.findOne({
      where: { collection_id, service_id }
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Service already in collection'
      });
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

    // Handle smart sort_order: determine target sort_order and rearrange existing services
    let targetSortOrder;
    if (sort_order !== undefined && sort_order !== null) {
      // User specified a sort_order - use smart rearrangement
      targetSortOrder = parseInt(sort_order) || 1;
      
      // Find all existing services in this collection with sort_order >= targetSortOrder
      const existingServicesToShift = await models.StoreCollectionService.findAll({
        where: {
          collection_id,
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
      const maxSortOrder = await models.StoreCollectionService.max('sort_order', {
        where: { collection_id }
      });
      
      if (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) {
        targetSortOrder = 1; // First service
      } else {
        targetSortOrder = (parseInt(maxSortOrder) || 0) + 1; // Append at end
      }
    }

    const collectionService = await models.StoreCollectionService.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      collection_id,
      service_id,
      store_id: service.store_id || null,
      is_pinned: is_pinned || false,
      sort_order: targetSortOrder
    });

    res.status(201).json({
      success: true,
      message: 'Service added to collection successfully',
      data: { collectionService }
    });
  } catch (error) {
    console.error('Error adding service to collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add service to collection',
      error: error.message
    });
  }
}

/**
 * Remove service from collection
 */
async function removeServiceFromCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id, service_id } = req.params;

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    const collectionService = await models.StoreCollectionService.findOne({
      where: { collection_id, service_id }
    });

    if (!collectionService) {
      return res.status(404).json({
        success: false,
        message: 'Service not found in collection'
      });
    }

    await collectionService.destroy();

    res.json({
      success: true,
      message: 'Service removed from collection successfully'
    });
  } catch (error) {
    console.error('Error removing service from collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove service from collection',
      error: error.message
    });
  }
}

/**
 * Update service in collection (pin, sort order)
 */
async function updateServiceInCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id, service_id } = req.params;
    const { is_pinned, sort_order } = req.body;

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    const collectionService = await models.StoreCollectionService.findOne({
      where: { collection_id, service_id }
    });

    if (!collectionService) {
      return res.status(404).json({
        success: false,
        message: 'Service not found in collection'
      });
    }

    // Handle smart sort_order rearrangement if sort_order is being updated
    if (sort_order !== undefined && sort_order !== null) {
      // Get old sort_order (may be 0 from database default)
      const oldSortOrderRaw = parseInt(collectionService.sort_order) || 0;
      const oldSortOrder = oldSortOrderRaw > 0 ? oldSortOrderRaw : 0; // Keep 0 for special handling
      let newSortOrder = parseInt(sort_order) || 1;
      if (newSortOrder < 1) newSortOrder = 1; // Ensure minimum is 1

      // If old sort_order is 0, treat it as if it was at the end for rearrangement purposes
      if (newSortOrder !== oldSortOrder) {
        // If old sort_order is 0, we don't need to shift anything (it's already effectively at the end)
        // Just update to the new position and shift others if needed
        if (oldSortOrder === 0) {
          // Old was 0, new is specified - shift services at new position and below
          const servicesToShift = await models.StoreCollectionService.findAll({
            where: {
              collection_id,
              id: { [Sequelize.Op.ne]: collectionService.id },
              sort_order: {
                [Sequelize.Op.gte]: newSortOrder
              }
            },
            order: [['sort_order', 'DESC']]
          });

          for (const svc of servicesToShift) {
            const currentSortOrder = parseInt(svc.sort_order) || 0;
            await models.StoreCollectionService.update(
              { sort_order: currentSortOrder + 1 },
              { where: { id: svc.id } }
            );
          }
        } else if (newSortOrder > oldSortOrder) {
          // Moving down: shift services between old and new position up (decrease their sort_order)
          // Find services with sort_order > oldSortOrder AND <= newSortOrder
          const servicesToShift = await models.StoreCollectionService.findAll({
            where: {
              collection_id,
              id: { [Sequelize.Op.ne]: collectionService.id },
              sort_order: {
                [Sequelize.Op.gt]: oldSortOrder,
                [Sequelize.Op.lte]: newSortOrder
              }
            },
            order: [['sort_order', 'ASC']]
          });

          // Shift each service down by 1
          for (const svc of servicesToShift) {
            const currentSortOrder = parseInt(svc.sort_order) || 0;
            await models.StoreCollectionService.update(
              { sort_order: currentSortOrder - 1 },
              { where: { id: svc.id } }
            );
          }
        } else if (newSortOrder < oldSortOrder) {
          // Moving up: shift services between new and old position down (increase their sort_order)
          // Find services with sort_order >= newSortOrder AND < oldSortOrder
          // These are the services that need to be pushed down to make room
          // Example: Moving service from position 2 to 1, need to shift services at position 1 to position 2
          const servicesToShift = await models.StoreCollectionService.findAll({
            where: {
              collection_id,
              id: { [Sequelize.Op.ne]: collectionService.id },
              [Sequelize.Op.and]: [
                { sort_order: { [Sequelize.Op.gte]: newSortOrder } },
                { sort_order: { [Sequelize.Op.lt]: oldSortOrder } }
              ]
            },
            order: [['sort_order', 'DESC']] // Process from highest first to avoid conflicts
          });

          // Shift each service up by 1 (increase sort_order)
          for (const svc of servicesToShift) {
            const currentSortOrder = parseInt(svc.sort_order) || 0;
            const newSort = currentSortOrder + 1;
            await models.StoreCollectionService.update(
              { sort_order: newSort },
              { where: { id: svc.id } }
            );
          }
        }
      }
    }

    // Ensure sort_order is at least 1
    const finalSortOrder = (sort_order !== undefined && sort_order !== null) 
      ? Math.max(parseInt(sort_order) || 1, 1) 
      : undefined;

    await collectionService.update({
      ...(is_pinned !== undefined && { is_pinned: is_pinned ? true : false }),
      ...(finalSortOrder !== undefined && { sort_order: finalSortOrder })
    });

    // Reload to get updated data
    await collectionService.reload();

    res.json({
      success: true,
      message: 'Service updated in collection successfully',
      data: { collectionService }
    });
  } catch (error) {
    console.error('Error updating service in collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update service in collection',
      error: error.message
    });
  }
}

/**
 * Add multiple services to collection (bulk)
 */
async function addServicesToCollection(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { collection_id } = req.params;
    const { service_ids } = req.body; // Array of service IDs

    if (!Array.isArray(service_ids) || service_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'service_ids must be a non-empty array'
      });
    }

    // Verify collection belongs to current tenant
    const collection = await verifyCollectionOwnership(req, collection_id);
    if (!collection) {
      return res.status(403).json({
        success: false,
        message: 'Collection not found or access denied'
      });
    }

    // Get existing services in collection
    const existingServices = await models.StoreCollectionService.findAll({
      where: { collection_id },
      attributes: ['service_id']
    });

    const existingServiceIds = existingServices.map(es => es.service_id);

    // Filter out services already in collection
    const servicesToAdd = service_ids.filter(id => !existingServiceIds.includes(parseInt(id)));

    if (servicesToAdd.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'All services are already in the collection'
      });
    }

    // Verify all services exist
    const services = await models.StoreService.findAll({
      where: { id: { [Sequelize.Op.in]: servicesToAdd } }
    });

    if (services.length !== servicesToAdd.length) {
      return res.status(404).json({
        success: false,
        message: 'One or more services not found'
      });
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

    // Get max sort_order to start assigning from there
    const maxSortOrder = await models.StoreCollectionService.max('sort_order', {
      where: { collection_id }
    });
    let nextSortOrder = (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) 
      ? 1 
      : (parseInt(maxSortOrder) || 0) + 1;

    // Bulk create collection services with sequential sort_order
    const collectionServices = await models.StoreCollectionService.bulkCreate(
      servicesToAdd.map((serviceId, index) => ({
        tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
        collection_id,
        service_id: parseInt(serviceId),
        store_id: services.find(s => s.id === parseInt(serviceId))?.store_id || null,
        is_pinned: false,
        sort_order: nextSortOrder + index
      }))
    );

    res.status(201).json({
      success: true,
      message: `${collectionServices.length} service(s) added to collection successfully`,
      data: { collectionServices }
    });
  } catch (error) {
    console.error('Error adding services to collection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add services to collection',
      error: error.message
    });
  }
}

module.exports = {
  getStoreCollections,
  getCollectionById,
  createCollection,
  updateCollection,
  updateCollectionSortOrder,
  deleteCollection,
  addProductToCollection,
  removeProductFromCollection,
  updateProductInCollection,
  addProductsToCollection,
  getCollectionServices,
  addServiceToCollection,
  removeServiceFromCollection,
  updateServiceInCollection,
  addServicesToCollection
};

