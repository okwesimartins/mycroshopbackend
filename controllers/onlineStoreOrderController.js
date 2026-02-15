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
 * Get all orders (product orders and booking orders combined)
 * Returns both OnlineStoreOrder (product orders) and Booking (service booking orders)
 */
async function getAllOrders(req, res) {
  try {
    const { 
      page = 1, 
      limit = 50, 
      status, 
      payment_status, 
      store_id, 
      online_store_id, 
      start_date, 
      end_date,
      order_type, // 'product_order', 'booking_order', or undefined (both)
      customer_id,
      service_id
    } = req.query;
    const offset = (page - 1) * limit;

    // Validate order_type if provided
    if (order_type && !['product_order', 'booking_order'].includes(order_type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order_type. Must be "product_order", "booking_order", or omitted (for both)'
      });
    }

    // Get tenant info to determine if free or enterprise
    const tenant = req.tenant || req.user?.tenant;
    const isFreePlan = tenant?.subscription_plan === 'free';
    const tenantId = req.user?.tenantId;

    // Arrays to store both types of orders
    let productOrders = [];
    let bookingOrders = [];
    let productOrdersCount = 0;
    let bookingOrdersCount = 0;

    // Fetch product orders (OnlineStoreOrder) if order_type is not 'booking_order'
    if (!order_type || order_type === 'product_order') {
      const productOrderWhere = {};
      
      // For free users, filter by tenant_id
      if (isFreePlan && tenantId) {
        productOrderWhere.tenant_id = tenantId;
      }
      
      if (online_store_id) {
        productOrderWhere.online_store_id = online_store_id;
      }
      if (store_id) {
        productOrderWhere.store_id = store_id;
      }
      if (status) {
        productOrderWhere.status = status;
      }
      if (payment_status) {
        productOrderWhere.payment_status = payment_status;
      }

      // Build includes for product orders
      const productOrderInclude = [
        {
          model: req.db.models.OnlineStore,
          attributes: ['id', 'username', 'store_name'],
          required: false
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state'],
          required: false // Optional - free users may not have stores
        },
        {
          model: req.db.models.OnlineStoreOrderItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'sku'],
              required: false
            }
          ]
        }
      ];

      // Handle date filtering for product orders
      if (start_date || end_date) {
        const paymentDateWhere = {};
        if (start_date) {
          paymentDateWhere[Sequelize.Op.gte] = new Date(`${start_date}T00:00:00.000Z`);
        }
        if (end_date) {
          paymentDateWhere[Sequelize.Op.lte] = new Date(`${end_date}T23:59:59.999Z`);
        }

        productOrderInclude.push({
          model: req.db.models.PaymentTransaction,
          attributes: ['id', 'status', 'paid_at'],
          required: true,
          where: {
            status: 'success',
            paid_at: paymentDateWhere
          }
        });
      } else {
        productOrderInclude.push({
          model: req.db.models.PaymentTransaction,
          attributes: ['id', 'status', 'paid_at'],
          required: false
        });
      }

      const productOrderResult = await req.db.models.OnlineStoreOrder.findAndCountAll({
        where: productOrderWhere,
        include: productOrderInclude,
        distinct: true,
        order: [['created_at', 'DESC']]
      });

      productOrders = productOrderResult.rows;
      productOrdersCount = productOrderResult.count;
    }

    // Fetch booking orders (Booking) if order_type is not 'product_order'
    if (!order_type || order_type === 'booking_order') {
      const bookingWhere = {};
      
      // For free users, filter by tenant_id
      // Note: Database table has tenant_id even if model definition doesn't include it
      // Sequelize will work with it as long as the column exists in the database
      if (isFreePlan && tenantId) {
        bookingWhere.tenant_id = tenantId;
      }
      
      if (store_id) {
        bookingWhere.store_id = store_id;
      }
      if (status) {
        bookingWhere.status = status;
      }
      if (customer_id) {
        bookingWhere.customer_id = customer_id;
      }
      if (service_id) {
        bookingWhere.service_id = service_id;
      }
      if (start_date || end_date) {
        bookingWhere.scheduled_at = {};
        if (start_date) {
          bookingWhere.scheduled_at[Sequelize.Op.gte] = new Date(`${start_date}T00:00:00.000Z`);
        }
        if (end_date) {
          bookingWhere.scheduled_at[Sequelize.Op.lte] = new Date(`${end_date}T23:59:59.999Z`);
        }
      }

      const bookingInclude = [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type'],
          required: false // Optional - free users may not have stores
        },
        {
          model: req.db.models.StoreService,
          attributes: ['id', 'service_title', 'duration_minutes', 'price']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone'],
          required: false
        }
      ];

      const bookingResult = await req.db.models.Booking.findAndCountAll({
        where: bookingWhere,
        include: bookingInclude,
        distinct: true,
        order: [['scheduled_at', 'DESC']]
      });

      bookingOrders = bookingResult.rows;
      bookingOrdersCount = bookingResult.count;
    }

    // Combine and format orders
    const allOrders = [];
    
    // Format product orders
    productOrders.forEach(order => {
      const orderData = order.toJSON();
      allOrders.push({
        ...orderData,
        order_type: 'product_order',
        order_id: orderData.id,
        order_number: orderData.order_number,
        customer_name: orderData.customer_name,
        customer_email: orderData.customer_email,
        customer_phone: orderData.customer_phone,
        total_amount: orderData.total,
        order_date: orderData.created_at,
        scheduled_at: null, // Product orders don't have scheduled_at
        items: orderData.OnlineStoreOrderItems || [],
        service: null, // Product orders don't have service
        payment_transaction: orderData.PaymentTransaction || null
      });
    });

    // Format booking orders
    bookingOrders.forEach(booking => {
      const bookingData = booking.toJSON();
      const service = bookingData.StoreService || {};
      allOrders.push({
        ...bookingData,
        order_type: 'booking_order',
        order_id: bookingData.id,
        order_number: `BOOK-${bookingData.id}`, // Generate order number for bookings
        customer_name: bookingData.Customer?.name || null,
        customer_email: bookingData.Customer?.email || null,
        customer_phone: bookingData.Customer?.phone || null,
        total_amount: service.price || 0,
        order_date: bookingData.created_at,
        scheduled_at: bookingData.scheduled_at,
        items: [], // Bookings don't have items array
        service: {
          id: service.id,
          title: service.service_title,
          duration_minutes: service.duration_minutes,
          price: service.price
        },
        payment_transaction: null // Bookings may have payment but it's handled differently
      });
    });

    // Sort combined orders by order_date (most recent first)
    allOrders.sort((a, b) => {
      const dateA = new Date(a.order_date);
      const dateB = new Date(b.order_date);
      return dateB - dateA;
    });

    // Apply pagination to combined results
    const totalOrders = allOrders.length;
    const paginatedOrders = allOrders.slice(offset, offset + parseInt(limit));

    res.json({
      success: true,
      data: {
        orders: paginatedOrders,
        pagination: {
          total: totalOrders,
          product_orders_count: productOrdersCount,
          booking_orders_count: bookingOrdersCount,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(totalOrders / limit)
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
    // Get tenant info to determine if free or enterprise
    const tenant = req.tenant || req.user?.tenant;
    const isFreePlan = tenant?.subscription_plan === 'free';

    const order = await req.db.models.OnlineStoreOrder.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.OnlineStore,
          attributes: ['id', 'username', 'store_name']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state', 'phone', 'email'],
          required: false // Optional - free users may not have stores
        },
        {
          model: req.db.models.OnlineStoreOrderItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'sku', 'description', 'image_url', 'price', 'category'], // Only include fields that exist
              required: false, // Product might be deleted
              // Don't include Store association from Product to avoid store_id column issue
              include: []
            }
          ]
        },
        {
          model: req.db.models.PaymentTransaction,
          attributes: ['id', 'transaction_reference', 'status', 'amount', 'paid_at', 'gateway_name'],
          required: false // Payment might not exist yet
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
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to get order',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      errorDetails: process.env.NODE_ENV === 'development' ? {
        stack: error.stack,
        name: error.name
      } : undefined
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

