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

      // If store_id provided, verify it's linked to online store
      let finalStoreId = store_id;
      if (store_id) {
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
      } else {
        // Get default store for online store
        const defaultStore = await models.OnlineStoreLocation.findOne({
          where: { online_store_id, is_default: true }
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

        // Verify product exists and is active
        const product = await models.Product.findOne({
          where: {
            id: product_id,
            is_active: true
          }
        });

        if (!product) {
          await transaction.rollback();
          return res.status(404).json({
            success: false,
            message: `Product ${product_id} not found or not available`
          });
        }

        // Check stock if store_id is provided
        if (finalStoreId) {
          const productStore = await models.ProductStore.findOne({
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
          product_sku: product.sku || null,
          quantity,
          unit_price,
          total: itemTotal
        });
      }

      const taxAmount = subtotal * (tax_rate / 100);
      const total = subtotal + taxAmount + shipping_amount - discount_amount;

      // Get tenant_id for order creation (for free users)
      const isFreePlan = tenant.subscription_plan === 'free';
      const orderTenantId = isFreePlan ? tenant_id : null;

      // Create order
      const order = await models.OnlineStoreOrder.create({
        tenant_id: orderTenantId,
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
        await models.OnlineStoreOrderItem.create({
          tenant_id: orderTenantId,
          order_id: order.id,
          ...item
        }, { transaction });
      }

      // Update stock if store_id is provided
      if (finalStoreId) {
        for (const item of items) {
          const productStore = await models.ProductStore.findOne({
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
      const completeOrder = await models.OnlineStoreOrder.findByPk(order.id, {
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
      throw error;
    }
  } catch (error) {
    console.error('Error creating public order:', error);
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

