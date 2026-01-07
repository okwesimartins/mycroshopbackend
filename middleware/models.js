const initializeModels = require('../models');

/**
 * Middleware to initialize models for tenant database
 * Must be used after attachTenantDb middleware
 */
function initializeTenantModels(req, res, next) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models if not already done
    if (!req.db.models) {
      req.db.models = initializeModels(req.db);
    }

    next();
  } catch (error) {
    console.error('Error initializing models:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to initialize models'
    });
  }
}

module.exports = {
  initializeTenantModels
};

