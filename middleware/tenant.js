const { getTenantConnection } = require('../config/database');
const { getTenantById } = require('../config/tenant');

/**
 * Middleware to attach tenant database connection to request
 * Must be used after auth middleware
 */
async function attachTenantDb(req, res, next) {
  try {
    if (!req.user || !req.user.tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Get tenant info to determine subscription plan
    const tenant = await getTenantById(req.user.tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Get tenant database connection (pass subscription plan)
    const sequelize = await getTenantConnection(req.user.tenantId, tenant.subscription_plan || 'enterprise');
    req.db = sequelize;
    req.tenant = tenant; // Attach tenant info to request

    next();
  } catch (error) {
    console.error('Error attaching tenant database:', error);
    return res.status(500).json({
      success: false,
      message: 'Database connection error'
    });
  }
}

module.exports = {
  attachTenantDb
};

