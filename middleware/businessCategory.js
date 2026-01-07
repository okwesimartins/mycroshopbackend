/**
 * Middleware to filter features based on business category
 * Different business categories get different features
 */

const { getTenantById } = require('../config/tenant');

/**
 * Universal features available to ALL business categories
 */
const universalFeatures = [
  'pos',
  'inventory',
  'invoicing',
  'crm',
  'online_store',
  'product_bundles',
  'staff_management',
  'role_management',
  'supplier_management',
  'purchase_orders',
  'multi_location',
  'bookings',
  'reports',
  'settings'
];

/**
 * Category-specific features (in addition to universal features)
 */
const categorySpecificFeatures = {
  supermarket: [
    'barcode_scanning',
    'expiry_tracking',
    'batch_tracking'
  ],
  restaurant: [
    'menu_management',
    'table_management',
    'order_management',
    'kitchen_display',
    'staff_scheduling'
  ],
  pharmacy: [
    'barcode_scanning',
    'expiry_tracking',
    'batch_tracking',
    'prescription_management'
  ],
  small_business: [
    // Small businesses get all universal features
    // Can add specific features here if needed
  ],
  other: [
    // Other businesses get all universal features
  ]
};

/**
 * Get all features for a business category
 */
function getFeaturesForCategory(category) {
  const universal = universalFeatures;
  const specific = categorySpecificFeatures[category] || [];
  return [...universal, ...specific];
}

/**
 * Check if feature is available for business category
 */
const categoryFeatures = {
  supermarket: getFeaturesForCategory('supermarket'),
  restaurant: getFeaturesForCategory('restaurant'),
  pharmacy: getFeaturesForCategory('pharmacy'),
  small_business: getFeaturesForCategory('small_business'),
  other: getFeaturesForCategory('other')
};

/**
 * Middleware to check if feature is available for tenant's business category
 */
async function checkFeatureAvailability(featureName) {
  return async (req, res, next) => {
    try {
      const tenantId = req.user.tenantId;
      const tenant = await getTenantById(tenantId);

      if (!tenant) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found'
        });
      }

      const businessCategory = tenant.business_category || 'small_business';
      const availableFeatures = getFeaturesForCategory(businessCategory);

      if (!availableFeatures.includes(featureName)) {
        return res.status(403).json({
          success: false,
          message: `Feature '${featureName}' is not available for ${businessCategory} businesses`,
          available_features: availableFeatures
        });
      }

      next();
    } catch (error) {
      console.error('Error checking feature availability:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to check feature availability'
      });
    }
  };
}

/**
 * Get available features for current tenant
 */
async function getAvailableFeatures(req, res) {
  try {
    const tenantId = req.user.tenantId;
    const tenant = await getTenantById(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    const businessCategory = tenant.business_category || 'small_business';
    const availableFeatures = getFeaturesForCategory(businessCategory);

    res.json({
      success: true,
      data: {
        business_category: businessCategory,
        available_features: availableFeatures
      }
    });
  } catch (error) {
    console.error('Error getting available features:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get available features'
    });
  }
}

module.exports = {
  checkFeatureAvailability,
  getAvailableFeatures,
  categoryFeatures,
  universalFeatures,
  categorySpecificFeatures,
  getFeaturesForCategory
};

