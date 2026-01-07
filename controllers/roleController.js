const { Sequelize } = require('sequelize');

/**
 * Get all roles
 */
async function getAllRoles(req, res) {
  try {
    const roles = await req.db.models.Role.findAll({
      include: [
        {
          model: req.db.models.Permission,
          through: { attributes: [] },
          attributes: ['id', 'name', 'resource', 'action']
        }
      ],
      order: [['name', 'ASC']]
    });

    res.json({
      success: true,
      data: { roles }
    });
  } catch (error) {
    console.error('Error getting roles:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get roles'
    });
  }
}

/**
 * Create role
 */
async function createRole(req, res) {
  try {
    const { name, description, permission_ids } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    // Check if role already exists
    const existingRole = await req.db.models.Role.findOne({ where: { name } });
    if (existingRole) {
      return res.status(409).json({
        success: false,
        message: 'Role already exists'
      });
    }

    const role = await req.db.models.Role.create({
      name,
      description: description || null,
      is_system_role: false
    });

    // Assign permissions if provided
    if (permission_ids && Array.isArray(permission_ids) && permission_ids.length > 0) {
      for (const permissionId of permission_ids) {
        await req.db.models.RolePermission.create({
          role_id: role.id,
          permission_id: permissionId
        });
      }
    }

    const completeRole = await req.db.models.Role.findByPk(role.id, {
      include: [
        {
          model: req.db.models.Permission,
          through: { attributes: [] }
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Role created successfully',
      data: { role: completeRole }
    });
  } catch (error) {
    console.error('Error creating role:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create role'
    });
  }
}

/**
 * Update role permissions
 */
async function updateRolePermissions(req, res) {
  try {
    const { permission_ids } = req.body;
    const role = await req.db.models.Role.findByPk(req.params.id);

    if (!role) {
      return res.status(404).json({
        success: false,
        message: 'Role not found'
      });
    }

    // Delete existing permissions
    await req.db.models.RolePermission.destroy({
      where: { role_id: role.id }
    });

    // Add new permissions
    if (permission_ids && Array.isArray(permission_ids)) {
      for (const permissionId of permission_ids) {
        await req.db.models.RolePermission.create({
          role_id: role.id,
          permission_id: permissionId
        });
      }
    }

    const updatedRole = await req.db.models.Role.findByPk(role.id, {
      include: [
        {
          model: req.db.models.Permission,
          through: { attributes: [] }
        }
      ]
    });

    res.json({
      success: true,
      message: 'Role permissions updated successfully',
      data: { role: updatedRole }
    });
  } catch (error) {
    console.error('Error updating role permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update role permissions'
    });
  }
}

/**
 * Get all permissions
 */
async function getAllPermissions(req, res) {
  try {
    const permissions = await req.db.models.Permission.findAll({
      order: [['resource', 'ASC'], ['action', 'ASC']]
    });

    res.json({
      success: true,
      data: { permissions }
    });
  } catch (error) {
    console.error('Error getting permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get permissions'
    });
  }
}

module.exports = {
  getAllRoles,
  createRole,
  updateRolePermissions,
  getAllPermissions
};

