const { Sequelize } = require('sequelize');

/**
 * Get all customers
 */
async function getAllCustomers(req, res) {
  try {
    const { page = 1, limit = 50, search, tags } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (search) {
      where[Sequelize.Op.or] = [
        { name: { [Sequelize.Op.like]: `%${search}%` } },
        { email: { [Sequelize.Op.like]: `%${search}%` } },
        { phone: { [Sequelize.Op.like]: `%${search}%` } }
      ];
    }

    const { count, rows } = await req.db.models.Customer.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        customers: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting customers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get customers'
    });
  }
}

/**
 * Get customer by ID
 */
async function getCustomerById(req, res) {
  try {
    const customer = await req.db.models.Customer.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Invoice,
          limit: 10,
          order: [['created_at', 'DESC']]
        },
        {
          model: req.db.models.Booking,
          limit: 10,
          order: [['scheduled_at', 'DESC']]
        }
      ]
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    res.json({
      success: true,
      data: { customer }
    });
  } catch (error) {
    console.error('Error getting customer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get customer'
    });
  }
}

/**
 * Create customer
 */
async function createCustomer(req, res) {
  try {
    const {
      name,
      email,
      phone,
      address,
      city,
      state,
      zip_code,
      country,
      notes,
      tags
    } = req.body;

    // Get tenant to check subscription plan
    const tenantId = req.user?.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    const customer = await req.db.models.Customer.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      name,
      email: email || null,
      phone: phone || null,
      address: address || null,
      city: city || null,
      state: state || null,
      zip_code: zip_code || null,
      country: country || null,
      notes: notes || null,
      tags: tags || null
    });

    res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: { customer }
    });
  } catch (error) {
    console.error('Error creating customer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create customer'
    });
  }
}

/**
 * Update customer
 */
async function updateCustomer(req, res) {
  try {
    const customer = await req.db.models.Customer.findByPk(req.params.id);
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    const {
      name,
      email,
      phone,
      address,
      city,
      state,
      zip_code,
      country,
      notes,
      tags
    } = req.body;

    await customer.update({
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email }),
      ...(phone !== undefined && { phone }),
      ...(address !== undefined && { address }),
      ...(city !== undefined && { city }),
      ...(state !== undefined && { state }),
      ...(zip_code !== undefined && { zip_code }),
      ...(country !== undefined && { country }),
      ...(notes !== undefined && { notes }),
      ...(tags !== undefined && { tags })
    });

    res.json({
      success: true,
      message: 'Customer updated successfully',
      data: { customer }
    });
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update customer'
    });
  }
}

/**
 * Delete customer
 */
async function deleteCustomer(req, res) {
  try {
    const customer = await req.db.models.Customer.findByPk(req.params.id);
    
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    await customer.destroy();

    res.json({
      success: true,
      message: 'Customer deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete customer'
    });
  }
}

/**
 * Get customer interactions
 */
async function getCustomerInteractions(req, res) {
  try {
    const interactions = await req.db.models.CustomerInteraction.findAll({
      where: { customer_id: req.params.id },
      order: [['interaction_date', 'DESC']],
      limit: 100
    });

    res.json({
      success: true,
      data: { interactions }
    });
  } catch (error) {
    console.error('Error getting customer interactions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get customer interactions'
    });
  }
}

/**
 * Add customer interaction
 */
async function addCustomerInteraction(req, res) {
  try {
    const {
      interaction_type,
      subject,
      description,
      interaction_date
    } = req.body;

    const interaction = await req.db.models.CustomerInteraction.create({
      customer_id: req.params.id,
      interaction_type,
      subject: subject || null,
      description: description || null,
      interaction_date: interaction_date || new Date(),
      created_by: req.user.email
    });

    res.status(201).json({
      success: true,
      message: 'Interaction added successfully',
      data: { interaction }
    });
  } catch (error) {
    console.error('Error adding customer interaction:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add customer interaction'
    });
  }
}

/**
 * Get customer invoices
 */
async function getCustomerInvoices(req, res) {
  try {
    const invoices = await req.db.models.Invoice.findAll({
      where: { customer_id: req.params.id },
      include: [
        {
          model: req.db.models.InvoiceItem,
          include: [
            {
              model: req.db.models.Product
            }
          ]
        }
      ],
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: { invoices }
    });
  } catch (error) {
    console.error('Error getting customer invoices:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get customer invoices'
    });
  }
}

module.exports = {
  getAllCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerInteractions,
  addCustomerInteraction,
  getCustomerInvoices
};

