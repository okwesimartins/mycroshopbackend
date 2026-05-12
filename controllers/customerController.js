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

/**
 * GET /customers/purchase-history
 * Unified customer list from invoices, receipts, and online store orders.
 * Query params: source (invoice|receipt|online_store), page, limit, search
 */
async function getPurchaseCustomers(req, res) {
  try {
    const { source, page = 1, limit = 50, search } = req.query;
    const pageNum  = parseInt(page);
    const limitNum = parseInt(limit);
    const offset   = (pageNum - 1) * limitNum;

    const isFreePlan = req.tenant?.subscription_plan === 'free';
    const tenantId   = req.user?.tenantId;

    if (source && !['invoice', 'receipt', 'online_store'].includes(source)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid source. Use: invoice, receipt, or online_store'
      });
    }

    const parts       = [];
    const replacements = {};
    if (isFreePlan) replacements.tenantId = tenantId;
    if (search)     replacements.search   = `%${search}%`;

    // ── Invoice customers (from customers table) ────────────────────────────
    if (!source || source === 'invoice') {
      const where = [];
      if (isFreePlan) where.push('c.tenant_id = :tenantId');
      if (search)     where.push('(c.name LIKE :search OR c.email LIKE :search OR c.phone LIKE :search)');
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      parts.push(`
        SELECT
          c.id          AS customer_id,
          c.name,
          c.email,
          c.phone,
          c.address,
          c.city,
          c.state,
          c.country,
          c.created_at,
          'invoice'     AS source,
          COUNT(i.id)                   AS order_count,
          COALESCE(SUM(i.total), 0)     AS total_spent
        FROM customers c
        LEFT JOIN invoices i ON i.customer_id = c.id
        ${whereClause}
        GROUP BY c.id, c.name, c.email, c.phone, c.address, c.city, c.state, c.country, c.created_at
      `);
    }

    // ── Receipt customers ───────────────────────────────────────────────────
    if (!source || source === 'receipt') {
      const where = ['(customer_email IS NOT NULL OR customer_name IS NOT NULL)'];
      if (isFreePlan) where.push('tenant_id = :tenantId');
      if (search)     where.push('(customer_name LIKE :search OR customer_email LIKE :search OR customer_phone LIKE :search)');

      parts.push(`
        SELECT
          NULL                          AS customer_id,
          customer_name                 AS name,
          customer_email                AS email,
          customer_phone                AS phone,
          NULL                          AS address,
          NULL                          AS city,
          NULL                          AS state,
          NULL                          AS country,
          MIN(created_at)               AS created_at,
          'receipt'                     AS source,
          COUNT(*)                      AS order_count,
          COALESCE(SUM(total), 0)       AS total_spent
        FROM receipts
        WHERE ${where.join(' AND ')}
        GROUP BY customer_email, customer_name, customer_phone
      `);
    }

    // ── Online store customers ──────────────────────────────────────────────
    if (!source || source === 'online_store') {
      const where = ['(customer_email IS NOT NULL OR customer_name IS NOT NULL)'];
      if (isFreePlan) where.push('tenant_id = :tenantId');
      if (search)     where.push('(customer_name LIKE :search OR customer_email LIKE :search OR customer_phone LIKE :search)');

      parts.push(`
        SELECT
          NULL                          AS customer_id,
          customer_name                 AS name,
          customer_email                AS email,
          customer_phone                AS phone,
          customer_address              AS address,
          city,
          state,
          country,
          MIN(created_at)               AS created_at,
          'online_store'                AS source,
          COUNT(*)                      AS order_count,
          COALESCE(SUM(total), 0)       AS total_spent
        FROM online_store_orders
        WHERE ${where.join(' AND ')}
        GROUP BY customer_email, customer_name, customer_phone, customer_address, city, state, country
      `);
    }

    const unionSql = parts.join(' UNION ALL ');
    const countSql = `SELECT COUNT(*) AS total FROM (${unionSql}) AS combined`;
    const dataSql  = `SELECT * FROM (${unionSql}) AS combined ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;

    const countRows = await req.db.query(countSql, { replacements, type: 'SELECT' });
    const customers = await req.db.query(dataSql,  { replacements, type: 'SELECT' });

    const total = Number(countRows[0]?.total || 0);

    res.json({
      success: true,
      data: {
        customers,
        pagination: {
          total,
          page:       pageNum,
          limit:      limitNum,
          totalPages: Math.ceil(total / limitNum)
        }
      }
    });
  } catch (error) {
    console.error('Error getting purchase customers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get purchase customers',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
}

/**
 * GET /customers/purchase-history/orders?email=xxx  (or ?phone=xxx)
 * Returns all invoices, receipts, and online store orders for a given customer.
 */
async function getCustomerOrderHistory(req, res) {
  try {
    const { email, phone } = req.query;

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least email or phone to look up a customer'
      });
    }

    const isFreePlan = req.tenant?.subscription_plan === 'free';
    const tenantId   = req.user?.tenantId;

    const rp = {};
    if (email) rp.email = email;
    if (phone) rp.phone = phone;
    if (isFreePlan) rp.tenantId = tenantId;

    let customerInfo = null;
    let invoices     = [];
    let receipts     = [];
    let onlineOrders = [];

    // ── Invoices via customers table ────────────────────────────────────────
    {
      const idWhere   = email ? 'c.email = :email' : 'c.phone = :phone';
      const tenFilter = isFreePlan ? 'AND c.tenant_id = :tenantId' : '';

      const customerRows = await req.db.query(
        `SELECT c.id, c.name, c.email, c.phone, c.address, c.city, c.state, c.country
         FROM customers c
         WHERE ${idWhere} ${tenFilter}
         LIMIT 1`,
        { replacements: rp, type: 'SELECT' }
      );

      if (customerRows.length > 0) {
        customerInfo = customerRows[0];
        const invFilter = isFreePlan ? 'AND i.tenant_id = :tenantId' : '';

        invoices = await req.db.query(
          `SELECT i.id, i.invoice_number, i.issue_date, i.due_date,
                  i.subtotal, i.tax_amount, i.discount_amount, i.total,
                  i.status, i.payment_method, i.payment_date, i.notes, i.created_at
           FROM invoices i
           WHERE i.customer_id = :customerId ${invFilter}
           ORDER BY i.created_at DESC`,
          { replacements: { ...rp, customerId: customerInfo.id }, type: 'SELECT' }
        );
      }
    }

    // ── Receipts ────────────────────────────────────────────────────────────
    {
      const idWhere   = email ? 'customer_email = :email' : 'customer_phone = :phone';
      const tenFilter = isFreePlan ? 'AND tenant_id = :tenantId' : '';

      receipts = await req.db.query(
        `SELECT id, receipt_number, customer_name, customer_email, customer_phone,
                subtotal, tax_amount, discount_amount, total,
                payment_method, notes, created_at
         FROM receipts
         WHERE ${idWhere} ${tenFilter}
         ORDER BY created_at DESC`,
        { replacements: rp, type: 'SELECT' }
      );

      if (!customerInfo && receipts.length > 0) {
        customerInfo = {
          name:  receipts[0].customer_name,
          email: receipts[0].customer_email,
          phone: receipts[0].customer_phone
        };
      }
    }

    // ── Online store orders ─────────────────────────────────────────────────
    {
      const idWhere   = email ? 'customer_email = :email' : 'customer_phone = :phone';
      const tenFilter = isFreePlan ? 'AND tenant_id = :tenantId' : '';

      onlineOrders = await req.db.query(
        `SELECT id, order_number, customer_name, customer_email, customer_phone,
                customer_address, city, state, country,
                subtotal, tax_amount, shipping_amount, discount_amount, total,
                status, payment_status, payment_method, notes, created_at
         FROM online_store_orders
         WHERE ${idWhere} ${tenFilter}
         ORDER BY created_at DESC`,
        { replacements: rp, type: 'SELECT' }
      );

      if (!customerInfo && onlineOrders.length > 0) {
        customerInfo = {
          name:    onlineOrders[0].customer_name,
          email:   onlineOrders[0].customer_email,
          phone:   onlineOrders[0].customer_phone,
          address: onlineOrders[0].customer_address,
          city:    onlineOrders[0].city,
          state:   onlineOrders[0].state,
          country: onlineOrders[0].country
        };
      }
    }

    if (!customerInfo) {
      return res.status(404).json({
        success: false,
        message: 'No customer found with the provided details'
      });
    }

    res.json({
      success: true,
      data: {
        customer: customerInfo,
        summary: {
          total_invoices:      invoices.length,
          total_receipts:      receipts.length,
          total_online_orders: onlineOrders.length,
          total_orders:        invoices.length + receipts.length + onlineOrders.length
        },
        invoices,
        receipts,
        online_orders: onlineOrders
      }
    });
  } catch (error) {
    console.error('Error getting customer order history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get customer order history',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
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
  getCustomerInvoices,
  getPurchaseCustomers,
  getCustomerOrderHistory
};

