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
      tenant_id, // Required for BOTH free and enterprise users - to identify which tenant database to connect to
      // NOTE: For enterprise users, tenant_id is NOT saved in the order record (NULL), but still needed to determine database
      // NOTE: For free users, tenant_id IS saved in the order record (from online_store.tenant_id)
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
    // For free users: always use tenant_id from request (they share database)
    // For enterprise users: tenant_id is NULL (separate database)
    // Ensure tenant_id is parsed as integer (in case it comes as string)
    const parsedTenantId = parseInt(tenant_id, 10);
    if (isNaN(parsedTenantId) || parsedTenantId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenant_id provided'
      });
    }
    const orderTenantId = isFreePlan ? parsedTenantId : null;

    // Start transaction early to prevent race conditions
    const transaction = await sequelize.transaction();

    // Check for duplicate order using idempotency key (INSIDE transaction to prevent race conditions)
    // Only check if idempotency_key is provided and not empty
    if (idempotency_key && idempotency_key.trim() !== '') {
      try {
        // Build where clause to match the unique constraint exactly
        // For free users: unique constraint is (tenant_id, idempotency_key)
        // For enterprise users: unique constraint is (idempotency_key)
        const trimmedIdempotencyKey = idempotency_key.trim();
        // CRITICAL: Use parsedTenantId (integer) to match unique constraint
        // The unique constraint is (tenant_id, idempotency_key) for free users
        const whereClause = isFreePlan && parsedTenantId
          ? {
              tenant_id: parsedTenantId, // Must match unique constraint - use parsed integer, not orderTenantId
              idempotency_key: trimmedIdempotencyKey // Must match unique constraint
            }
          : {
              idempotency_key: trimmedIdempotencyKey, // Must match unique constraint
              online_store_id: online_store_id // Additional safety filter for enterprise
            };
        
        console.log('[Duplicate Check] Where clause:', JSON.stringify(whereClause));
        console.log('[Duplicate Check] isFreePlan:', isFreePlan, 'parsedTenantId:', parsedTenantId, 'orderTenantId:', orderTenantId);

        // For free users: don't include Store (they don't have physical stores)
        const existingOrder = await models.OnlineStoreOrder.findOne({
          where: whereClause,
          transaction, // Check within transaction to prevent race conditions
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
          // Duplicate found - rollback transaction IMMEDIATELY to prevent any insertion
          await transaction.rollback();
          console.log('[Duplicate Check] ✅ Duplicate order found with idempotency_key:', trimmedIdempotencyKey, 'tenant_id:', parsedTenantId);
          
          // Fetch complete order details with all includes (outside transaction)
          const productAttributesForOrder = isFreePlan 
            ? ['id', 'tenant_id', 'name', 'description', 'sku', 'barcode', 'price', 'stock', 'low_stock_threshold', 'category', 'image_url', 'expiry_date', 'is_active', 'created_at', 'updated_at']
            : undefined;
          
          const completeExistingOrder = await models.OnlineStoreOrder.findByPk(existingOrder.id, {
            include: [
              {
                model: models.OnlineStore,
                attributes: ['id', 'username', 'store_name']
              },
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
          
          // Return existing order - do NOT create a new one
          return res.status(200).json({
            success: true,
            message: 'Order already exists (duplicate request detected)',
            data: {
              order: completeExistingOrder,
              is_duplicate: true
            }
          });
        }
      } catch (checkError) {
        await transaction.rollback();
        throw checkError;
      }
    }

    try {
      // Verify online store exists and is published
      const onlineStore = await models.OnlineStore.findOne({
        where: {
          id: online_store_id,
          is_published: true
        },
        attributes: ['id', 'tenant_id', 'username', 'store_name', 'is_published'] // Include tenant_id
      });

      if (!onlineStore) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Online store not found or not published'
        });
      }

      // DETERMINE tenant_id for order creation:
      // - FREE users: Share one database, MUST have tenant_id (from online_store)
      // - ENTERPRISE users: Have separate database, tenant_id is NULL (column doesn't exist)
      let finalTenantId = null;
      
      if (isFreePlan) {
        // FREE USER: Must use tenant_id from online_store (required for shared database)
        // Verify online_store has tenant_id
        if (!onlineStore.tenant_id) {
          await transaction.rollback();
          return res.status(500).json({
            success: false,
            message: `Online store is missing tenant_id. This is required for free users. Please contact support.`
          });
        }
        
        // Verify tenant_id from online_store matches the tenant_id from request (security check)
        const onlineStoreTenantId = parseInt(onlineStore.tenant_id, 10);
        if (isNaN(onlineStoreTenantId) || onlineStoreTenantId <= 0) {
          await transaction.rollback();
          return res.status(500).json({
            success: false,
            message: `Invalid tenant_id in online store: ${onlineStore.tenant_id}. Please contact support.`
          });
        }
        
        if (onlineStoreTenantId !== parsedTenantId) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Tenant ID mismatch. Online store belongs to tenant ${onlineStoreTenantId}, but order request specified tenant ${parsedTenantId}`
          });
        }
        
        // Use tenant_id from online_store (always integer)
        finalTenantId = onlineStoreTenantId;
      } else {
        // ENTERPRISE USER: tenant_id is NULL (they have separate database)
        finalTenantId = null;
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
                        pvo.price_adjustment, pv.variation_name, pv.product_id
                 FROM product_variation_options pvo
                 INNER JOIN product_variations pv ON pvo.variation_id = pv.id
                 WHERE pvo.id = :optionId AND pv.product_id = :productId AND pvo.tenant_id = :tenantId`
              : `SELECT pvo.id, pvo.variation_id, pvo.option_value, pvo.option_display_name, 
                        pvo.price_adjustment, pv.variation_name, pv.product_id
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
              option_display_name: variationOptionRow.option_display_name,
              price_adjustment: parseFloat(variationOptionRow.price_adjustment || 0)
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

        // Calculate correct price: product base price + variation price adjustment (if applicable)
        const productBasePrice = parseFloat(product.price || 0);
        const variationPriceAdjustment = variationOption ? (variationOption.price_adjustment || 0) : 0;
        const calculatedPrice = productBasePrice + variationPriceAdjustment;
        const passedPrice = parseFloat(unit_price || 0);

        // Validate that the passed price matches the calculated price (with small tolerance for floating point)
        const priceTolerance = 0.01; // Allow 0.01 difference for floating point precision
        if (Math.abs(passedPrice - calculatedPrice) > priceTolerance) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Price mismatch for product ${product.name}${variationOptionValue ? ` (${variationOptionValue})` : ''}. Expected: ${calculatedPrice.toFixed(2)}, Provided: ${passedPrice.toFixed(2)}`
          });
        }

        // Use calculated price for security (don't trust client-provided price)
        const finalUnitPrice = calculatedPrice;

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

        const itemTotal = quantity * finalUnitPrice;
        subtotal += itemTotal;

        orderItems.push({
          product_id,
          product_name: product.name,
          product_sku: product.sku || null,
          quantity,
          unit_price: finalUnitPrice, // Use calculated price, not client-provided price
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
      // Ensure tenant_id is always set for free users (required for shared database)
      // finalTenantId is already set above from online_store.tenant_id for free users
      // For enterprise users: tenant_id is NULL (separate database)
      
      // Ensure idempotency_key is trimmed (empty strings become NULL)
      const finalIdempotencyKey = (idempotency_key && idempotency_key.trim() !== '') 
        ? idempotency_key.trim() 
        : null;
      
      console.log('[Order Creation] isFreePlan:', isFreePlan);
      console.log('[Order Creation] finalTenantId:', finalTenantId, '(should be integer for free users, null for enterprise)');
      console.log('[Order Creation] parsedTenantId from request:', parsedTenantId);
      console.log('[Order Creation] onlineStore.tenant_id:', onlineStore.tenant_id);
      console.log('[Order Creation] finalIdempotencyKey:', finalIdempotencyKey);
      
      // Create order with explicit tenant_id handling
      const orderData = {
        online_store_id,
        store_id: finalStoreId,
        order_number: orderNumber,
        idempotency_key: finalIdempotencyKey,
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
      };
      
      // Only add tenant_id if it's a free user (enterprise users don't have this column)
      // CRITICAL: Use set() method to ensure Sequelize recognizes tenant_id
      if (isFreePlan && finalTenantId) {
        orderData.tenant_id = finalTenantId;
        // Explicitly ensure it's an integer (not string or undefined)
        if (typeof orderData.tenant_id !== 'number' || orderData.tenant_id <= 0) {
          await transaction.rollback();
          return res.status(500).json({
            success: false,
            message: `Invalid tenant_id in orderData: ${orderData.tenant_id} (${typeof orderData.tenant_id}). Must be a positive integer.`
          });
        }
      }
      
      // Create order - use set() after creation to ensure tenant_id is saved if Sequelize didn't pick it up
      const order = await models.OnlineStoreOrder.create(orderData, { transaction });
      
      // CRITICAL FIX: If tenant_id wasn't saved (check dataValues), explicitly update it
      if (isFreePlan && finalTenantId) {
        if (!order.dataValues.tenant_id || order.dataValues.tenant_id === 0) {
          // Tenant_id wasn't saved - explicitly update it using raw query
          await sequelize.query(
            'UPDATE online_store_orders SET tenant_id = :tenantId WHERE id = :orderId',
            {
              replacements: { tenantId: finalTenantId, orderId: order.id },
              transaction
            }
          );
          // Reload order after update
          await order.reload({ transaction });
        }
      }

      // CRITICAL: Verify tenant_id was saved correctly (for free users only)
      if (isFreePlan && finalTenantId) {
        // Build debug info to return in response if there's an error
        const debugInfo = {
          expected: finalTenantId,
          expectedType: typeof finalTenantId,
          isFreePlan,
          onlineStoreTenantId: onlineStore.tenant_id,
          onlineStoreTenantIdType: typeof onlineStore.tenant_id,
          orderDataTenantId: orderData.tenant_id,
          orderDataTenantIdType: typeof orderData.tenant_id,
          orderDataKeys: Object.keys(orderData),
          orderId: order.id,
          orderTenantId: order.tenant_id,
          orderTenantIdType: typeof order.tenant_id,
          orderDataValuesTenantId: order.dataValues?.tenant_id,
          orderDataValuesKeys: Object.keys(order.dataValues || {})
        };
        
        // First check the order object immediately after creation
        const orderTenantId = order.tenant_id || order.dataValues?.tenant_id;
        if (orderTenantId && parseInt(orderTenantId, 10) === finalTenantId) {
          // tenant_id is correct in the order object, verification passed
        } else {
          // Reload order from database to verify tenant_id was persisted correctly
          // Use raw query to ensure we get the actual database value
          try {
            const savedOrderRows = await sequelize.query(
              'SELECT id, tenant_id, idempotency_key FROM online_store_orders WHERE id = :orderId',
              {
                replacements: { orderId: order.id },
                type: sequelize.QueryTypes.SELECT,
                transaction
              }
            );
            
            const savedOrder = savedOrderRows && savedOrderRows.length > 0 ? savedOrderRows[0] : null;
            
            if (!savedOrder) {
              await transaction.rollback();
              return res.status(500).json({
                success: false,
                message: 'Failed to retrieve created order from database. Order creation aborted.',
                debug: {
                  ...debugInfo,
                  rawQueryResult: savedOrderRows,
                  savedOrderFound: false
                }
              });
            }
            
            // Add raw query results to debug info
            debugInfo.rawQueryTenantId = savedOrder.tenant_id;
            debugInfo.rawQueryTenantIdType = typeof savedOrder.tenant_id;
            debugInfo.rawQueryResult = savedOrder;
            
            // Verify tenant_id matches (both must be integers)
            const savedTenantId = savedOrder.tenant_id ? parseInt(savedOrder.tenant_id, 10) : null;
            if (savedTenantId !== finalTenantId) {
              await transaction.rollback();
              return res.status(500).json({
                success: false,
                message: `Failed to save tenant_id. Expected: ${finalTenantId} (integer), Got: ${savedOrder.tenant_id} (${typeof savedOrder.tenant_id}). Order creation aborted.`,
                debug: debugInfo
              });
            }
          } catch (queryError) {
            await transaction.rollback();
            return res.status(500).json({
              success: false,
              message: 'Error verifying tenant_id in database. Order creation aborted.',
              error: queryError.message,
              debug: {
                ...debugInfo,
                queryError: queryError.toString()
              }
            });
          }
        }
      }

      // Create order items
      for (const item of orderItems) {
        await models.OnlineStoreOrderItem.create({
          tenant_id: orderTenantId, // Use parsed tenant_id for free users
          order_id: order.id,
          ...item
        }, { transaction });
      }

      // NOTE: Stock deduction removed - stock should only be deducted AFTER payment is confirmed
      // Stock will be deducted in the payment webhook handler or payment verification function
      // This prevents stock from being reserved for unpaid orders

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
        if (uniqueError && idempotency_key && idempotency_key.trim() !== '') {
          // Duplicate idempotency key - fetch and return existing order
          const trimmedIdempotencyKey = idempotency_key.trim();
          // CRITICAL: Use parsedTenantId (integer) to match unique constraint
          const whereClause = isFreePlan && parsedTenantId
            ? {
                tenant_id: parsedTenantId, // Match unique constraint - use parsed integer
                idempotency_key: trimmedIdempotencyKey // Match unique constraint
              }
            : {
                idempotency_key: trimmedIdempotencyKey, // Match unique constraint
                online_store_id: online_store_id // Additional safety filter
              };
          
          console.log('[Duplicate Error Handler] Where clause:', JSON.stringify(whereClause));
          console.log('[Duplicate Error Handler] parsedTenantId:', parsedTenantId);

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

    // Determine if this is a free plan user
    const isFreePlan = tenant.subscription_plan === 'free';

    // Parse tenant_id as integer (JSON body may send it as string)
    const parsedTenantId = parseInt(tenant_id, 10);
    if (isNaN(parsedTenantId) || parsedTenantId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenant_id provided'
      });
    }

    // Get default payment gateway
    // For free users, must filter by tenant_id since they share a database
    const gatewayWhere = {
      is_active: true,
      is_default: true
    };
    
    if (isFreePlan) {
      gatewayWhere.tenant_id = parsedTenantId;
    }
    
    const gateway = await models.PaymentGateway.findOne({
      where: gatewayWhere
    });

    if (!gateway) {
      return res.status(400).json({
        success: false,
        message: 'No active payment gateway configured. Please contact the store owner.'
      });
    }

    // Calculate platform fee (only for free users, enterprise users pay 0%)
    // Transaction fee is capped at 500 NGN maximum
    const transactionFeePercentage = tenant.subscription_plan === 'free' 
      ? parseFloat(tenant.transaction_fee_percentage || 3.00)
      : 0.00;

    // Calculate fee: (amount * percentage) / 100, then cap at 500 NGN
    const calculatedFee = (parseFloat(amount) * transactionFeePercentage) / 100;
    const platformFee = Math.min(calculatedFee, 500.00); // Cap at 500 NGN maximum
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
    const transactionTenantId = isFreePlan ? parsedTenantId : null;

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
      tenant_id: parsedTenantId,
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

