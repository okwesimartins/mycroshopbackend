const { getTaxInfo } = require('../services/taxCalculator');
const { getTenantById } = require('../config/tenant');

/**
 * Get tax information for the current tenant's country
 */
async function getTaxInformation(req, res) {
  try {
    const tenantId = req.user.tenantId;
    const tenant = await getTenantById(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    const country = tenant.country || 'Nigeria';
    const taxInfo = getTaxInfo(country);

    res.json({
      success: true,
      data: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          country: tenant.country,
          business_type: tenant.business_type,
          annual_turnover: tenant.annual_turnover,
          total_fixed_assets: tenant.total_fixed_assets
        },
        tax_info: taxInfo
      }
    });
  } catch (error) {
    console.error('Error getting tax information:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tax information'
    });
  }
}

/**
 * Calculate tax preview (for testing/display purposes)
 */
async function calculateTaxPreview(req, res) {
  try {
    const { subtotal } = req.query;
    const tenantId = req.user.tenantId;
    const tenant = await getTenantById(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    if (!subtotal || isNaN(parseFloat(subtotal))) {
      return res.status(400).json({
        success: false,
        message: 'subtotal is required and must be a number'
      });
    }

    const { calculateTax } = require('../services/taxCalculator');
    const taxBreakdown = calculateTax({
      country: tenant.country || 'Nigeria',
      subtotal: parseFloat(subtotal),
      businessType: tenant.business_type || 'company',
      annualTurnover: tenant.annual_turnover ? parseFloat(tenant.annual_turnover) : null,
      totalFixedAssets: tenant.total_fixed_assets ? parseFloat(tenant.total_fixed_assets) : null
    });

    res.json({
      success: true,
      data: {
        subtotal: parseFloat(subtotal),
        tax_breakdown: taxBreakdown,
        total: parseFloat(subtotal) + taxBreakdown.total_tax
      }
    });
  } catch (error) {
    console.error('Error calculating tax preview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate tax preview'
    });
  }
}

module.exports = {
  getTaxInformation,
  calculateTaxPreview
};

