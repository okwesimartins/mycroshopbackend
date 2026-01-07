const { Tenant, LicenseKey, validateAndUseLicenseKey } = require('../config/tenant');
const { createTenantDatabase, getTenantConnection, getSharedFreeDatabase } = require('../config/database');
const { initializeModels } = require('../models');
const mysql = require('mysql2/promise');

/**
 * Upgrade free user to enterprise (Platform admin only)
 */
async function upgradeToEnterprise(req, res) {
  try {
    const { tenant_id, license_key } = req.body;

    if (!tenant_id || !license_key) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id and license_key are required'
      });
    }

    // Get tenant
    const tenant = await Tenant.findByPk(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Check if already enterprise
    if (tenant.subscription_plan === 'enterprise') {
      return res.status(400).json({
        success: false,
        message: 'Tenant is already on enterprise plan'
      });
    }

    // Validate license key
    const licenseValidation = await validateAndUseLicenseKey(license_key, tenant.email || '');
    if (!licenseValidation.valid) {
      return res.status(400).json({
        success: false,
        message: licenseValidation.message
      });
    }

    // Generate new tenant ID for separate database
    const newTenantId = Date.now();
    const dbName = `${process.env.TENANT_DB_PREFIX || 'mycroshop_tenant_'}${newTenantId}`;

    // Create separate tenant database
    await createTenantDatabase(newTenantId.toString());

    // Migrate data from shared database to new database
    await migrateFreeUserData(tenant.id, newTenantId);

    // Update tenant record
    await tenant.update({
      subscription_plan: 'enterprise',
      transaction_fee_percentage: 0.00,
      db_name: dbName
    });

    // Link license to tenant
    await licenseValidation.license.update({ tenant_id: tenant.id });

    res.json({
      success: true,
      message: 'Tenant upgraded to enterprise successfully',
      data: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          subscription_plan: 'enterprise',
          db_name: dbName
        }
      }
    });
  } catch (error) {
    console.error('Error upgrading tenant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upgrade tenant',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Migrate data from shared free database to new enterprise database
 */
async function migrateFreeUserData(tenantId, newTenantId) {
  const sharedDb = await getSharedFreeDatabase();
  const newDb = await getTenantConnection(newTenantId.toString(), 'enterprise');

  // Get all data for this tenant from shared database
  const models = initializeModels(sharedDb);
  const newModels = initializeModels(newDb);

  // Migrate stores
  const stores = await models.Store.findAll({ where: { tenant_id: tenantId } });
  for (const store of stores) {
    await newModels.Store.create(store.toJSON());
  }

  // Migrate products
  const products = await models.Product.findAll({ where: { tenant_id: tenantId } });
  for (const product of products) {
    await newModels.Product.create(product.toJSON());
  }

  // Migrate customers
  const customers = await models.Customer.findAll({ where: { tenant_id: tenantId } });
  for (const customer of customers) {
    await newModels.Customer.create(customer.toJSON());
  }

  // Migrate invoices
  const invoices = await models.Invoice.findAll({ where: { tenant_id: tenantId } });
  for (const invoice of invoices) {
    await newModels.Invoice.create(invoice.toJSON());
  }

  // Migrate online store orders
  const orders = await models.OnlineStoreOrder.findAll({ where: { tenant_id: tenantId } });
  for (const order of orders) {
    await newModels.OnlineStoreOrder.create(order.toJSON());
  }

  // Add more migrations as needed...
  
  console.log(`Data migration completed for tenant ${tenantId}`);
}

module.exports = {
  upgradeToEnterprise
};

