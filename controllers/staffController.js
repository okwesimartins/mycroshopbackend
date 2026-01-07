const { Sequelize } = require('sequelize');
const bcrypt = require('bcryptjs');

/**
 * Get all staff
 */
async function getAllStaff(req, res) {
  try {
    const { page = 1, limit = 50, store_id, role_id, status, search } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (store_id) where.store_id = store_id;
    if (role_id) where.role_id = role_id;
    if (status) where.status = status;
    if (search) {
      where[Sequelize.Op.or] = [
        { name: { [Sequelize.Op.like]: `%${search}%` } },
        { email: { [Sequelize.Op.like]: `%${search}%` } },
        { employee_id: { [Sequelize.Op.like]: `%${search}%` } }
      ];
    }

    const { count, rows } = await req.db.models.Staff.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.Role,
          attributes: ['id', 'name', 'description']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        staff: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get staff'
    });
  }
}

/**
 * Get staff by ID
 */
async function getStaffById(req, res) {
  try {
    const staff = await req.db.models.Staff.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Role,
          include: [
            {
              model: req.db.models.Permission,
              through: { attributes: [] }
            }
          ]
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ]
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    res.json({
      success: true,
      data: { staff }
    });
  } catch (error) {
    console.error('Error getting staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get staff'
    });
  }
}

/**
 * Create staff member
 */
async function createStaff(req, res) {
  try {
    const {
      name,
      email,
      phone,
      role_id,
      store_id,
      employee_id,
      hire_date,
      salary,
      password
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    // Verify role exists if provided
    if (role_id) {
      const role = await req.db.models.Role.findByPk(role_id);
      if (!role) {
        return res.status(404).json({
          success: false,
          message: 'Role not found'
        });
      }
    }

    // Check if email already exists
    if (email) {
      const existingStaff = await req.db.models.Staff.findOne({ where: { email } });
      if (existingStaff) {
        return res.status(409).json({
          success: false,
          message: 'Email already registered'
        });
      }
    }

    const staff = await req.db.models.Staff.create({
      name,
      email: email || null,
      phone: phone || null,
      role_id: role_id || null, // Role is optional
      store_id: store_id || null,
      employee_id: employee_id || null,
      hire_date: hire_date || null,
      salary: salary ? parseFloat(salary) : null,
      status: 'active'
    });

    // If password provided, create user account (link to main User table if needed)
    // For now, we'll just create the staff record

    const completeStaff = await req.db.models.Staff.findByPk(staff.id, {
      include: [
        {
          model: req.db.models.Role,
          required: false // Left join - role is optional
        },
        {
          model: req.db.models.Store,
          required: false
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Staff created successfully',
      data: { staff: completeStaff }
    });
  } catch (error) {
    console.error('Error creating staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create staff'
    });
  }
}

/**
 * Update staff member
 */
async function updateStaff(req, res) {
  try {
    const staff = await req.db.models.Staff.findByPk(req.params.id);
    
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    const {
      name,
      email,
      phone,
      role_id,
      store_id,
      employee_id,
      hire_date,
      salary,
      status
    } = req.body;

    await staff.update({
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email }),
      ...(phone !== undefined && { phone }),
      ...(role_id !== undefined && { role_id }),
      ...(store_id !== undefined && { store_id }),
      ...(employee_id !== undefined && { employee_id }),
      ...(hire_date !== undefined && { hire_date }),
      ...(salary !== undefined && { salary: salary ? parseFloat(salary) : null }),
      ...(status !== undefined && { status })
    });

    const updatedStaff = await req.db.models.Staff.findByPk(staff.id, {
      include: [
        {
          model: req.db.models.Role
        },
        {
          model: req.db.models.Store
        }
      ]
    });

    res.json({
      success: true,
      message: 'Staff updated successfully',
      data: { staff: updatedStaff }
    });
  } catch (error) {
    console.error('Error updating staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update staff'
    });
  }
}

/**
 * Delete staff member
 */
async function deleteStaff(req, res) {
  try {
    const staff = await req.db.models.Staff.findByPk(req.params.id);
    
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff not found'
      });
    }

    await staff.destroy();

    res.json({
      success: true,
      message: 'Staff deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete staff'
    });
  }
}

module.exports = {
  getAllStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff
};

