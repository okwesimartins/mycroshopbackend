const { getTenantById } = require('../config/tenant');

/**
 * Middleware to check if user's subscription plan allows access to a feature
 * Usage: router.post('/stores', checkSubscriptionPlan('enterprise'), controller.createStore)
 */
function checkSubscriptionPlan(requiredPlan = 'enterprise') {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.tenantId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      // Get tenant to check subscription plan
      const tenant = await getTenantById(req.user.tenantId);
      
      if (!tenant) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found'
        });
      }

      // Check subscription plan
      if (tenant.subscription_plan !== requiredPlan) {
        return res.status(403).json({
          success: false,
          message: `This feature is only available for ${requiredPlan} users. Please upgrade your plan.`,
          upgrade_required: true,
          current_plan: tenant.subscription_plan,
          required_plan: requiredPlan
        });
      }

      // Attach tenant info to request
      req.tenant = tenant;
      next();
    } catch (error) {
      console.error('Error checking subscription plan:', error);
      res.status(500).json({
        success: false,
        message: 'Error checking subscription plan'
      });
    }
  };
}

/**
 * Middleware to restrict physical store creation for free users
 */
async function restrictPhysicalStores(req, res, next) {
  try {
    if (!req.user || !req.user.tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Get tenant to check subscription plan
    const tenant = await getTenantById(req.user.tenantId);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Free users cannot create physical stores
    if (tenant.subscription_plan === 'free') {
      return res.status(403).json({
        success: false,
        message: 'Physical stores are only available for enterprise users. Free users can only create online stores. Please upgrade to enterprise to access this feature.',
        upgrade_required: true,
        current_plan: 'free',
        required_plan: 'enterprise'
      });
    }

    next();
  } catch (error) {
    console.error('Error checking subscription plan:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking subscription plan'
    });
  }
}

module.exports = {
  checkSubscriptionPlan,
  restrictPhysicalStores
};

