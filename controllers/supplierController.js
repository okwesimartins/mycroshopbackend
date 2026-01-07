const { Sequelize } = require('sequelize');

/**
 * Get all suppliers
 */
async function getAllSuppliers(req, res) {
  try {
    const { page = 1, limit = 50, search, isActive } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (search) {
      where[Sequelize.Op.or] = [
        { name: { [Sequelize.Op.like]: `%${search}%` } },
        { company_name: { [Sequelize.Op.like]: `%${search}%` } },
        { email: { [Sequelize.Op.like]: `%${search}%` } },
        { phone: { [Sequelize.Op.like]: `%${search}%` } }
      ];
    }
    if (isActive !== undefined) {
      where.is_active = isActive === 'true';
    }

    const { count, rows } = await req.db.models.Supplier.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['name', 'ASC']]
    });

    res.json({
      success: true,
      data: {
        suppliers: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting suppliers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get suppliers'
    });
  }
}

/**
 * Get supplier by ID
 */
async function getSupplierById(req, res) {
  try {
    const supplier = await req.db.models.Supplier.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.PurchaseOrder,
          attributes: ['id', 'po_number', 'order_date', 'status', 'total'],
          limit: 10,
          order: [['created_at', 'DESC']]
        }
      ]
    });

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      data: { supplier }
    });
  } catch (error) {
    console.error('Error getting supplier:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get supplier'
    });
  }
}

/**
 * Create supplier
 */
async function createSupplier(req, res) {
  try {
    const {
      name,
      company_name,
      email,
      phone,
      address,
      city,
      state,
      country,
      contact_person,
      payment_terms,
      tax_id,
      notes
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    const supplier = await req.db.models.Supplier.create({
      name,
      company_name: company_name || null,
      email: email || null,
      phone: phone || null,
      address: address || null,
      city: city || null,
      state: state || null,
      country: country || null,
      contact_person: contact_person || null,
      payment_terms: payment_terms || null,
      tax_id: tax_id || null,
      notes: notes || null,
      is_active: true
    });

    res.status(201).json({
      success: true,
      message: 'Supplier created successfully',
      data: { supplier }
    });
  } catch (error) {
    console.error('Error creating supplier:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create supplier'
    });
  }
}

/**
 * Update supplier
 */
async function updateSupplier(req, res) {
  try {
    const supplier = await req.db.models.Supplier.findByPk(req.params.id);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    const {
      name,
      company_name,
      email,
      phone,
      address,
      city,
      state,
      country,
      contact_person,
      payment_terms,
      tax_id,
      notes,
      is_active
    } = req.body;

    await supplier.update({
      ...(name !== undefined && { name }),
      ...(company_name !== undefined && { company_name }),
      ...(email !== undefined && { email }),
      ...(phone !== undefined && { phone }),
      ...(address !== undefined && { address }),
      ...(city !== undefined && { city }),
      ...(state !== undefined && { state }),
      ...(country !== undefined && { country }),
      ...(contact_person !== undefined && { contact_person }),
      ...(payment_terms !== undefined && { payment_terms }),
      ...(tax_id !== undefined && { tax_id }),
      ...(notes !== undefined && { notes }),
      ...(is_active !== undefined && { is_active })
    });

    res.json({
      success: true,
      message: 'Supplier updated successfully',
      data: { supplier }
    });
  } catch (error) {
    console.error('Error updating supplier:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update supplier'
    });
  }
}

/**
 * Delete supplier
 */
async function deleteSupplier(req, res) {
  try {
    const supplier = await req.db.models.Supplier.findByPk(req.params.id);
    
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Check if supplier has purchase orders
    const poCount = await req.db.models.PurchaseOrder.count({
      where: { supplier_id: supplier.id }
    });

    if (poCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete supplier with ${poCount} purchase order(s). Please delete or transfer orders first.`
      });
    }

    await supplier.destroy();

    res.json({
      success: true,
      message: 'Supplier deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting supplier:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete supplier'
    });
  }
}

module.exports = {
  getAllSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier
};