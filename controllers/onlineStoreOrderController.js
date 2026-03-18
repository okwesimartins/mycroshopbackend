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
 * Normalize date string to YYYY-MM-DD so "2026-01-1" becomes "2026-01-01"
 */
function normalizeDateString(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr;
  const d = new Date(dateStr.trim());
  if (Number.isNaN(d.getTime())) return dateStr;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Get all orders (product orders and booking orders combined)
 * Returns both OnlineStoreOrder (product orders) and Booking (service booking orders).
 *
 * Query params:
 *   - online_store_id: filter product orders by online store
 *   - status: filter by order status (e.g. confirmed, pending)
 *   - payment_status: filter product orders by payment_status (e.g. paid, pending)
 *   - start_date, end_date: filter by order date (product: created_at, booking: scheduled_at). Format YYYY-MM-DD (e.g. 2026-01-01)
 *   - order_type: 'product_order' | 'booking_order' | omit (both)
 *       product_order = product orders only; booking_order = service/booking orders only; omit = both
 *   - search: global search by customer name or order number (product: order_number; booking: Customer name, BOOK-<id>)
 *   - store_id: filter by physical store
 *   - customer_id: filter booking orders by customer
 *   - service_id: filter booking orders by service
 *   - page, limit: pagination (default page=1, limit=50)
 *   - include_items: 'true' | 'false' – include line items for product orders (default true)
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
      order_type,
      search,
      customer_id,
      service_id,
      include_items = 'true'
    } = req.query;
    const offset = (page - 1) * limit;
    const includeItems = include_items !== 'false' && include_items !== '0';

    if (order_type && !['product_order', 'booking_order'].includes(order_type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order_type. Must be "product_order", "booking_order", or omitted (for both)'
      });
    }

    const tenant = req.tenant || req.user?.tenant;
    const isFreePlan = tenant?.subscription_plan === 'free';
    const tenantId = req.user?.tenantId;

    const normalizedStart = start_date ? normalizeDateString(start_date) : null;
    const normalizedEnd = end_date ? normalizeDateString(end_date) : null;
    const searchTerm = (typeof search === 'string' && search.trim()) ? search.trim() : null;
    const searchLike = searchTerm ? '%' + searchTerm.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%' : null;

    let productOrders = [];
    let bookingOrders = [];
    let productOrdersCount = 0;
    let bookingOrdersCount = 0;

    if (!order_type || order_type === 'product_order') {
      const productOrderWhere = {};

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

      // Global search: customer name or order number (case-insensitive partial match)
      if (searchLike) {
        const term = '%' + searchTerm.toLowerCase().replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
        productOrderWhere[Sequelize.Op.or] = [
          Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('customer_name')), { [Sequelize.Op.like]: term }),
          Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('order_number')), { [Sequelize.Op.like]: term })
        ];
      }

      // Date filter: use order created_at (order date), not payment paid_at, so all orders in range are returned
      if (normalizedStart || normalizedEnd) {
        productOrderWhere.created_at = {};
        if (normalizedStart) {
          productOrderWhere.created_at[Sequelize.Op.gte] = new Date(`${normalizedStart}T00:00:00.000Z`);
        }
        if (normalizedEnd) {
          productOrderWhere.created_at[Sequelize.Op.lte] = new Date(`${normalizedEnd}T23:59:59.999Z`);
        }
      }

      const productOrderInclude = [
        {
          model: req.db.models.OnlineStore,
          attributes: ['id', 'username', 'store_name'],
          required: false
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state'],
          required: false
        },
        {
          model: req.db.models.PaymentTransaction,
          attributes: ['id', 'status', 'paid_at'],
          required: false
        }
      ];

      if (includeItems) {
        productOrderInclude.push({
          model: req.db.models.OnlineStoreOrderItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'sku'],
              required: false
            }
          ]
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
      if (normalizedStart || normalizedEnd) {
        bookingWhere.scheduled_at = {};
        if (normalizedStart) {
          bookingWhere.scheduled_at[Sequelize.Op.gte] = new Date(`${normalizedStart}T00:00:00.000Z`);
        }
        if (normalizedEnd) {
          bookingWhere.scheduled_at[Sequelize.Op.lte] = new Date(`${normalizedEnd}T23:59:59.999Z`);
        }
      }

      // Global search: Customer name, email, or booking "order number" (BOOK-<id>)
      if (searchLike) {
        const term = '%' + searchTerm.toLowerCase().replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
        const bookingSearchOr = [
          Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('Customer.name')), { [Sequelize.Op.like]: term }),
          Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('Customer.email')), { [Sequelize.Op.like]: term })
        ];
        const bookIdMatch = searchTerm.match(/^BOOK-(\d+)$/i);
        if (bookIdMatch) {
          bookingSearchOr.push({ id: parseInt(bookIdMatch[1], 10) });
        }
        bookingWhere[Sequelize.Op.or] = bookingSearchOr;
      }

      const bookingInclude = [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type'],
          required: false
        },
        {
          model: req.db.models.StoreService,
          attributes: ['id', 'service_title', 'duration_minutes', 'price']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone'],
          required: !!searchLike
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
    
    // Format product orders: single representation (items + payment_transaction only, no duplicate OnlineStoreOrderItems/PaymentTransactions)
    productOrders.forEach(order => {
      const orderData = order.toJSON();
      const { OnlineStoreOrderItems, PaymentTransactions, PaymentTransaction, ...rest } = orderData;
      const paymentTx = (Array.isArray(PaymentTransactions) && PaymentTransactions.length ? PaymentTransactions[0] : null) || PaymentTransaction || null;
      allOrders.push({
        ...rest,
        order_type: 'product_order',
        order_id: orderData.id,
        order_number: orderData.order_number,
        customer_name: orderData.customer_name,
        customer_email: orderData.customer_email,
        customer_phone: orderData.customer_phone,
        total_amount: orderData.total,
        order_date: orderData.created_at,
        scheduled_at: null,
        items: includeItems ? (OnlineStoreOrderItems || []) : undefined,
        service: null,
        payment_transaction: paymentTx
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

    const approxEq = (a, b, eps = 0.01) => {
      const x = Number(a);
      const y = Number(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return false;
      return Math.abs(x - y) <= eps;
    };

    for (const item of items) {
      const {
        product_id,
        variant_id: itemVariantId,
        variation_id: itemVariationId,
        variation_option_id: itemVariationOptionId,
        quantity,
        unit_price
      } = item;
      
      if (!product_id || quantity == null || quantity === '' || unit_price == null || unit_price === '') {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Each item must have product_id, quantity, and unit_price'
        });
      }

      // Free/shared DB products table may not have `store_id` column.
      // Avoid selecting non-existent columns by explicitly selecting safe attributes.
      const product = await req.db.models.Product.findOne({
        where: { id: product_id },
        attributes: ['id', 'name', 'sku', 'price', 'stock']
      });
      if (!product) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Product ${product_id} not found`
        });
      }

      const unitPriceNum = Number(unit_price);
      if (Number.isNaN(unitPriceNum)) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'unit_price must be a number'
        });
      }

      let variantSku = null;
      let variationName = null;
      let variationOptionValue = null;

      // ── Validate: variant_id vs variation_option_id (mutually exclusive) ──
      if (itemVariantId && (itemVariationId || itemVariationOptionId)) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Provide either variant_id OR (variation_id + variation_option_id), not both'
        });
      }

      // ── Variant-level validation + stock + price ───────────────────────
      if (itemVariantId) {
        const variant = await req.db.models.ProductVariant.findOne({
          where: { id: itemVariantId, product_id }
        });
        if (!variant) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Variant ${itemVariantId} not found for product ${product.name}`
          });
        }
        const variantStock = Number(variant.stock);
        if (variantStock < quantity) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for ${product.name} (selected option). Available: ${variantStock}, Requested: ${quantity}`
          });
        }
        // Validate unit_price matches variant price (when variant price is set)
        const expected = variant.price != null ? Number(variant.price) : null;
        if (expected != null && !Number.isNaN(expected) && !approxEq(unitPriceNum, expected)) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Invalid unit_price for selected variant. Expected ${expected}, got ${unitPriceNum}`
          });
        }
        variantSku = variant.sku;
      }

      // ── Variation option-level validation + stock + price ───────────────
      // This supports products that use variation options directly (no ProductVariant rows).
      if (!itemVariantId && (itemVariationId || itemVariationOptionId)) {
        if (!itemVariationId || !itemVariationOptionId) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'When using variation options, both variation_id and variation_option_id are required'
          });
        }

        const variation = await req.db.models.ProductVariation.findOne({
          where: { id: itemVariationId, product_id }
        });
        if (!variation) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Variation ${itemVariationId} not found for this product`
          });
        }

        const option = await req.db.models.ProductVariationOption.findOne({
          where: { id: itemVariationOptionId, variation_id: itemVariationId }
        });
        if (!option) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Variation option ${itemVariationOptionId} not found for this variation`
          });
        }

        // Stock check at option level if present
        if (option.stock != null) {
          const optStock = Number(option.stock);
          if (!Number.isNaN(optStock) && optStock < Number(quantity)) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              message: `Insufficient stock for ${product.name} (${variation.variation_name}: ${option.option_display_name || option.option_value}). Available: ${optStock}, Requested: ${quantity}`
            });
          }
        }

        // Price check: expected = product.price + option.price_adjustment (fallbacks to 0)
        const basePrice = product.price != null ? Number(product.price) : 0;
        const adj = option.price_adjustment != null ? Number(option.price_adjustment) : 0;
        const expected = (Number.isNaN(basePrice) ? 0 : basePrice) + (Number.isNaN(adj) ? 0 : adj);
        if (!approxEq(unitPriceNum, expected)) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Invalid unit_price for selected option. Expected ${expected}, got ${unitPriceNum}`
          });
        }

        variationName = variation.variation_name || null;
        variationOptionValue = option.option_value || option.option_display_name || null;
      }

      // ── Product/store stock checks (only when not variant/option-level) ──
      if (!itemVariantId && !itemVariationOptionId && finalStoreId) {
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
      } else if (!itemVariantId && !itemVariationOptionId) {
        // Online-only (no store): check product or variant stock
        const productStock = product.stock != null ? Number(product.stock) : null;
        if (productStock !== null && productStock < quantity) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for ${product.name}. Available: ${productStock}, Requested: ${quantity}`
          });
        }
      }

      // Price check for non-variant, non-option items: must match base product.price (when set)
      if (!itemVariantId && !itemVariationOptionId && product.price != null) {
        const expected = Number(product.price);
        if (!Number.isNaN(expected) && !approxEq(unitPriceNum, expected)) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Invalid unit_price for product. Expected ${expected}, got ${unitPriceNum}`
          });
        }
      }

      const itemTotal = Number(quantity) * unitPriceNum;
      subtotal += itemTotal;

      orderItems.push({
        product_id,
        product_name: product.name,
        product_sku: variantSku || product.sku || null,
        quantity,
        unit_price: unitPriceNum,
        total: itemTotal,
        variant_id: itemVariantId || null,
        variation_id: itemVariationId || null,
        variation_option_id: itemVariationOptionId || null,
        variation_name: variationName,
        variation_option_value: variationOptionValue
      });
    }

    const taxAmount = subtotal * (tax_rate / 100);
    const total = subtotal + taxAmount + shipping_amount - discount_amount;

    const orderPayload = {
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
    };
    if (req.tenant?.subscription_plan === 'free' && req.user?.tenantId) {
      orderPayload.tenant_id = req.user.tenantId;
    }

    const order = await req.db.models.OnlineStoreOrder.create(orderPayload, { transaction });

    const tenantIdForItems = req.tenant?.subscription_plan === 'free' ? req.user?.tenantId : null;
    for (const item of orderItems) {
      const itemPayload = { order_id: order.id, ...item };
      if (tenantIdForItems != null) itemPayload.tenant_id = tenantIdForItems;
      await req.db.models.OnlineStoreOrderItem.create(itemPayload, { transaction });
    }

    // Deduct stock: variant-level, then option-level, then store-level, then product-level (online-only)
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const qty = Number(item.quantity);
      if (item.variant_id) {
        const pv = await req.db.models.ProductVariant.findByPk(item.variant_id);
        if (pv) {
          await pv.update({ stock: Number(pv.stock) - qty }, { transaction });
        }
      } else if (item.variation_option_id) {
        const opt = await req.db.models.ProductVariationOption.findByPk(item.variation_option_id);
        if (opt && opt.stock != null) {
          await opt.update({ stock: Number(opt.stock) - qty }, { transaction });
        }
      } else if (finalStoreId) {
        const productStore = await req.db.models.ProductStore.findOne({
          where: { product_id: item.product_id, store_id: finalStoreId }
        });
        if (productStore) {
          await productStore.update({
            stock: productStore.stock - qty
          }, { transaction });
        }
      } else {
        const p = await req.db.models.Product.findOne({
          where: { id: item.product_id },
          attributes: ['id', 'stock']
        });
        if (p && p.stock != null) {
          await p.update({ stock: Number(p.stock) - qty }, { transaction });
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
          model: req.db.models.Store,
          attributes: ['id', 'name']
        },
        {
          model: req.db.models.OnlineStoreOrderItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'sku', 'price', 'stock', 'image_url']
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
    const message = error && error.message ? String(error.message) : 'Failed to create order';
    res.status(500).json({
      success: false,
      message
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

