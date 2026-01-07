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

    // Get products with pagination using findAndCountAll
    const { count, rows } = await models.Product.findAndCountAll({
      where,
      attributes: ['id', 'name', 'sku', 'price', 'image_url', 'category'],
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
 */
async function getCollectionProducts(req, res) {
  try {
    // Initialize models
    const models = initModels(req.db);
    
    const { collection_id } = req.params;

    const collectionProducts = await models.StoreCollectionProduct.findAll({
      where: { collection_id },
      include: [
        {
          model: models.Product
        }
      ],
      order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        products: collectionProducts.map(cp => ({
          ...cp.Product.toJSON(),
          is_pinned: cp.is_pinned,
          sort_order: cp.sort_order,
          collection_product_id: cp.id
        }))
      }
    });
  } catch (error) {
    console.error('Error getting collection products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get collection products'
    });
  }
}

module.exports = {
  getAvailableProducts,
  getCollectionProducts
};

