const initModels = require('../models');

function getTenantContext(req) {
  const isFreePlan = req.tenant?.subscription_plan === 'free';
  const tenantId = isFreePlan ? (req.user?.tenantId || null) : null;
  return { isFreePlan, tenantId };
}

/**
 * List all shipping rates for an online store
 * GET /api/v1/stores/online/:id/shipping-rates
 */
async function getShippingRates(req, res) {
  try {
    const { id: online_store_id } = req.params;
    const { isFreePlan, tenantId } = getTenantContext(req);
    const models = initModels(req.db);

    const where = { online_store_id };
    if (isFreePlan && tenantId) where.tenant_id = tenantId;

    const rates = await models.StoreShippingRate.findAll({
      where,
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
 * POST /api/v1/stores/online/:id/shipping-rates
 * Body: { zone_name, description, price, min_order_amount, estimated_days, is_active, sort_order }
 */
async function createShippingRate(req, res) {
  try {
    const { id: online_store_id } = req.params;
    const { zone_name, description, price, min_order_amount, estimated_days, is_active, sort_order } = req.body;
    const { isFreePlan, tenantId } = getTenantContext(req);
    const models = initModels(req.db);

    if (!zone_name || price === undefined || price === null || price === '') {
      return res.status(400).json({ success: false, message: 'zone_name and price are required' });
    }

    // Duplicate zone_name check for this store
    const duplicateWhere = { online_store_id, zone_name: zone_name.trim() };
    if (isFreePlan && tenantId) duplicateWhere.tenant_id = tenantId;

    const existing = await models.StoreShippingRate.findOne({ where: duplicateWhere });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `A shipping rate with zone name "${zone_name.trim()}" already exists for this store`
      });
    }

    const createData = {
      online_store_id,
      zone_name: zone_name.trim(),
      description: description || null,
      price: parseFloat(price),
      min_order_amount: min_order_amount != null ? parseFloat(min_order_amount) : null,
      estimated_days: estimated_days || null,
      is_active: is_active !== undefined ? Boolean(is_active) : true,
      sort_order: sort_order !== undefined ? parseInt(sort_order) : 1
    };
    if (isFreePlan && tenantId) createData.tenant_id = tenantId;

    const rate = await models.StoreShippingRate.create(createData);

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
 * PUT /api/v1/stores/online/:id/shipping-rates/:rate_id
 */
async function updateShippingRate(req, res) {
  try {
    const { id: online_store_id, rate_id } = req.params;
    const { zone_name, description, price, min_order_amount, estimated_days, is_active, sort_order } = req.body;
    const { isFreePlan, tenantId } = getTenantContext(req);
    const models = initModels(req.db);

    const findWhere = { id: rate_id, online_store_id };
    if (isFreePlan && tenantId) findWhere.tenant_id = tenantId;

    const rate = await models.StoreShippingRate.findOne({ where: findWhere });
    if (!rate) {
      return res.status(404).json({ success: false, message: 'Shipping rate not found' });
    }

    // Duplicate zone_name check (exclude current record)
    if (zone_name !== undefined) {
      const { Op } = require('sequelize');
      const dupWhere = { online_store_id, zone_name: zone_name.trim(), id: { [Op.ne]: rate_id } };
      if (isFreePlan && tenantId) dupWhere.tenant_id = tenantId;
      const dup = await models.StoreShippingRate.findOne({ where: dupWhere });
      if (dup) {
        return res.status(409).json({
          success: false,
          message: `A shipping rate with zone name "${zone_name.trim()}" already exists for this store`
        });
      }
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
 * DELETE /api/v1/stores/online/:id/shipping-rates/:rate_id
 */
async function deleteShippingRate(req, res) {
  try {
    const { id: online_store_id, rate_id } = req.params;
    const { isFreePlan, tenantId } = getTenantContext(req);
    const models = initModels(req.db);

    const findWhere = { id: rate_id, online_store_id };
    if (isFreePlan && tenantId) findWhere.tenant_id = tenantId;

    const rate = await models.StoreShippingRate.findOne({ where: findWhere });
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
