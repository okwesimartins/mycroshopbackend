const { Sequelize } = require('sequelize');
const moment = require('moment');

/**
 * Get products expiring soon
 */
async function getExpiringProducts(req, res) {
  try {
    const { days = 30, store_id } = req.query;
    const expiryDate = moment().add(parseInt(days), 'days').format('YYYY-MM-DD');

    const where = {
      expiry_date: {
        [Sequelize.Op.between]: [moment().format('YYYY-MM-DD'), expiryDate]
      },
      is_active: true
    };

    if (store_id) {
      where.store_id = store_id;
    }

    const products = await req.db.models.Product.findAll({
      where,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ],
      order: [['expiry_date', 'ASC']]
    });

    res.json({
      success: true,
      data: {
        products,
        expiry_threshold_days: parseInt(days)
      }
    });
  } catch (error) {
    console.error('Error getting expiring products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get expiring products'
    });
  }
}

/**
 * Get expired products
 */
async function getExpiredProducts(req, res) {
  try {
    const { store_id } = req.query;
    const today = moment().format('YYYY-MM-DD');

    const where = {
      expiry_date: {
        [Sequelize.Op.lt]: today
      },
      is_active: true
    };

    if (store_id) {
      where.store_id = store_id;
    }

    const products = await req.db.models.Product.findAll({
      where,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ],
      order: [['expiry_date', 'ASC']]
    });

    res.json({
      success: true,
      data: { products }
    });
  } catch (error) {
    console.error('Error getting expired products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get expired products'
    });
  }
}

/**
 * Mark expired products as inactive
 */
async function markExpiredAsInactive(req, res) {
  try {
    const today = moment().format('YYYY-MM-DD');
    const { store_id } = req.query;

    const where = {
      expiry_date: {
        [Sequelize.Op.lt]: today
      },
      is_active: true
    };

    if (store_id) {
      where.store_id = store_id;
    }

    const [updatedCount] = await req.db.models.Product.update(
      { is_active: false },
      { where }
    );

    res.json({
      success: true,
      message: `${updatedCount} expired product(s) marked as inactive`,
      data: { updated_count: updatedCount }
    });
  } catch (error) {
    console.error('Error marking expired products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark expired products'
    });
  }
}

module.exports = {
  getExpiringProducts,
  getExpiredProducts,
  markExpiredAsInactive
};