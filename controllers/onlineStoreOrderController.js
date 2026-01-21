const { Sequelize } = require('sequelize');
const { v4: uuidv4 } = require('uuid');

/**
 * Generate unique order number
 */
function generateOrderNumber() {
  const prefix = 'ORD';
  const timestamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Get all online store orders
 */
async function getAllOrders(req, res) {
  try {
    const { page = 1, limit = 50, status, payment_status, store_id, online_store_id, start_date, end_date } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    
    if (online_store_id) {
      where.online_store_id = online_store_id;
    }
    if (store_id) {
      where.store_id = store_id;
    }
    if (status) {
      where.status = status;
    }
    if (payment_status) {
      where.payment_status = payment_status;
    }

    // Build includes
    const include = [
      {
        model: req.db.models.OnlineStore,
        attributes: ['id', 'username', 'store_name']
      },
      {
        model: req.db.models.Store,
        attributes: ['id', 'name', 'store_type', 'address', 'city', 'state']
      },
      {
        model: req.db.models.OnlineStoreOrderItem,
        include: [
          {
            model: req.db.models.Product,
            attributes: ['id', 'name', 'sku']
          }
        ]
      }
    ];

    // If start_date/end_date provided, filter by payment date (paid_at) from PaymentTransaction instead
    // Interpret start_date/end_date as calendar days, not exact timestamps
    if (start_date || end_date) {
      const paymentDateWhere = {};

      if (start_date) {
        // Start of day (00:00:00)
        paymentDateWhere[Sequelize.Op.gte] = new Date(`${start_date}T00:00:00.000Z`);
      }
      if (end_date) {
        // End of day (23:59:59.999)
        paymentDateWhere[Sequelize.Op.lte] = new Date(`${end_date}T23:59:59.999Z`);
      }

      include.push({
        model: req.db.models.PaymentTransaction,
        attributes: ['id', 'status', 'paid_at'],
        required: true, // only orders with matching payment in this range
        where: {
          status: 'success',
          paid_at: paymentDateWhere
        }
      });
    } else {
      // Optional include of payment info without filtering
      include.push({
        model: req.db.models.PaymentTransaction,
        attributes: ['id', 'status', 'paid_at'],
        required: false
      });
    }

    const { count, rows } = await req.db.models.OnlineStoreOrder.findAndCountAll({
      where,
      include,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        orders: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting orders:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to get orders',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      errorDetails: process.env.NODE_ENV === 'development' ? {
        stack: error.stack,
        name: error.name
      } : undefined
    });
  }
}

/**
 * Get order by ID
 */
async function getOrderById(req, res) {
  try {
    const order = await req.db.models.OnlineStoreOrder.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.OnlineStore,
          attributes: ['id', 'username', 'store_name']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state', 'phone', 'email']
        },
        {
          model: req.db.models.OnlineStoreOrderItem,
          include: [
            {
              model: req.db.models.Product
            }
          ]
        }
      ]
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    res.json({
      success: true,
      data: { order }
    });
  } catch (error) {
    console.error('Error getting order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get order'
    });
  }
}

/**
 * Create order from online store (customer-facing)
 */
async function createOrder(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const {
      online_store_id,
      store_id, // Physical store to fulfill order
      customer_name,
      customer_email,
      customer_phone,
      customer_address,
      city,
      state,
      country,
      delivery_date,
      delivery_time,
      items, // Array of { product_id, quantity, unit_price }
      tax_rate = 0,
      shipping_amount = 0,
      discount_amount = 0,
      payment_method,
      notes
    } = req.body;

    if (!online_store_id || !items || !Array.isArray(items) || items.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'online_store_id and items are required'
      });
    }

    // Verify online store exists
    const onlineStore = await req.db.models.OnlineStore.findByPk(online_store_id);
    if (!onlineStore) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // If store_id provided, verify it's linked to online store
    let finalStoreId = store_id;
    if (store_id) {
      const storeLink = await req.db.models.OnlineStoreLocation.findOne({
        where: { online_store_id, store_id }
      });
      if (!storeLink) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Store is not linked to this online store'
        });
      }
      finalStoreId = store_id;
    } else {
      // Get default store for online store
      const defaultStore = await req.db.models.OnlineStoreLocation.findOne({
        where: { online_store_id, is_default: true },
        include: [{ model: req.db.models.Store }]
      });
      if (defaultStore) {
        finalStoreId = defaultStore.store_id;
      }
    }

    // Calculate totals
    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const { product_id, quantity, unit_price } = item;
      
      if (!product_id || !quantity || !unit_price) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Each item must have product_id, quantity, and unit_price'
        });
      }

      // Verify product exists and is available
      const product = await req.db.models.Product.findByPk(product_id);
      if (!product) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Product ${product_id} not found`
        });
      }

      // Check stock if store_id is provided
      if (finalStoreId) {
        // Check if product is in the store
        const productStore = await req.db.models.ProductStore.findOne({
          where: { product_id, store_id: finalStoreId }
        });
        
        if (productStore && productStore.stock < quantity) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for product ${product.name}. Available: ${productStore.stock}, Requested: ${quantity}`
          });
        }
      }

      const itemTotal = quantity * unit_price;
      subtotal += itemTotal;

      orderItems.push({
        product_id,
        product_name: product.name,
        quantity,
        unit_price,
        total: itemTotal
      });
    }

    const taxAmount = subtotal * (tax_rate / 100);
    const total = subtotal + taxAmount + shipping_amount - discount_amount;

    // Create order
    const order = await req.db.models.OnlineStoreOrder.create({
      online_store_id,
      store_id: finalStoreId,
      order_number: generateOrderNumber(),
      customer_name,
      customer_email: customer_email || null,
      customer_phone: customer_phone || null,
      customer_address: customer_address || null,
      city: city || null,
      state: state || null,
      country: country || null,
      delivery_date: delivery_date || null,
      delivery_time: delivery_time || null,
      subtotal,
      tax_amount: taxAmount,
      shipping_amount,
      discount_amount,
      total,
      status: 'pending',
      payment_status: 'pending',
      payment_method: payment_method || null,
      notes: notes || null
    }, { transaction });

    // Create order items
    for (const item of orderItems) {
      await req.db.models.OnlineStoreOrderItem.create({
        order_id: order.id,
        ...item
      }, { transaction });
    }

    // Update stock if store_id is provided
    if (finalStoreId) {
      for (const item of items) {
        const productStore = await req.db.models.ProductStore.findOne({
          where: { product_id: item.product_id, store_id: finalStoreId }
        });
        
        if (productStore) {
          await productStore.update({
            stock: productStore.stock - item.quantity
          }, { transaction });
        }
      }
    }

    await transaction.commit();

    // Fetch complete order
    const completeOrder = await req.db.models.OnlineStoreOrder.findByPk(order.id, {
      include: [
        {
          model: req.db.models.OnlineStore
        },
        {
          model: req.db.models.Store
        },
        {
          model: req.db.models.OnlineStoreOrderItem,
          include: [
            {
              model: req.db.models.Product
            }
          ]
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data: { order: completeOrder }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error creating order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create order'
    });
  }
}

/**
 * Update order status
 */
async function updateOrderStatus(req, res) {
  try {
    const { status, payment_status } = req.body;
    
    const order = await req.db.models.OnlineStoreOrder.findByPk(req.params.id);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
    const validPaymentStatuses = ['pending', 'paid', 'failed', 'refunded'];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    if (payment_status && !validPaymentStatuses.includes(payment_status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment status'
      });
    }

    await order.update({
      ...(status !== undefined && { status }),
      ...(payment_status !== undefined && { payment_status })
    });

    res.json({
      success: true,
      message: 'Order status updated successfully',
      data: { order }
    });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update order status'
    });
  }
}

module.exports = {
  getAllOrders,
  getOrderById,
  createOrder,
  updateOrderStatus
};

