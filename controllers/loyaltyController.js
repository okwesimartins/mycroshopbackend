const { Sequelize } = require('sequelize');

/**
 * Get loyalty program settings
 */
async function getLoyaltyProgram(req, res) {
  try {
    const program = await req.db.models.LoyaltyProgram.findOne({
      where: { is_active: true }
    });

    if (!program) {
      return res.status(404).json({
        success: false,
        message: 'No active loyalty program found'
      });
    }

    res.json({
      success: true,
      data: { program }
    });
  } catch (error) {
    console.error('Error getting loyalty program:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get loyalty program'
    });
  }
}

/**
 * Create or update loyalty program
 */
async function setupLoyaltyProgram(req, res) {
  try {
    const {
      name,
      description,
      points_per_currency = 1.00,
      currency_unit = 100.00,
      redemption_rate = 100.00
    } = req.body;

    // Deactivate existing programs
    await req.db.models.LoyaltyProgram.update(
      { is_active: false },
      { where: { is_active: true } }
    );

    // Create new program
    const program = await req.db.models.LoyaltyProgram.create({
      name: name || 'Default Loyalty Program',
      description: description || null,
      points_per_currency: parseFloat(points_per_currency),
      currency_unit: parseFloat(currency_unit),
      redemption_rate: parseFloat(redemption_rate),
      is_active: true
    });

    res.status(201).json({
      success: true,
      message: 'Loyalty program created successfully',
      data: { program }
    });
  } catch (error) {
    console.error('Error setting up loyalty program:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to setup loyalty program'
    });
  }
}

/**
 * Get customer loyalty points
 */
async function getCustomerLoyaltyPoints(req, res) {
  try {
    const { customer_id } = req.params;

    const loyaltyPoints = await req.db.models.CustomerLoyaltyPoints.findOne({
      where: { customer_id },
      include: [
        {
          model: req.db.models.LoyaltyProgram,
          attributes: ['id', 'name', 'points_per_currency', 'redemption_rate']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone']
        }
      ]
    });

    if (!loyaltyPoints) {
      // Initialize if doesn't exist
      const program = await req.db.models.LoyaltyProgram.findOne({
        where: { is_active: true }
      });

      if (program) {
        const newLoyaltyPoints = await req.db.models.CustomerLoyaltyPoints.create({
          customer_id,
          loyalty_program_id: program.id,
          total_points: 0,
          available_points: 0,
          tier: 'bronze'
        });

        return res.json({
          success: true,
          data: { loyalty_points: newLoyaltyPoints }
        });
      }

      return res.status(404).json({
        success: false,
        message: 'No active loyalty program found'
      });
    }

    res.json({
      success: true,
      data: { loyalty_points: loyaltyPoints }
    });
  } catch (error) {
    console.error('Error getting customer loyalty points:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get customer loyalty points'
    });
  }
}

/**
 * Earn points from transaction
 */
async function earnPointsFromTransaction(req, res) {
  try {
    const { customer_id, transaction_id, transaction_type = 'pos', amount } = req.body;

    if (!customer_id || !amount) {
      return res.status(400).json({
        success: false,
        message: 'customer_id and amount are required'
      });
    }

    const program = await req.db.models.LoyaltyProgram.findOne({
      where: { is_active: true }
    });

    if (!program) {
      return res.status(404).json({
        success: false,
        message: 'No active loyalty program found'
      });
    }

    // Calculate points earned
    // Example: 1 point per ₦100 spent
    const pointsEarned = Math.floor((amount / program.currency_unit) * program.points_per_currency);

    // Get or create customer loyalty record
    let loyaltyPoints = await req.db.models.CustomerLoyaltyPoints.findOne({
      where: { customer_id, loyalty_program_id: program.id }
    });

    if (!loyaltyPoints) {
      loyaltyPoints = await req.db.models.CustomerLoyaltyPoints.create({
        customer_id,
        loyalty_program_id: program.id,
        total_points: 0,
        redeemed_points: 0,
        available_points: 0,
        lifetime_points: 0,
        tier: 'bronze'
      });
    }

    // Update points
    await loyaltyPoints.update({
      total_points: parseFloat(loyaltyPoints.total_points) + pointsEarned,
      available_points: parseFloat(loyaltyPoints.available_points) + pointsEarned,
      lifetime_points: parseFloat(loyaltyPoints.lifetime_points) + pointsEarned
    });

    // Record transaction
    await req.db.models.LoyaltyPointTransaction.create({
      customer_id,
      loyalty_program_id: program.id,
      transaction_type: 'earned',
      points: pointsEarned,
      reference_type: transaction_type === 'pos' ? 'pos_transaction' : 'invoice',
      reference_id: transaction_id,
      description: `Earned ${pointsEarned} points from ${transaction_type} transaction`
    });

    // Update tier based on lifetime points
    let newTier = 'bronze';
    if (loyaltyPoints.lifetime_points >= 10000) newTier = 'gold';
    else if (loyaltyPoints.lifetime_points >= 5000) newTier = 'silver';

    if (newTier !== loyaltyPoints.tier) {
      await loyaltyPoints.update({ tier: newTier });
    }

    res.json({
      success: true,
      message: `Customer earned ${pointsEarned} points`,
      data: {
        points_earned: pointsEarned,
        total_points: parseFloat(loyaltyPoints.total_points) + pointsEarned,
        tier: newTier
      }
    });
  } catch (error) {
    console.error('Error earning points:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to earn points'
    });
  }
}

/**
 * Redeem points
 */
async function redeemPoints(req, res) {
  try {
    const { customer_id, points_to_redeem, description } = req.body;

    if (!customer_id || !points_to_redeem) {
      return res.status(400).json({
        success: false,
        message: 'customer_id and points_to_redeem are required'
      });
    }

    const loyaltyPoints = await req.db.models.CustomerLoyaltyPoints.findOne({
      where: { customer_id },
      include: [
        {
          model: req.db.models.LoyaltyProgram
        }
      ]
    });

    if (!loyaltyPoints) {
      return res.status(404).json({
        success: false,
        message: 'Customer has no loyalty points'
      });
    }

    if (parseFloat(loyaltyPoints.available_points) < points_to_redeem) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient points'
      });
    }

    // Calculate redemption value
    const program = loyaltyPoints.LoyaltyProgram;
    const redemptionValue = (points_to_redeem / program.redemption_rate) * program.currency_unit;

    // Update points
    await loyaltyPoints.update({
      redeemed_points: parseFloat(loyaltyPoints.redeemed_points) + points_to_redeem,
      available_points: parseFloat(loyaltyPoints.available_points) - points_to_redeem
    });

    // Record transaction
    await req.db.models.LoyaltyPointTransaction.create({
      customer_id,
      loyalty_program_id: program.id,
      transaction_type: 'redeemed',
      points: -points_to_redeem,
      description: description || `Redeemed ${points_to_redeem} points (₦${redemptionValue.toFixed(2)} value)`
    });

    res.json({
      success: true,
      message: 'Points redeemed successfully',
      data: {
        points_redeemed: points_to_redeem,
        redemption_value: redemptionValue,
        remaining_points: parseFloat(loyaltyPoints.available_points) - points_to_redeem
      }
    });
  } catch (error) {
    console.error('Error redeeming points:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to redeem points'
    });
  }
}

/**
 * Get customer loyalty history
 */
async function getCustomerLoyaltyHistory(req, res) {
  try {
    const { customer_id } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const { count, rows } = await req.db.models.LoyaltyPointTransaction.findAndCountAll({
      where: { customer_id },
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        transactions: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting loyalty history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get loyalty history'
    });
  }
}

module.exports = {
  getLoyaltyProgram,
  setupLoyaltyProgram,
  getCustomerLoyaltyPoints,
  earnPointsFromTransaction,
  redeemPoints,
  getCustomerLoyaltyHistory
};

