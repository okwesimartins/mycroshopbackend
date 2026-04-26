const initModels = require('../models');

/**
 * List all shipping rates for an online store
 * GET /api/v1/online-stores/:id/shipping-rates
 */
async function getShippingRates(req, res) {
  try {
    const { id: online_store_id } = req.params;
    const models = initModels(req.db);

    const rates = await models.StoreShippingRate.findAll({
      where: { online_store_id },
      order: [['sort_order', 'ASC'], ['created_at', 'ASC']]
    });

    res.json({ success: true, data: rates });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get shipping rates',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Create a shipping rate
 * POST /api/v1/online-stores/:id/shipping-rates
 * Body: { zone_name, description, price, min_order_amount, estimated_days, is_active, sort_order }
 */
async function createShippingRate(req, res) {
  try {
    const { id: online_store_id } = req.params;
    const { zone_name, description, price, min_order_amount, estimated_days, is_active, sort_order } = req.body;
    const models = initModels(req.db);

    if (!zone_name || price === undefined || price === null || price === '') {
      return res.status(400).json({ success: false, message: 'zone_name and price are required' });
    }

    const rate = await models.StoreShippingRate.create({
      online_store_id,
      zone_name: zone_name.trim(),
      description: description || null,
      price: parseFloat(price),
      min_order_amount: min_order_amount != null ? parseFloat(min_order_amount) : null,
      estimated_days: estimated_days || null,
      is_active: is_active !== undefined ? Boolean(is_active) : true,
      sort_order: sort_order !== undefined ? parseInt(sort_order) : 1
    });

    res.status(201).json({ success: true, data: rate });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create shipping rate',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Update a shipping rate
 * PUT /api/v1/online-stores/:id/shipping-rates/:rate_id
 */
async function updateShippingRate(req, res) {
  try {
    const { id: online_store_id, rate_id } = req.params;
    const { zone_name, description, price, min_order_amount, estimated_days, is_active, sort_order } = req.body;
    const models = initModels(req.db);

    const rate = await models.StoreShippingRate.findOne({ where: { id: rate_id, online_store_id } });
    if (!rate) {
      return res.status(404).json({ success: false, message: 'Shipping rate not found' });
    }

    const updates = {};
    if (zone_name !== undefined) updates.zone_name = zone_name.trim();
    if (description !== undefined) updates.description = description || null;
    if (price !== undefined) updates.price = parseFloat(price);
    if (min_order_amount !== undefined) updates.min_order_amount = min_order_amount != null ? parseFloat(min_order_amount) : null;
    if (estimated_days !== undefined) updates.estimated_days = estimated_days || null;
    if (is_active !== undefined) updates.is_active = Boolean(is_active);
    if (sort_order !== undefined) updates.sort_order = parseInt(sort_order);

    await rate.update(updates);

    res.json({ success: true, data: rate });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update shipping rate',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Delete a shipping rate
 * DELETE /api/v1/online-stores/:id/shipping-rates/:rate_id
 */
async function deleteShippingRate(req, res) {
  try {
    const { id: online_store_id, rate_id } = req.params;
    const models = initModels(req.db);

    const rate = await models.StoreShippingRate.findOne({ where: { id: rate_id, online_store_id } });
    if (!rate) {
      return res.status(404).json({ success: false, message: 'Shipping rate not found' });
    }

    await rate.destroy();

    res.json({ success: true, message: 'Shipping rate deleted' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete shipping rate',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  getShippingRates,
  createShippingRate,
  updateShippingRate,
  deleteShippingRate
};
