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
      let models;
      try {
        models = initializeModels(req.db);
      } catch (initError) {
        console.error('Error calling initializeModels:', initError);
        console.error('Error stack:', initError.stack);
        return res.status(500).json({
          success: false,
          message: 'Failed to initialize database models',
          error: process.env.NODE_ENV === 'development' ? initError.message : undefined
        });
      }

      if (!models) {
        console.error('initializeModels returned null/undefined');
        return res.status(500).json({
          success: false,
          message: 'Models initialization returned no models'
        });
      }

      if (!models.Invoice) {
        console.error('Invoice model not found in returned models');
        console.error('Available models:', Object.keys(models));
        return res.status(500).json({
          success: false,
          message: 'Invoice model not found in initialized models',
          available_models: process.env.NODE_ENV === 'development' ? Object.keys(models) : undefined
        });
      }

      req.db.models = models;
    }

    // Verify Invoice model exists
    if (!req.db.models || !req.db.models.Invoice) {
      console.error('Invoice model not found after initialization');
      console.error('req.db.models exists:', !!req.db.models);
      console.error('Available models:', req.db.models ? Object.keys(req.db.models) : 'none');
      return res.status(500).json({
        success: false,
        message: 'Invoice model not available',
        debug: process.env.NODE_ENV === 'development' ? {
          models_exist: !!req.db.models,
          available_models: req.db.models ? Object.keys(req.db.models) : 'none'
        } : undefined
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

