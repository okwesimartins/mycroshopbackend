/**
 * Public Checkout Controller
 * Handles customer checkout and payment initialization
 * No authentication required - customers don't need to login
 */

const { getTenantConnection } = require('../config/database');
const { getTenantById } = require('../config/tenant');
const initModels = require('../models');
const { decryptSecretKey } = require('./paymentGatewayController');
const axios = require('axios');
const crypto = require('crypto');

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
 * Generate transaction reference
 */
function generateTransactionReference() {
  return `TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Initialize Paystack payment
 */
async function initializePaystackPayment(paymentData, secretKey, testMode, splitOptions = null) {
  const baseUrl = 'https://api.paystack.co';

  try {
    const payload = { ...paymentData };

    if (splitOptions && splitOptions.subaccount) {
      payload.subaccount = splitOptions.subaccount;
      if (splitOptions.charge_amount) {
        payload.charge_amount = splitOptions.charge_amount;
      }
    }

    const response = await axios.post(
      `${baseUrl}/transaction/initialize`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      authorization_url: response.data.data.authorization_url,
      access_code: response.data.data.access_code,
      reference: response.data.data.reference,
      gateway_transaction_id: response.data.data.reference,
      status: 'pending'
    };
  } catch (error) {
    console.error('Paystack initialization error:', error.response?.data || error.message);
    throw new Error('Failed to initialize Paystack payment');
  }
}

/**
 * Initialize Flutterwave payment
 */
async function initializeFlutterwavePayment(paymentData, secretKey, testMode) {
  const baseUrl = testMode
    ? 'https://api.flutterwave.com/v3'
    : 'https://api.flutterwave.com/v3';

  try {
    const response = await axios.post(
      `${baseUrl}/payments`,
      paymentData,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      authorization_url: response.data.data.link,
      access_code: response.data.data.flw_ref,
      reference: paymentData.tx_ref,
      gateway_transaction_id: response.data.data.id.toString(),
      status: 'pending'
    };
  } catch (error) {
    console.error('Flutterwave initialization error:', error.response?.data || error.message);
    throw new Error('Failed to initialize Flutterwave payment');
  }
}

/**
 * Create order (checkout) - Public endpoint
 * POST /api/v1/public-checkout/orders
 */
async function createPublicOrder(req, res) {
  try {
    const {
      tenant_id, // Required - to identify which tenant database
      online_store_id,
      store_id, // Physical store to fulfill order (optional)
      idempotency_key, // Optional - Unique key to prevent duplicate orders
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

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id is required'
      });
    }

    if (!online_store_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'online_store_id and items are required'
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Get tenant_id for order queries (for free users)
    const isFreePlan = tenant.subscription_plan === 'free';
    const orderTenantId = isFreePlan ? tenant_id : null;

    // Check for duplicate order using idempotency key
    if (idempotency_key) {
      const whereClause = {
        idempotency_key: idempotency_key,
        online_store_id: online_store_id
      };
      
      // For free users, also filter by tenant_id
      if (isFreePlan && orderTenantId) {
        whereClause.tenant_id = orderTenantId;
      }

      // For free users: don't include Store (they don't have physical stores)
      const existingOrder = await models.OnlineStoreOrder.findOne({
        where: whereClause,
        include: [
          {
            model: models.OnlineStore,
            attributes: ['id', 'username', 'store_name']
          },
          // Only include Store for enterprise users (free users don't have physical stores)
          ...(isFreePlan ? [] : [{
            model: models.Store,
            attributes: ['id', 'name', 'store_type', 'address', 'city', 'state'],
            required: false
          }]),
          {
            model: models.OnlineStoreOrderItem
          }
        ]
      });

      if (existingOrder) {
        // Return existing order - this is a duplicate request
        return res.status(200).json({
          success: true,
          message: 'Order already exists (duplicate request detected)',
          data: {
            order: existingOrder,
            is_duplicate: true
          }
        });
      }
    }

    const transaction = await sequelize.transaction();

    try {
      // Verify online store exists and is published
      const onlineStore = await models.OnlineStore.findOne({
        where: {
          id: online_store_id,
          is_published: true
        }
      });

      if (!onlineStore) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Online store not found or not published'
        });
      }

      // Handle store_id - free users don't have physical stores
      // For free users: store_id should always be null
      // For enterprise users: verify store is linked to online store
      let finalStoreId = null;
      
      if (!isFreePlan && store_id) {
        // Enterprise users: verify store is linked to online store
        const storeLink = await models.OnlineStoreLocation.findOne({
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
      } else if (!isFreePlan && !store_id) {
        // Enterprise users: get default store for online store if no store_id provided
        const defaultStore = await models.OnlineStoreLocation.findOne({
          where: { online_store_id, is_default: true }
        });
        if (defaultStore) {
          finalStoreId = defaultStore.store_id;
        }
      }
      // For free users: finalStoreId remains null (they don't have physical stores)

      // Calculate totals
      let subtotal = 0;
      const orderItems = [];

      for (const item of items) {
        let { 
          product_id, 
          quantity, 
          unit_price,
          variation_id,        // Optional - variation ID (e.g., Color variation)
          variation_option_id  // Optional - specific option ID (e.g., Red option)
        } = item;

        if (!product_id || !quantity || !unit_price) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'Each item must have product_id, quantity, and unit_price'
          });
        }

        // Verify product exists and is active
        // For free users: exclude store_id and other enterprise-only columns
        const productAttributes = isFreePlan 
          ? ['id', 'tenant_id', 'name', 'description', 'sku', 'barcode', 'price', 'stock', 'low_stock_threshold', 'category', 'image_url', 'expiry_date', 'is_active', 'created_at', 'updated_at']
          : undefined; // Enterprise users: select all columns
        
        const product = await models.Product.findOne({
          where: {
            id: product_id,
            is_active: true
          },
          ...(productAttributes ? { attributes: productAttributes } : {})
        });

        if (!product) {
          await transaction.rollback();
          return res.status(404).json({
            success: false,
            message: `Product ${product_id} not found or not available`
          });
        }

        // Verify and get variation option if provided
        let variationOption = null;
        let variationName = null;
        let variationOptionValue = null;
        
        if (variation_option_id || variation_id) {
          // If variation_option_id is provided, verify it exists and belongs to the product
          if (variation_option_id) {
            // For free users, we need to verify via the variation's product_id and tenant_id
            const { Sequelize } = require('sequelize');
            const variationOptionQuery = isFreePlan && orderTenantId
              ? `SELECT pvo.id, pvo.variation_id, pvo.option_value, pvo.option_display_name, 
                        pv.variation_name, pv.product_id
                 FROM product_variation_options pvo
                 INNER JOIN product_variations pv ON pvo.variation_id = pv.id
                 WHERE pvo.id = :optionId AND pv.product_id = :productId AND pvo.tenant_id = :tenantId`
              : `SELECT pvo.id, pvo.variation_id, pvo.option_value, pvo.option_display_name, 
                        pv.variation_name, pv.product_id
                 FROM product_variation_options pvo
                 INNER JOIN product_variations pv ON pvo.variation_id = pv.id
                 WHERE pvo.id = :optionId AND pv.product_id = :productId`;
            
            const variationOptionRows = await sequelize.query(variationOptionQuery, {
              replacements: { 
                optionId: variation_option_id,
                productId: product_id,
                ...(isFreePlan && orderTenantId ? { tenantId: orderTenantId } : {})
              },
              type: Sequelize.QueryTypes.SELECT,
              transaction
            });

            if (!variationOptionRows || variationOptionRows.length === 0) {
              await transaction.rollback();
              return res.status(400).json({
                success: false,
                message: `Invalid variation option for product ${product.name}`
              });
            }

            const variationOptionRow = variationOptionRows[0];
            variationOption = {
              id: variationOptionRow.id,
              variation_id: variationOptionRow.variation_id,
              option_value: variationOptionRow.option_value,
              option_display_name: variationOptionRow.option_display_name
            };
            variationName = variationOptionRow.variation_name;
            variationOptionValue = variationOptionRow.option_display_name || variationOptionRow.option_value;
            variation_id = variationOptionRow.variation_id; // Update variation_id from option
          } else if (variation_id) {
            // Only variation_id provided - verify it belongs to the product
            const { Sequelize } = require('sequelize');
            const variationQuery = isFreePlan && orderTenantId
              ? `SELECT id, variation_name, product_id 
                 FROM product_variations 
                 WHERE id = :variationId AND product_id = :productId AND tenant_id = :tenantId`
              : `SELECT id, variation_name, product_id 
                 FROM product_variations 
                 WHERE id = :variationId AND product_id = :productId`;
            
            const variationRows = await sequelize.query(variationQuery, {
              replacements: { 
                variationId: variation_id,
                productId: product_id,
                ...(isFreePlan && orderTenantId ? { tenantId: orderTenantId } : {})
              },
              type: Sequelize.QueryTypes.SELECT,
              transaction
            });

            if (!variationRows || variationRows.length === 0) {
              await transaction.rollback();
              return res.status(400).json({
                success: false,
                message: `Invalid variation for product ${product.name}`
              });
            }

            variationName = variationRows[0].variation_name;
          }
        }

        // Check stock - for variations, check stock on the variation option
        // For free users: check stock directly from products table or variation options
        // For enterprise users: check stock from product_stores table if store_id is provided, or variation options
        if (variationOption) {
          // Check stock on variation option
          const { Sequelize } = require('sequelize');
          const stockQuery = `SELECT stock FROM product_variation_options WHERE id = :optionId`;
          const stockRows = await sequelize.query(stockQuery, {
            replacements: { optionId: variation_option_id },
            type: Sequelize.QueryTypes.SELECT,
            transaction
          });

          if (stockRows && stockRows.length > 0 && stockRows[0].stock !== null && stockRows[0].stock < quantity) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              message: `Insufficient stock for ${product.name} - ${variationOptionValue}. Available: ${stockRows[0].stock}, Requested: ${quantity}`
            });
          }
        } else if (isFreePlan) {
          // Free users: stock is on the products table directly
          if (product.stock !== null && product.stock < quantity) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              message: `Insufficient stock for product ${product.name}. Available: ${product.stock}, Requested: ${quantity}`
            });
          }
        } else if (finalStoreId) {
          // Enterprise users: check stock from product_stores table
          const productStore = await models.ProductStore.findOne({
            where: { product_id, store_id: finalStoreId }
          });

          if (productStore && productStore.stock !== null && productStore.stock < quantity) {
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
          product_sku: product.sku || null,
          quantity,
          unit_price,
          total: itemTotal,
          variation_id: variation_id || null,
          variation_option_id: variation_option_id || null,
          variation_name: variationName || null,
          variation_option_value: variationOptionValue || null
        });
      }

      // Handle optional tax_rate, shipping_amount, discount_amount (default to 0 if not provided)
      const finalTaxRate = tax_rate !== undefined && tax_rate !== null ? parseFloat(tax_rate) : 0;
      const finalShippingAmount = shipping_amount !== undefined && shipping_amount !== null ? parseFloat(shipping_amount) : 0;
      const finalDiscountAmount = discount_amount !== undefined && discount_amount !== null ? parseFloat(discount_amount) : 0;
      
      const taxAmount = subtotal * (finalTaxRate / 100);
      const total = subtotal + taxAmount + finalShippingAmount - finalDiscountAmount;

      // Generate order number (ensure uniqueness)
      let orderNumber = generateOrderNumber();
      let orderNumberExists = true;
      let attempts = 0;
      const maxAttempts = 10;

      // Ensure order number is unique (handle rare collisions)
      while (orderNumberExists && attempts < maxAttempts) {
        const whereClause = { order_number: orderNumber };
        if (isFreePlan && orderTenantId) {
          whereClause.tenant_id = orderTenantId;
        }

        const existingOrderNumber = await models.OnlineStoreOrder.findOne({
          where: whereClause,
          attributes: ['id']
        });

        if (!existingOrderNumber) {
          orderNumberExists = false;
        } else {
          orderNumber = generateOrderNumber();
          attempts++;
        }
      }

      if (orderNumberExists) {
        await transaction.rollback();
        return res.status(500).json({
          success: false,
          message: 'Failed to generate unique order number. Please try again.'
        });
      }

      // Create order
      const order = await models.OnlineStoreOrder.create({
        tenant_id: orderTenantId,
        online_store_id,
        store_id: finalStoreId,
        order_number: orderNumber,
        idempotency_key: idempotency_key || null, // Store idempotency key to prevent duplicates
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
        shipping_amount: finalShippingAmount,
        discount_amount: finalDiscountAmount,
        total,
        status: 'pending',
        payment_status: 'pending',
        payment_method: payment_method || null,
        notes: notes || null
      }, { transaction });

      // Create order items
      for (const item of orderItems) {
        await models.OnlineStoreOrderItem.create({
          tenant_id: orderTenantId,
          order_id: order.id,
          ...item
        }, { transaction });
      }

      // Update stock
      // For variations: update stock on variation options
      // For free users: update stock on products table directly (if no variation)
      // For enterprise users: update stock on product_stores table if store_id is provided (if no variation)
      
      for (const item of items) {
        const { product_id, quantity, variation_option_id } = item;
        
        if (variation_option_id) {
          // Update stock on variation option
          await sequelize.query(
            `UPDATE product_variation_options 
             SET stock = stock - :quantity 
             WHERE id = :optionId AND stock IS NOT NULL`,
            {
              replacements: { optionId: variation_option_id, quantity },
              transaction
            }
          );
        } else if (isFreePlan) {
          // Free users: update stock on products table directly
          const product = await models.Product.findByPk(product_id, { transaction });
          if (product && product.stock !== null) {
            await product.update({
              stock: product.stock - quantity
            }, { transaction });
          }
        } else if (finalStoreId) {
          // Enterprise users: update stock on product_stores table
          const productStore = await models.ProductStore.findOne({
            where: { product_id, store_id: finalStoreId }
          }, { transaction });

          if (productStore && productStore.stock !== null) {
            await productStore.update({
              stock: productStore.stock - quantity
            }, { transaction });
          }
        }
      }

      await transaction.commit();

      // Fetch complete order
      // For free users: don't include Store (they don't have physical stores)
      // For free users: exclude store_id and other enterprise-only columns from Product
      const productAttributesForOrder = isFreePlan 
        ? ['id', 'tenant_id', 'name', 'description', 'sku', 'barcode', 'price', 'stock', 'low_stock_threshold', 'category', 'image_url', 'expiry_date', 'is_active', 'created_at', 'updated_at']
        : undefined; // Enterprise users: select all columns
      
      const completeOrder = await models.OnlineStoreOrder.findByPk(order.id, {
        include: [
          {
            model: models.OnlineStore,
            attributes: ['id', 'username', 'store_name']
          },
          // Only include Store for enterprise users (free users don't have physical stores)
          ...(isFreePlan ? [] : [{
            model: models.Store,
            attributes: ['id', 'name', 'store_type', 'address', 'city', 'state'],
            required: false
          }]),
          {
            model: models.OnlineStoreOrderItem,
            include: [
              {
                model: models.Product,
                attributes: productAttributesForOrder,
                required: false
              }
            ]
          }
        ]
      });

      // Note: Order confirmation email will be sent after successful payment
      // See paymentController.js - verifyPayment() and handlePaymentWebhook()

      res.status(201).json({
        success: true,
        message: 'Order created successfully',
        data: {
          order: completeOrder
        }
      });
    } catch (error) {
      await transaction.rollback();
      
      // Handle duplicate idempotency key error
      if (error.name === 'SequelizeUniqueConstraintError' && error.errors) {
        const uniqueError = error.errors.find(e => e.path === 'idempotency_key' || e.path?.includes('idempotency'));
        if (uniqueError && idempotency_key) {
          // Duplicate idempotency key - fetch and return existing order
          const whereClause = {
            idempotency_key: idempotency_key,
            online_store_id: online_store_id
          };
          
          if (isFreePlan && orderTenantId) {
            whereClause.tenant_id = orderTenantId;
          }

          const existingOrder = await models.OnlineStoreOrder.findOne({
            where: whereClause,
            include: [
              {
                model: models.OnlineStore,
                attributes: ['id', 'username', 'store_name']
              },
              {
                model: models.Store,
                attributes: ['id', 'name', 'store_type', 'address', 'city', 'state'],
                required: false
              },
              {
                model: models.OnlineStoreOrderItem
              }
            ]
          });

          if (existingOrder) {
            return res.status(200).json({
              success: true,
              message: 'Order already exists (duplicate request detected)',
              data: {
                order: existingOrder,
                is_duplicate: true
              }
            });
          }
        }
      }
      
      throw error;
    }
  } catch (error) {
    console.error('Error creating public order:', error);
    
    // Handle Sequelize unique constraint errors
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        success: false,
        message: 'Duplicate order detected. If you used an idempotency_key, the order may already exist.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create order',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Initialize payment for order - Public endpoint
 * POST /api/v1/public-checkout/payments/initialize
 */
async function initializePublicPayment(req, res) {
  try {
    const {
      tenant_id, // Required - to identify which tenant
      order_id,
      invoice_id,
      amount,
      email,
      name,
      currency = 'NGN',
      callback_url,
      metadata
    } = req.body;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id is required'
      });
    }

    if (!amount || !email) {
      return res.status(400).json({
        success: false,
        message: 'amount and email are required'
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Get default payment gateway
    const gateway = await models.PaymentGateway.findOne({
      where: {
        is_active: true,
        is_default: true
      }
    });

    if (!gateway) {
      return res.status(400).json({
        success: false,
        message: 'No active payment gateway configured. Please contact the store owner.'
      });
    }

    // Calculate platform fee
    const transactionFeePercentage = tenant.subscription_plan === 'free' 
      ? parseFloat(tenant.transaction_fee_percentage || 3.00)
      : 0.00;

    const calculatedFee = (parseFloat(amount) * transactionFeePercentage) / 100;
    const platformFee = Math.min(calculatedFee, 500); // Cap at 500 NGN
    const merchantAmount = parseFloat(amount) - platformFee;

    // Get online store if order_id is provided (for split payments)
    let onlineStore = null;
    let splitOptions = null;
    if (order_id) {
      const order = await models.OnlineStoreOrder.findByPk(order_id);
      if (order && order.online_store_id) {
        onlineStore = await models.OnlineStore.findByPk(order.online_store_id);

        // If online store has Paystack subaccount configured, use split payment
        if (onlineStore && onlineStore.paystack_subaccount_code && platformFee > 0) {
          const chargeAmountInKobo = Math.round(platformFee * 100);
          splitOptions = {
            subaccount: onlineStore.paystack_subaccount_code,
            charge_amount: chargeAmountInKobo
          };
        }
      }
    }

    // Generate transaction reference
    const transactionReference = generateTransactionReference();

    // Get tenant_id for transaction creation (for free users)
    const isFreePlan = tenant.subscription_plan === 'free';
    const transactionTenantId = isFreePlan ? tenant_id : null;

    // Create payment transaction record
    const paymentTransaction = await models.PaymentTransaction.create({
      tenant_id: transactionTenantId,
      order_id: order_id || null,
      invoice_id: invoice_id || null,
      transaction_reference: transactionReference,
      gateway_name: gateway.gateway_name,
      amount: parseFloat(amount),
      currency,
      platform_fee: platformFee,
      merchant_amount: merchantAmount,
      customer_email: email,
      customer_name: name || null,
      status: 'pending'
    });

    // Initialize payment with gateway
    let paymentData;
    const secretKey = decryptSecretKey(gateway.secret_key);

    // Build metadata
    const paymentMetadata = {
      ...metadata,
      tenant_id: tenant_id,
      transaction_id: paymentTransaction.id
    };

    if (onlineStore) {
      paymentMetadata.online_store_id = onlineStore.id;
    }

    if (gateway.gateway_name === 'paystack') {
      paymentData = await initializePaystackPayment({
        amount: parseFloat(amount) * 100, // Paystack uses kobo
        email,
        reference: transactionReference,
        callback_url: callback_url || `${process.env.FRONTEND_URL || 'http://localhost:3001'}/payment/callback`,
        metadata: paymentMetadata
      }, secretKey, gateway.test_mode, splitOptions);
    } else if (gateway.gateway_name === 'flutterwave') {
      paymentData = await initializeFlutterwavePayment({
        amount: parseFloat(amount),
        email,
        tx_ref: transactionReference,
        currency,
        redirect_url: callback_url || `${process.env.FRONTEND_URL || 'http://localhost:3001'}/payment/callback`,
        customer: {
          email,
          name: name || 'Customer'
        },
        meta: paymentMetadata
      }, secretKey, gateway.test_mode);
    } else {
      return res.status(400).json({
        success: false,
        message: 'Unsupported payment gateway'
      });
    }

    // Update transaction with gateway response
    await paymentTransaction.update({
      gateway_transaction_id: paymentData.gateway_transaction_id || paymentData.reference,
      gateway_response: paymentData
    });

    res.json({
      success: true,
      message: 'Payment initialized successfully',
      data: {
        transaction_reference: transactionReference,
        authorization_url: paymentData.authorization_url,
        access_code: paymentData.access_code,
        gateway: gateway.gateway_name,
        amount: parseFloat(amount),
        currency,
        platform_fee: platformFee,
        merchant_amount: merchantAmount
      }
    });
  } catch (error) {
    console.error('Error initializing public payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initialize payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get order by order number - Public endpoint
 * GET /api/v1/public-checkout/orders/:order_number
 * Allows customers to track their orders using order number
 */
async function getPublicOrderByNumber(req, res) {
  try {
    const { order_number } = req.params;
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Get tenant_id for query (for free users)
    const isFreePlan = tenant.subscription_plan === 'free';
    const orderTenantId = isFreePlan ? tenant_id : null;

    // Find order by order number
    const where = { order_number };
    if (isFreePlan && orderTenantId) {
      where.tenant_id = orderTenantId;
    }

    const order = await models.OnlineStoreOrder.findOne({
      where,
      include: [
        {
          model: models.OnlineStore,
          attributes: ['id', 'username', 'store_name']
        },
        {
          model: models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state'],
          required: false
        },
        {
          model: models.OnlineStoreOrderItem,
          include: [
            {
              model: models.Product,
              attributes: ['id', 'name', 'sku', 'image_url']
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
    console.error('Error getting public order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get order',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  createPublicOrder,
  initializePublicPayment,
  getPublicOrderByNumber
};

