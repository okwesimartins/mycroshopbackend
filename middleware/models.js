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

    // Initialize models if not already done or if models object is empty
    if (!req.db.models || (typeof req.db.models === 'object' && Object.keys(req.db.models).length === 0)) {
      if (req.db.models && Object.keys(req.db.models).length === 0) {
        console.warn('WARNING: req.db.models exists but is empty. Re-initializing...');
        req.db.models = null; // Clear the empty object
      }
      let models;
      try {
        console.log('=== MODEL INITIALIZATION START ===');
        console.log('req.db type:', typeof req.db);
        console.log('req.db constructor:', req.db?.constructor?.name);
        console.log('req.db has define:', typeof req.db?.define === 'function');
        console.log('req.db dialect:', req.db?.getDialect?.());
        
        if (!req.db || typeof req.db.define !== 'function') {
          throw new Error('req.db is not a valid Sequelize instance. Expected object with define method.');
        }
        
        models = initializeModels(req.db);
        
        console.log('Models returned, type:', typeof models);
        console.log('Models is null/undefined:', models === null || models === undefined);
        console.log('Models is object:', typeof models === 'object');
        console.log('Models keys count:', models ? Object.keys(models).length : 0);
        
        if (!models) {
          throw new Error('initializeModels returned null or undefined');
        }
        
        if (typeof models !== 'object') {
          throw new Error(`initializeModels returned invalid type: ${typeof models}. Expected object.`);
        }
        
        const modelKeys = Object.keys(models);
        console.log('Model keys count:', modelKeys.length);
        
        if (modelKeys.length === 0) {
          const debugInfo = {
            models_type: typeof models,
            models_is_null: models === null,
            models_is_undefined: models === undefined,
            models_keys_count: Object.keys(models || {}).length,
            models_stringified: JSON.stringify(models || {}).substring(0, 500),
            req_db_type: typeof req.db,
            req_db_constructor: req.db?.constructor?.name,
            req_db_has_define: typeof req.db?.define === 'function',
            req_db_dialect: req.db?.getDialect?.()
          };
          
          console.error('CRITICAL: Models object is empty!');
          console.error('Debug info:', JSON.stringify(debugInfo, null, 2));
          
          return res.status(500).json({
            success: false,
            message: 'Models object is empty - no models were initialized',
            error_details: 'initializeModels returned an empty object',
            debug: debugInfo
          });
        }
        
        // Verify Invoice exists and store debug info
        if (!models.Invoice) {
          const debugInfo = {
            total_models: modelKeys.length,
            available_models: modelKeys,
            first_10_models: modelKeys.slice(0, 10),
            has_invoice_key: 'Invoice' in models,
            invoice_value: models.Invoice,
            invoice_type: typeof models.Invoice,
            models_stringified: JSON.stringify(Object.keys(models)).substring(0, 500)
          };
          
          console.error('Invoice model not found in returned models');
          console.error('Debug info:', JSON.stringify(debugInfo, null, 2));
          
          return res.status(500).json({
            success: false,
            message: 'Invoice model not found in initialized models',
            debug: debugInfo,
            available_models: modelKeys,
            total_models: modelKeys.length
          });
        }
      } catch (initError) {
        const debugInfo = {
          error_message: initError.message,
          error_name: initError.name,
          error_stack: initError.stack,
          req_db_type: typeof req.db,
          req_db_constructor: req.db?.constructor?.name,
          req_db_has_define: typeof req.db?.define === 'function',
          req_db_dialect: req.db?.getDialect?.()
        };
        
        console.error('=== ERROR CALLING initializeModels ===');
        console.error('Debug info:', JSON.stringify(debugInfo, null, 2));
        
        return res.status(500).json({
          success: false,
          message: 'Failed to initialize database models',
          error: initError.message,
          error_type: initError.name,
          debug: debugInfo
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
        const debugInfo = {
          models_type: typeof models,
          models_is_null: models === null,
          models_is_undefined: models === undefined,
          models_keys: Object.keys(models || {}),
          models_stringified: JSON.stringify(models).substring(0, 500),
          req_db_type: typeof req.db,
          req_db_has_define: typeof req.db?.define === 'function'
        };
        
        console.error('initializeModels returned empty object');
        console.error('Debug info:', JSON.stringify(debugInfo, null, 2));
        
        return res.status(500).json({
          success: false,
          message: 'Models initialization returned empty object',
          error_details: 'No models were defined or returned',
          debug: debugInfo
        });
      }

      if (!models.Invoice) {
        const debugInfo = {
          total_models_created: modelKeys.length,
          available_models: modelKeys,
          invoice_exists: 'Invoice' in models,
          invoice_value: models.Invoice,
          first_10_models: modelKeys.slice(0, 10),
          models_object_type: typeof models,
          models_object_keys: Object.keys(models)
        };
        
        console.error('Invoice model not found in returned models');
        console.error('Debug info:', JSON.stringify(debugInfo, null, 2));
        
        return res.status(500).json({
          success: false,
          message: 'Invoice model not found in initialized models',
          debug: debugInfo,
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
      const debugInfo = {
        req_db_models_exists: !!req.db.models,
        req_db_models_type: typeof req.db.models,
        req_db_models_is_null: req.db.models === null,
        req_db_models_is_undefined: req.db.models === undefined,
        available_models_count: availableKeys.length,
        available_models: availableKeys,
        invoice_key_exists: 'Invoice' in (req.db.models || {}),
        invoice_value: req.db.models?.Invoice,
        models_object_stringified: req.db.models ? JSON.stringify(req.db.models).substring(0, 500) : 'null/undefined',
        all_model_keys: availableKeys
      };
      
      console.error('Invoice model not found after assignment');
      console.error('Debug info:', JSON.stringify(debugInfo, null, 2));
      
      return res.status(500).json({
        success: false,
        message: 'Invoice model not available after initialization',
        error_details: 'Invoice model missing from req.db.models',
        debug: debugInfo
      });
    }

    next();
  } catch (error) {
    const debugInfo = {
      error_message: error.message,
      error_name: error.name,
      error_stack: error.stack,
      req_db_type: typeof req?.db,
      req_db_exists: !!req?.db,
      req_db_models_exists: !!req?.db?.models,
      req_db_models_type: typeof req?.db?.models
    };
    
    console.error('Error in initializeTenantModels middleware');
    console.error('Debug info:', JSON.stringify(debugInfo, null, 2));
    
    return res.status(500).json({
      success: false,
      message: 'Failed to initialize models',
      error: error.message,
      error_type: error.name,
      debug: debugInfo
    });
  }
}

module.exports = {
  initializeTenantModels
};

