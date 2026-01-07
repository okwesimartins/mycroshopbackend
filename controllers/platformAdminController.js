const { Tenant, User, LicenseKey } = require('../config/tenant');
const { Sequelize } = require('sequelize');
const { getTenantConnection } = require('../config/database');

/**
 * Get all tenants (clients)
 */
async function getAllTenants(req, res) {
  try {
    const { page = 1, limit = 50, status, business_category, search } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (status) where.status = status;
    if (business_category) where.business_category = business_category;
    if (search) {
      where[Sequelize.Op.or] = [
        { name: { [Sequelize.Op.like]: `%${search}%` } },
        { subdomain: { [Sequelize.Op.like]: `%${search}%` } },
        { email: { [Sequelize.Op.like]: `%${search}%` } }
      ];
    }

    const { count, rows } = await Tenant.findAndCountAll({
      where,
      include: [
        {
          model: LicenseKey,
          attributes: ['id', 'license_key', 'status', 'purchased_by', 'purchased_email']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        tenants: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting tenants:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tenants'
    });
  }
}

/**
 * Get tenant by ID with detailed stats
 */
async function getTenantById(req, res) {
  try {
    const tenant = await Tenant.findByPk(req.params.id, {
      include: [
        {
          model: LicenseKey,
          attributes: ['id', 'license_key', 'status', 'purchased_by', 'purchased_email', 'used_at']
        }
      ]
    });

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Get tenant database stats
    let stats = null;
    try {
      const sequelize = await getTenantConnection(tenant.id.toString());
      const models = require('../models')(sequelize);

      const [productCount, customerCount, invoiceCount, posCount] = await Promise.all([
        models.Product.count(),
        models.Customer.count(),
        models.Invoice.count(),
        models.POSTransaction.count()
      ]);

      stats = {
        products: productCount,
        customers: customerCount,
        invoices: invoiceCount,
        pos_transactions: posCount
      };
    } catch (error) {
      console.warn('Could not fetch tenant stats:', error);
    }

    res.json({
      success: true,
      data: {
        tenant,
        stats
      }
    });
  } catch (error) {
    console.error('Error getting tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tenant'
    });
  }
}

/**
 * Suspend tenant
 */
async function suspendTenant(req, res) {
  try {
    const tenant = await Tenant.findByPk(req.params.id);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    await tenant.update({ status: 'suspended' });

    res.json({
      success: true,
      message: 'Tenant suspended successfully',
      data: { tenant }
    });
  } catch (error) {
    console.error('Error suspending tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to suspend tenant'
    });
  }
}

/**
 * Activate tenant
 */
async function activateTenant(req, res) {
  try {
    const tenant = await Tenant.findByPk(req.params.id);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    await tenant.update({ status: 'active' });

    res.json({
      success: true,
      message: 'Tenant activated successfully',
      data: { tenant }
    });
  } catch (error) {
    console.error('Error activating tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to activate tenant'
    });
  }
}

/**
 * Get platform statistics
 */
async function getPlatformStats(req, res) {
  try {
    const [totalTenants, activeTenants, suspendedTenants, totalLicenses, usedLicenses] = await Promise.all([
      Tenant.count(),
      Tenant.count({ where: { status: 'active' } }),
      Tenant.count({ where: { status: 'suspended' } }),
      LicenseKey.count(),
      LicenseKey.count({ where: { status: 'used' } })
    ]);

    // Get recent registrations (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentRegistrations = await Tenant.count({
      where: {
        created_at: {
          [Sequelize.Op.gte]: thirtyDaysAgo
        }
      }
    });

    res.json({
      success: true,
      data: {
        tenants: {
          total: totalTenants,
          active: activeTenants,
          suspended: suspendedTenants,
          recent_registrations: recentRegistrations
        },
        licenses: {
          total: totalLicenses,
          used: usedLicenses,
          available: totalLicenses - usedLicenses
        }
      }
    });
  } catch (error) {
    console.error('Error getting platform stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get platform statistics'
    });
  }
}

module.exports = {
  getAllTenants,
  getTenantById,
  suspendTenant,
  activateTenant,
  getPlatformStats
};

