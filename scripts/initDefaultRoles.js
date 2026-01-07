/**
 * Initialize default roles and permissions for new tenant
 * Run this after tenant database is created
 */

const { getTenantConnection } = require('../config/database');
const initializeModels = require('../models');

async function initDefaultRoles(tenantId) {
  try {
    const sequelize = await getTenantConnection(tenantId);
    const models = initializeModels(sequelize);

    // Create default permissions
    const permissions = [
      // Inventory
      { name: 'inventory.view', resource: 'inventory', action: 'view', description: 'View products' },
      { name: 'inventory.create', resource: 'inventory', action: 'create', description: 'Create products' },
      { name: 'inventory.update', resource: 'inventory', action: 'update', description: 'Update products' },
      { name: 'inventory.delete', resource: 'inventory', action: 'delete', description: 'Delete products' },
      
      // POS
      { name: 'pos.view', resource: 'pos', action: 'view', description: 'View POS transactions' },
      { name: 'pos.create', resource: 'pos', action: 'create', description: 'Create POS transactions' },
      { name: 'pos.refund', resource: 'pos', action: 'refund', description: 'Refund transactions' },
      
      // Invoices
      { name: 'invoices.view', resource: 'invoices', action: 'view', description: 'View invoices' },
      { name: 'invoices.create', resource: 'invoices', action: 'create', description: 'Create invoices' },
      { name: 'invoices.update', resource: 'invoices', action: 'update', description: 'Update invoices' },
      { name: 'invoices.delete', resource: 'invoices', action: 'delete', description: 'Delete invoices' },
      
      // Customers
      { name: 'customers.view', resource: 'customers', action: 'view', description: 'View customers' },
      { name: 'customers.create', resource: 'customers', action: 'create', description: 'Create customers' },
      { name: 'customers.update', resource: 'customers', action: 'update', description: 'Update customers' },
      { name: 'customers.delete', resource: 'customers', action: 'delete', description: 'Delete customers' },
      
      // Staff
      { name: 'staff.view', resource: 'staff', action: 'view', description: 'View staff' },
      { name: 'staff.create', resource: 'staff', action: 'create', description: 'Create staff' },
      { name: 'staff.update', resource: 'staff', action: 'update', description: 'Update staff' },
      { name: 'staff.delete', resource: 'staff', action: 'delete', description: 'Delete staff' },
      
      // Suppliers
      { name: 'suppliers.view', resource: 'suppliers', action: 'view', description: 'View suppliers' },
      { name: 'suppliers.create', resource: 'suppliers', action: 'create', description: 'Create suppliers' },
      { name: 'suppliers.update', resource: 'suppliers', action: 'update', description: 'Update suppliers' },
      { name: 'suppliers.delete', resource: 'suppliers', action: 'delete', description: 'Delete suppliers' },
      
      // Purchase Orders
      { name: 'purchase_orders.view', resource: 'purchase_orders', action: 'view', description: 'View purchase orders' },
      { name: 'purchase_orders.create', resource: 'purchase_orders', action: 'create', description: 'Create purchase orders' },
      { name: 'purchase_orders.update', resource: 'purchase_orders', action: 'update', description: 'Update purchase orders' },
      { name: 'purchase_orders.receive', resource: 'purchase_orders', action: 'receive', description: 'Receive purchase orders' },
      
      // Reports
      { name: 'reports.view', resource: 'reports', action: 'view', description: 'View reports' },
      
      // Settings
      { name: 'settings.view', resource: 'settings', action: 'view', description: 'View settings' },
      { name: 'settings.update', resource: 'settings', action: 'update', description: 'Update settings' }
    ];

    // Create permissions
    const createdPermissions = [];
    for (const perm of permissions) {
      const [permission, created] = await models.Permission.findOrCreate({
        where: { name: perm.name },
        defaults: perm
      });
      createdPermissions.push(permission);
    }

    // Create default roles
    const roles = [
      {
        name: 'Admin',
        description: 'Full access to all features',
        is_system_role: true,
        permissions: createdPermissions.map(p => p.id) // All permissions
      },
      {
        name: 'Manager',
        description: 'Management access with most features',
        is_system_role: true,
        permissions: createdPermissions
          .filter(p => !p.name.includes('.delete') && p.name !== 'settings.update')
          .map(p => p.id)
      },
      {
        name: 'Cashier',
        description: 'POS and basic operations',
        is_system_role: true,
        permissions: createdPermissions
          .filter(p => 
            p.name.includes('pos.') || 
            p.name.includes('customers.view') ||
            p.name.includes('customers.create') ||
            p.name.includes('inventory.view')
          )
          .map(p => p.id)
      },
      {
        name: 'Staff',
        description: 'Basic staff access',
        is_system_role: true,
        permissions: createdPermissions
          .filter(p => 
            p.name.includes('.view') && 
            !p.name.includes('staff.') &&
            !p.name.includes('settings.')
          )
          .map(p => p.id)
      }
    ];

    // Create roles with permissions
    for (const roleData of roles) {
      const { permissions, ...roleInfo } = roleData;
      const [role, created] = await models.Role.findOrCreate({
        where: { name: roleInfo.name },
        defaults: roleInfo
      });

      if (created && permissions) {
        for (const permissionId of permissions) {
          await models.RolePermission.findOrCreate({
            where: {
              role_id: role.id,
              permission_id: permissionId
            },
            defaults: {
              role_id: role.id,
              permission_id: permissionId
            }
          });
        }
      }
    }

    console.log(`Default roles and permissions initialized for tenant ${tenantId}`);
    return true;
  } catch (error) {
    console.error(`Error initializing default roles for tenant ${tenantId}:`, error);
    throw error;
  }
}

module.exports = { initDefaultRoles };

