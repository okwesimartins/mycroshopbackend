const { Sequelize } = require('sequelize');

/**
 * Get all product bundles
 */
async function getAllBundles(req, res) {
  try {
    const { isActive } = req.query;

    const where = {};
    if (isActive !== undefined) where.is_active = isActive === 'true';

    const bundles = await req.db.models.ProductBundle.findAll({
      where,
      include: [
        {
          model: req.db.models.ProductBundleItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'price', 'image_url']
            }
          ]
        }
      ],
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: { bundles }
    });
  } catch (error) {
    console.error('Error getting bundles:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get bundles'
    });
  }
}

/**
 * Create product bundle
 */
async function createBundle(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const {
      name,
      description,
      bundle_price,
      image_url,
      items // Array of { product_id, quantity }
    } = req.body;

    if (!name || !bundle_price || !items || !Array.isArray(items) || items.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'name, bundle_price, and items are required'
      });
    }

    const bundle = await req.db.models.ProductBundle.create({
      name,
      description: description || null,
      bundle_price: parseFloat(bundle_price),
      image_url: image_url || null,
      is_active: true
    }, { transaction });

    // Add bundle items
    for (const item of items) {
      const { product_id, quantity } = item;

      if (!product_id || !quantity) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Each item must have product_id and quantity'
        });
      }

      // Verify product exists
      const product = await req.db.models.Product.findByPk(product_id);
      if (!product) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Product ${product_id} not found`
        });
      }

      await req.db.models.ProductBundleItem.create({
        bundle_id: bundle.id,
        product_id,
        quantity
      }, { transaction });
    }

    await transaction.commit();

    const completeBundle = await req.db.models.ProductBundle.findByPk(bundle.id, {
      include: [
        {
          model: req.db.models.ProductBundleItem,
          include: [
            {
              model: req.db.models.Product
            }
          ]
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Product bundle created successfully',
      data: { bundle: completeBundle }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error creating bundle:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create bundle'
    });
  }
}

/**
 * Get bundle by ID
 */
async function getBundleById(req, res) {
  try {
    const bundle = await req.db.models.ProductBundle.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.ProductBundleItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'price', 'image_url', 'stock']
            }
          ]
        }
      ]
    });

    if (!bundle) {
      return res.status(404).json({
        success: false,
        message: 'Bundle not found'
      });
    }

    res.json({
      success: true,
      data: { bundle }
    });
  } catch (error) {
    console.error('Error getting bundle:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get bundle'
    });
  }
}

module.exports = {
  getAllBundles,
  createBundle,
  getBundleById
};

