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
      const models = initializeModels(req.db);
      if (!models || !models.Invoice) {
        console.error('Models initialization failed. Available models:', models ? Object.keys(models) : 'none');
        return res.status(500).json({
          success: false,
          message: 'Failed to initialize database models. Invoice model not found.'
        });
      }
      req.db.models = models;
    }

    // Verify Invoice model exists
    if (!req.db.models.Invoice) {
      console.error('Invoice model not found. Available models:', Object.keys(req.db.models || {}));
      return res.status(500).json({
        success: false,
        message: 'Invoice model not available'
      });
    }

    next();
  } catch (error) {
    console.error('Error initializing models:', error);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      success: false,
      message: 'Failed to initialize models',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  initializeTenantModels
};

