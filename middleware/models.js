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
        message: 'Database connection not available',
        error_details: 'req.db is undefined'
      });
    }

    // Initialize models if not already done
    if (!req.db.models) {
      let models;
      try {
        console.log('Initializing models...');
        console.log('req.db type:', typeof req.db);
        console.log('req.db constructor:', req.db.constructor?.name);
        
        models = initializeModels(req.db);
        
        console.log('Models initialized, type:', typeof models);
        console.log('Models is null/undefined:', models === null || models === undefined);
        console.log('Models keys count:', models ? Object.keys(models).length : 0);
        
        if (models && Object.keys(models).length > 0) {
          console.log('First 5 model keys:', Object.keys(models).slice(0, 5));
        }
      } catch (initError) {
        console.error('Error calling initializeModels:', initError);
        console.error('Error message:', initError.message);
        console.error('Error stack:', initError.stack);
        console.error('Error name:', initError.name);
        return res.status(500).json({
          success: false,
          message: 'Failed to initialize database models',
          error: initError.message,
          error_type: initError.name,
          error_stack: process.env.NODE_ENV === 'development' ? initError.stack : undefined
        });
      }

      if (!models) {
        console.error('initializeModels returned null/undefined');
        return res.status(500).json({
          success: false,
          message: 'Models initialization returned null or undefined',
          error_details: 'initializeModels function returned falsy value'
        });
      }

      if (typeof models !== 'object') {
        console.error('initializeModels returned non-object:', typeof models);
        return res.status(500).json({
          success: false,
          message: 'Models initialization returned invalid type',
          error_details: `Expected object, got ${typeof models}`
        });
      }

      const modelKeys = Object.keys(models);
      if (modelKeys.length === 0) {
        console.error('initializeModels returned empty object');
        console.error('Models object:', models);
        return res.status(500).json({
          success: false,
          message: 'Models initialization returned empty object',
          error_details: 'No models were defined or returned',
          models_type: typeof models,
          models_value: JSON.stringify(models).substring(0, 200)
        });
      }

      if (!models.Invoice) {
        console.error('Invoice model not found in returned models');
        console.error('Total models count:', modelKeys.length);
        console.error('Available models:', modelKeys);
        return res.status(500).json({
          success: false,
          message: 'Invoice model not found in initialized models',
          available_models: modelKeys,
          total_models: modelKeys.length
        });
      }

      console.log('Models initialized successfully. Invoice model found.');
      req.db.models = models;
    }

    // Verify Invoice model exists after assignment
    if (!req.db.models) {
      return res.status(500).json({
        success: false,
        message: 'Models object is missing after initialization',
        error_details: 'req.db.models is null/undefined'
      });
    }

    if (!req.db.models.Invoice) {
      const availableKeys = Object.keys(req.db.models || {});
      console.error('Invoice model not found after assignment');
      console.error('req.db.models exists:', !!req.db.models);
      console.error('req.db.models type:', typeof req.db.models);
      console.error('Available models count:', availableKeys.length);
      console.error('Available models:', availableKeys);
      
      return res.status(500).json({
        success: false,
        message: 'Invoice model not available after initialization',
        error_details: 'Invoice model missing from req.db.models',
        models_exist: !!req.db.models,
        models_type: typeof req.db.models,
        available_models: availableKeys,
        total_available: availableKeys.length,
        models_keys_sample: availableKeys.slice(0, 10)
      });
    }

    next();
  } catch (error) {
    console.error('Error in initializeTenantModels middleware:', error);
    console.error('Error message:', error.message);
    console.error('Error name:', error.name);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      message: 'Failed to initialize models',
      error: error.message,
      error_type: error.name,
      error_stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

module.exports = {
  initializeTenantModels
};

