const axios = require('axios');
const crypto = require('crypto');
const { decryptSecretKey } = require('./paymentGatewayController');
const { getTenantById } = require('../config/tenant');
const { getTenantConnection } = require('../config/database');
const initModels = require('../models');

/**
 * Initialize payment (create payment link/transaction)
 */
async function initializePayment(req, res) {
  try {
    const {
      order_id,
      invoice_id,
      amount,
      email,
      name,
      currency = 'NGN',
      callback_url,
      metadata
    } = req.body;

    if (!amount || !email) {
      return res.status(400).json({
        success: false,
        message: 'amount and email are required'
      });
    }

    // Get default payment gateway
    const gateway = await req.db.models.PaymentGateway.findOne({
      where: {
        tenant_id: req.user.tenantId,
        is_active: true,
        is_default: true
      }
    });

    if (!gateway) {
      return res.status(400).json({
        success: false,
        message: 'No active payment gateway configured. Please configure a payment gateway first.'
      });
    }

    // Get tenant to check subscription plan and transaction fee
    const tenant = await getTenantById(req.user.tenantId);
    const transactionFeePercentage = tenant.subscription_plan === 'free' 
      ? parseFloat(tenant.transaction_fee_percentage || 3.00)
      : 0.00;

    // Calculate platform fee with 500 NGN cap
    const calculatedFee = (parseFloat(amount) * transactionFeePercentage) / 100;
    const platformFee = Math.min(calculatedFee, 500.00); // Cap at 500 NGN maximum
    const merchantAmount = parseFloat(amount) - platformFee;

    // Get online store if order_id is provided (for split payments)
    let onlineStore = null;
    let splitOptions = null;
    if (order_id) {
      const order = await req.db.models.OnlineStoreOrder.findByPk(order_id);
      if (order && order.online_store_id) {
        onlineStore = await req.db.models.OnlineStore.findByPk(order.online_store_id);
        
        // If online store has Paystack subaccount configured, use split payment
        if (onlineStore && onlineStore.paystack_subaccount_code && platformFee > 0) {
          // Use split payment with capped fee
          // Paystack split: charge_amount is in kobo (smallest currency unit)
          const chargeAmountInKobo = Math.round(platformFee * 100); // Convert to kobo
          
          splitOptions = {
            subaccount: onlineStore.paystack_subaccount_code,
            // Use charge_amount (fixed amount) instead of percentage for more control
            charge_amount: chargeAmountInKobo,
            // Note: Paystack will automatically split:
            // - charge_amount goes to main account (platform)
            // - Remaining amount goes to subaccount (merchant)
          };
          
          console.log(`Split payment configured: Platform fee: ₦${platformFee} (${chargeAmountInKobo} kobo), Merchant: ₦${merchantAmount}`);
        }
      }
    }

    // Generate transaction reference
    const transactionReference = `TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    // Create payment transaction record
    const paymentTransaction = await req.db.models.PaymentTransaction.create({
      tenant_id: req.user.tenantId,
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
      tenant_id: req.user.tenantId,
      transaction_id: paymentTransaction.id
    };
    
    // Add online_store_id to metadata if available
    if (onlineStore) {
      paymentMetadata.online_store_id = onlineStore.id;
    }

    if (gateway.gateway_name === 'paystack') {
      paymentData = await initializePaystackPayment({
        amount: parseFloat(amount) * 100, // Paystack uses kobo (smallest currency unit)
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
        meta: {
          ...metadata,
          tenant_id: req.user.tenantId,
          transaction_id: paymentTransaction.id
        }
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
    console.error('Error initializing payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initialize payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Verify payment (webhook or callback)
 * Public endpoint - requires tenant_id query parameter
 */
async function verifyPayment(req, res) {
  try {
    const { reference } = req.query; // For Paystack
    const { tx_ref } = req.query; // For Flutterwave
    const { tenant_id } = req.query; // Required for public endpoint

    const transactionReference = reference || tx_ref;

    if (!transactionReference) {
      return res.status(400).json({
        success: false,
        message: 'Transaction reference is required'
      });
    }

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required'
      });
    }

    // Parse tenant_id as integer (query params are strings)
    const parsedTenantId = parseInt(tenant_id, 10);
    if (isNaN(parsedTenantId) || parsedTenantId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenant_id provided'
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(parsedTenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(parsedTenantId, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Find transaction
    // For free users, must filter by tenant_id since they share a database
    const isFreePlan = tenant.subscription_plan === 'free';
    
    const transactionWhere = { transaction_reference: transactionReference };
    if (isFreePlan) {
      transactionWhere.tenant_id = parsedTenantId;
    }

    const transaction = await models.PaymentTransaction.findOne({
      where: transactionWhere
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Check if transaction has already been processed successfully
    // Prevent duplicate processing and duplicate email sends
    if (transaction.status === 'success') {
      console.log('Transaction already verified:', transaction.transaction_reference);
      return res.json({
        success: true,
        message: 'Transaction already verified',
        data: {
          transaction: {
            id: transaction.id,
            reference: transaction.transaction_reference,
            status: transaction.status,
            amount: transaction.amount,
            platform_fee: transaction.platform_fee,
            merchant_amount: transaction.merchant_amount,
            paid_at: transaction.paid_at
          },
          already_verified: true
        }
      });
    }

    // Fetch PaymentGateway separately (no association exists)
    // Use tenant_id from transaction if available, otherwise use parsed tenant_id from query
    const gatewayTenantId = transaction.tenant_id || parsedTenantId;
    
    // Build where clause for PaymentGateway (for free users, filter by tenant_id)
    const gatewayWhere = {
      gateway_name: transaction.gateway_name,
      is_active: true
    };
    
    if (isFreePlan) {
      gatewayWhere.tenant_id = gatewayTenantId;
    }

    const gateway = await models.PaymentGateway.findOne({
      where: gatewayWhere,
      attributes: ['id', 'gateway_name', 'secret_key', 'test_mode']
    });

    if (!gateway) {
      console.error('PaymentGateway not found for transaction:', transaction.id, 'gateway_name:', transaction.gateway_name);
      return res.status(500).json({
        success: false,
        message: 'Payment gateway not found for this transaction'
      });
    }

    const secretKey = decryptSecretKey(gateway.secret_key);
    let verificationResult;

    // Verify with gateway
    if (gateway.gateway_name === 'paystack') {
      verificationResult = await verifyPaystackPayment(transactionReference, secretKey);
    } else if (gateway.gateway_name === 'flutterwave') {
      verificationResult = await verifyFlutterwavePayment(transactionReference, secretKey);
    } else {
      return res.status(400).json({
        success: false,
        message: 'Unsupported payment gateway'
      });
    }

    // Update transaction status
    // Only update if status is different (prevents unnecessary database writes)
    const newStatus = verificationResult.status === 'success' ? 'success' : 'failed';
    
    // Use transaction to prevent race conditions
    const dbTransaction = await sequelize.transaction();
    
    try {
      // Reload transaction within transaction to get latest status (prevents race conditions)
      // Use row locking to prevent concurrent updates
      const { Sequelize } = require('sequelize');
      const currentTransaction = await models.PaymentTransaction.findOne({
        where: transactionWhere,
        lock: true, // FOR UPDATE lock
        transaction: dbTransaction
      });

      if (!currentTransaction) {
        await dbTransaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Transaction not found'
        });
      }

      // Check if transaction has already been processed successfully
      if (currentTransaction.status === 'success') {
        await dbTransaction.rollback();
        console.log('Transaction already verified:', currentTransaction.transaction_reference);
        return res.json({
          success: true,
          message: 'Transaction already verified',
          data: {
            transaction: {
              id: currentTransaction.id,
              reference: currentTransaction.transaction_reference,
              status: currentTransaction.status,
              amount: currentTransaction.amount,
              platform_fee: currentTransaction.platform_fee,
              merchant_amount: currentTransaction.merchant_amount,
              paid_at: currentTransaction.paid_at
            },
            already_verified: true
          }
        });
      }

      await currentTransaction.update({
        status: newStatus,
        gateway_response: verificationResult,
        paid_at: newStatus === 'success' ? new Date() : null,
        failure_reason: newStatus === 'failed' ? verificationResult.message : null
      }, { transaction: dbTransaction });

      let emailSent = false;

      // Update order status if payment successful (only if not already updated)
      if (newStatus === 'success' && currentTransaction.order_id) {
        // Build where clause for order update (for free users, filter by tenant_id)
        // Only update if order is not already paid (prevents duplicate updates)
        const orderWhere = { id: currentTransaction.order_id };
        if (isFreePlan && currentTransaction.tenant_id) {
          orderWhere.tenant_id = currentTransaction.tenant_id;
        }
        // Add condition to only update if not already paid
        const { Sequelize } = require('sequelize');
        orderWhere.payment_status = { [Sequelize.Op.ne]: 'paid' };
        
        const orderUpdateResult = await models.OnlineStoreOrder.update(
          { payment_status: 'paid', status: 'confirmed' },
          { where: orderWhere, transaction: dbTransaction }
        );

        // Send order confirmation email after successful payment
        // Only send if order was actually updated (orderUpdateResult[0] > 0)
        if (orderUpdateResult[0] > 0) {
          try {
            // Build where clause for order fetch (for free users, filter by tenant_id)
            const orderFindWhere = { id: currentTransaction.order_id };
            if (isFreePlan && currentTransaction.tenant_id) {
              orderFindWhere.tenant_id = currentTransaction.tenant_id;
            }
            
            const order = await models.OnlineStoreOrder.findOne({
              where: orderFindWhere,
              include: [
                {
                  model: models.OnlineStoreOrderItem
                }
              ],
              transaction: dbTransaction
            });

            if (order && currentTransaction.customer_email) {
              // Use tenant_id from transaction or from query parameter
              const transactionTenantId = currentTransaction.tenant_id || parsedTenantId;
              const tenantForEmail = await getTenantById(transactionTenantId);
              if (tenantForEmail) {
                const { sendOrderConfirmationEmail } = require('../services/emailService');
                const orderJson = order.toJSON();
                // Access items from JSON (Sequelize pluralizes association names in JSON)
                const items = orderJson.OnlineStoreOrderItems || order.OnlineStoreOrderItems || [];
                
                // Commit transaction before sending email (email service doesn't need DB transaction)
                await dbTransaction.commit();
                emailSent = true;
                
                // Send email outside transaction
                await sendOrderConfirmationEmail({
                  tenant: tenantForEmail,
                  order: orderJson,
                  customerEmail: currentTransaction.customer_email,
                  customerName: currentTransaction.customer_name || order.customer_name || 'Customer',
                  items: items
                });
              }
            }
          } catch (emailError) {
            console.error('Error sending order confirmation email:', emailError);
            // Don't fail payment verification if email fails
          }
        }
      }

      // Update invoice status if payment successful (only if not already paid)
      if (newStatus === 'success' && currentTransaction.invoice_id && !emailSent) {
        // Build where clause for invoice update (for free users, filter by tenant_id)
        // Only update if invoice is not already paid
        const invoiceWhere = { id: currentTransaction.invoice_id };
        if (isFreePlan && currentTransaction.tenant_id) {
          invoiceWhere.tenant_id = currentTransaction.tenant_id;
        }
        // Add condition to only update if not already paid
        const { Sequelize } = require('sequelize');
        invoiceWhere.status = { [Sequelize.Op.ne]: 'paid' };
        
        await models.Invoice.update(
          { status: 'paid', payment_date: new Date() },
          { where: invoiceWhere, transaction: dbTransaction }
        );
      }
      
      // Commit transaction if not already committed (email was sent)
      if (!emailSent) {
        await dbTransaction.commit();
      }
      
      // Return success response
      return res.json({
        success: newStatus === 'success',
        message: verificationResult.message,
        data: {
          transaction: {
            id: currentTransaction.id,
            reference: currentTransaction.transaction_reference,
            status: newStatus,
            amount: currentTransaction.amount,
            platform_fee: currentTransaction.platform_fee,
            merchant_amount: currentTransaction.merchant_amount
          }
        }
      });
    } catch (dbError) {
      if (!dbTransaction.finished) {
        await dbTransaction.rollback();
      }
      throw dbError;
    }
  } catch (error) {
    console.error('Error verifying payment:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      errorDetails: process.env.NODE_ENV === 'development' ? {
        stack: error.stack,
        name: error.name
      } : undefined
    });
  }
}

/**
 * Initialize Paystack payment with split support
 */
async function initializePaystackPayment(paymentData, secretKey, testMode, splitOptions = null) {
  const baseUrl = testMode 
    ? 'https://api.paystack.co'
    : 'https://api.paystack.co';

  try {
    // Prepare payment payload
    const payload = {
      ...paymentData
    };

    // Add split configuration if provided
    if (splitOptions && splitOptions.subaccount && splitOptions.split_code) {
      // Use split code (preferred method)
      payload.split_code = splitOptions.split_code;
    } else if (splitOptions && splitOptions.subaccount) {
      // Use subaccount directly with charge_amount (fixed amount in kobo)
      payload.subaccount = splitOptions.subaccount;
      if (splitOptions.charge_amount) {
        // Use charge_amount (fixed amount) - this is the capped fee
        payload.charge_amount = splitOptions.charge_amount;
      } else if (splitOptions.charge_percentage) {
        // Fallback to percentage if amount not provided
        payload.charge_percentage = splitOptions.charge_percentage;
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
 * Verify Paystack payment
 */
async function verifyPaystackPayment(reference, secretKey) {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`
        }
      }
    );

    const data = response.data.data;
    return {
      status: data.status === 'success' ? 'success' : 'failed',
      message: data.gateway_response || data.message,
      gateway_transaction_id: data.reference,
      amount: data.amount / 100, // Convert from kobo
      paid_at: data.paid_at
    };
  } catch (error) {
    console.error('Paystack verification error:', error.response?.data || error.message);
    return {
      status: 'failed',
      message: error.response?.data?.message || 'Payment verification failed'
    };
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
      gateway_transaction_id: response.data.data.tx_ref,
      status: 'pending'
    };
  } catch (error) {
    console.error('Flutterwave initialization error:', error.response?.data || error.message);
    throw new Error('Failed to initialize Flutterwave payment');
  }
}

/**
 * Verify Flutterwave payment
 */
async function verifyFlutterwavePayment(txRef, secretKey) {
  try {
    const response = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${txRef}/verify`,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`
        }
      }
    );

    const data = response.data.data;
    return {
      status: data.status === 'successful' ? 'success' : 'failed',
      message: data.processor_response || data.status,
      gateway_transaction_id: data.tx_ref,
      amount: data.amount,
      paid_at: data.created_at
    };
  } catch (error) {
    console.error('Flutterwave verification error:', error.response?.data || error.message);
    return {
      status: 'failed',
      message: error.response?.data?.message || 'Payment verification failed'
    };
  }
}

/**
 * Handle payment webhook (Paystack)
 * POST /api/v1/payments/webhook?online_store_id=123
 * 
 * This webhook handles cases where:
 * 1. Transaction exists in database (normal flow)
 * 2. Transaction doesn't exist (network failure during verifyPayment) - creates it from webhook data
 */
async function handlePaymentWebhook(req, res) {
  try {
    const { online_store_id } = req.query;
    
    // Get webhook payload
    const hash = req.headers['x-paystack-signature'];
    const body = req.body;

    if (!hash) {
      console.error('Missing Paystack signature');
      return res.status(400).json({ error: 'Missing signature' });
    }

    // Verify webhook signature
    const secretKey = process.env.PAYSTACK_SECRET_KEY || '';
    if (!secretKey) {
      console.error('Paystack secret key not configured');
      return res.status(500).json({ error: 'Webhook configuration error' });
    }

    // Verify signature
    const crypto = require('crypto');
    const expectedHash = crypto
      .createHmac('sha512', secretKey)
      .update(JSON.stringify(body))
      .digest('hex');

    if (hash !== expectedHash) {
      console.error('Invalid webhook signature');
      return res.status(403).json({ error: 'Invalid signature' });
    }

    // Process webhook event
    const event = body.event;
    const data = body.data;

    console.log(`Paystack webhook received: ${event} for online_store_id: ${online_store_id || 'N/A'}`);

    // Extract tenant_id from metadata (required to connect to correct database)
    const metadata = data.metadata || {};
    const tenantId = metadata.tenant_id;
    
    if (!tenantId) {
      console.error('Missing tenant_id in webhook metadata');
      // Still return 200 to acknowledge receipt, but log error
      return res.status(200).json({ 
        received: true, 
        warning: 'Missing tenant_id in metadata - cannot process webhook' 
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      console.error(`Tenant not found: ${tenantId}`);
      return res.status(200).json({ 
        received: true, 
        warning: `Tenant ${tenantId} not found` 
      });
    }

    const sequelize = await getTenantConnection(tenantId, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);
    const isFreePlan = tenant.subscription_plan === 'free';
    const parsedTenantId = parseInt(tenantId, 10);

    if (event === 'charge.success') {
      // Payment successful
      const reference = data.reference;
      const amount = data.amount / 100; // Convert from kobo
      const customerEmail = data.customer?.email;
      const customerName = data.customer ? `${data.customer.first_name || ''} ${data.customer.last_name || ''}`.trim() : null;

      // Find transaction by reference (with tenant_id filter for free users)
      const transactionWhere = { transaction_reference: reference };
      if (isFreePlan) {
        transactionWhere.tenant_id = parsedTenantId;
      }

      let transaction = await models.PaymentTransaction.findOne({
        where: transactionWhere
      });

      // If transaction doesn't exist, create it from webhook data
      // This handles the case where verifyPayment failed due to network issues
      if (!transaction) {
        console.warn(`Transaction not found for reference: ${reference}. Creating from webhook data...`);
        
        // Try to get order_id and invoice_id from metadata
        const orderId = metadata.order_id || metadata.transaction_id || null;
        const invoiceId = metadata.invoice_id || null;
        
        // Get gateway name from metadata or default to paystack
        const gatewayName = metadata.gateway_name || 'paystack';
        
        // Calculate platform fee if available in metadata, otherwise estimate
        const platformFee = metadata.platform_fee || 0;
        const merchantAmount = amount - platformFee;
        
        try {
          // Create transaction from webhook data
          transaction = await models.PaymentTransaction.create({
            tenant_id: isFreePlan ? parsedTenantId : null,
            order_id: orderId,
            invoice_id: invoiceId,
            transaction_reference: reference,
            gateway_name: gatewayName,
            gateway_transaction_id: reference,
            amount: amount,
            currency: data.currency || 'NGN',
            platform_fee: platformFee,
            merchant_amount: merchantAmount,
            customer_email: customerEmail,
            customer_name: customerName,
            status: 'success',
            gateway_response: data,
            paid_at: new Date(data.paid_at || new Date()),
            failure_reason: null
          });
          
          console.log(`✅ Created missing transaction from webhook: ${transaction.id}`);
        } catch (createError) {
          console.error('Error creating transaction from webhook:', createError);
          // Continue processing - might be duplicate reference or other issue
          // Try to find it again in case it was created concurrently
          transaction = await models.PaymentTransaction.findOne({
            where: transactionWhere
          });
          
          if (!transaction) {
            console.error('Could not create or find transaction. Webhook data may be incomplete.');
            return res.status(200).json({ 
              received: true, 
              warning: 'Transaction not found and could not be created' 
            });
          }
        }
      }

      // Update transaction status (only if not already success to prevent duplicate processing)
      if (transaction.status !== 'success') {
        await transaction.update({
          status: 'success',
          gateway_response: data,
          paid_at: new Date(data.paid_at || new Date()),
          failure_reason: null
        });
      }

      // Update order status if payment successful (only if not already paid)
      if (transaction.order_id) {
        const orderWhere = { id: transaction.order_id };
        if (isFreePlan && transaction.tenant_id) {
          orderWhere.tenant_id = transaction.tenant_id;
        }
        // Only update if not already paid
        const { Sequelize } = require('sequelize');
        orderWhere.payment_status = { [Sequelize.Op.ne]: 'paid' };
        
        const orderUpdateResult = await models.OnlineStoreOrder.update(
          {
            payment_status: 'paid',
            status: 'confirmed',
            paid_at: new Date()
          },
          { where: orderWhere }
        );

        // Only fetch and send email if order was actually updated
        if (orderUpdateResult[0] > 0) {
          const orderFindWhere = { id: transaction.order_id };
          if (isFreePlan && transaction.tenant_id) {
            orderFindWhere.tenant_id = transaction.tenant_id;
          }
          
          const order = await models.OnlineStoreOrder.findOne({
            where: orderFindWhere,
            include: [
              {
                model: models.OnlineStoreOrderItem
              }
            ]
          });

          if (order) {
            // Send order confirmation email after successful payment
            try {
              if (tenant && (transaction.customer_email || order.customer_email)) {
                const { sendOrderConfirmationEmail } = require('../services/emailService');
                const orderJson = order.toJSON();
                await sendOrderConfirmationEmail({
                  tenant,
                  order: orderJson,
                  customerEmail: transaction.customer_email || order.customer_email,
                  customerName: transaction.customer_name || order.customer_name || 'Customer',
                  items: orderJson.OnlineStoreOrderItems || []
                });
              }
            } catch (emailError) {
              console.error('Error sending order confirmation email:', emailError);
              // Don't fail webhook processing if email fails
            }
          }
        }
      }

      // Update invoice status if payment successful (only if not already paid)
      if (transaction.invoice_id) {
        const invoiceWhere = { id: transaction.invoice_id };
        if (isFreePlan && transaction.tenant_id) {
          invoiceWhere.tenant_id = transaction.tenant_id;
        }
        // Only update if not already paid
        const { Sequelize } = require('sequelize');
        invoiceWhere.status = { [Sequelize.Op.ne]: 'paid' };
        
        await models.Invoice.update(
          { 
            status: 'paid', 
            payment_date: new Date(),
            payment_method: data.authorization?.channel || 'card'
          },
          { where: invoiceWhere }
        );
      }

      console.log(`✅ Payment webhook processed: Transaction ${transaction.id} marked as success`);
    } else if (event === 'charge.failed') {
      // Payment failed
      const reference = data.reference;
      const transactionWhere = { transaction_reference: reference };
      if (isFreePlan) {
        transactionWhere.tenant_id = parsedTenantId;
      }
      
      let transaction = await models.PaymentTransaction.findOne({
        where: transactionWhere
      });

      // If transaction doesn't exist, create it from webhook data
      if (!transaction) {
        console.warn(`Transaction not found for failed reference: ${reference}. Creating from webhook data...`);
        
        const orderId = metadata.order_id || metadata.transaction_id || null;
        const invoiceId = metadata.invoice_id || null;
        const gatewayName = metadata.gateway_name || 'paystack';
        const platformFee = metadata.platform_fee || 0;
        const merchantAmount = (data.amount / 100) - platformFee;
        
        try {
          transaction = await models.PaymentTransaction.create({
            tenant_id: isFreePlan ? parsedTenantId : null,
            order_id: orderId,
            invoice_id: invoiceId,
            transaction_reference: reference,
            gateway_name: gatewayName,
            gateway_transaction_id: reference,
            amount: data.amount / 100,
            currency: data.currency || 'NGN',
            platform_fee: platformFee,
            merchant_amount: merchantAmount,
            customer_email: data.customer?.email,
            customer_name: data.customer ? `${data.customer.first_name || ''} ${data.customer.last_name || ''}`.trim() : null,
            status: 'failed',
            gateway_response: data,
            failure_reason: data.gateway_response || 'Payment failed',
            paid_at: null
          });
          
          console.log(`✅ Created missing failed transaction from webhook: ${transaction.id}`);
        } catch (createError) {
          console.error('Error creating failed transaction from webhook:', createError);
          // Try to find it again
          transaction = await models.PaymentTransaction.findOne({
            where: transactionWhere
          });
        }
      }

      if (transaction && transaction.status !== 'failed') {
        await transaction.update({
          status: 'failed',
          gateway_response: data,
          failure_reason: data.gateway_response || 'Payment failed'
        });

        console.log(`✅ Payment webhook processed: Transaction ${transaction.id} marked as failed`);
      }
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

/**
 * Get webhook URL for online store
 * GET /api/v1/payments/webhook-url/:online_store_id
 * Returns the webhook URL that users should add to their Paystack dashboard
 */
async function getWebhookUrl(req, res) {
  try {
    const { online_store_id } = req.params;

    if (!req.user || !req.user.tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(req.user.tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(req.user.tenantId, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    // Determine if this is a free plan user
    const isFreePlan = tenant.subscription_plan === 'free';
    const parsedTenantId = parseInt(req.user.tenantId, 10);

    // Verify online store exists and belongs to user
    const onlineStoreWhere = {
      id: online_store_id
    };
    
    if (isFreePlan) {
      onlineStoreWhere.tenant_id = parsedTenantId;
    }

    const onlineStore = await models.OnlineStore.findOne({
      where: onlineStoreWhere
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // Build webhook URL with online_store_id parameter
    // Use backend.mycroshop.com as base URL
    const baseUrl = process.env.BASE_URL || process.env.API_URL || 'https://backend.mycroshop.com';
    const webhookUrl = `${baseUrl}/api/v1/payments/webhook?online_store_id=${online_store_id}`;

    res.json({
      success: true,
      data: {
        webhook_url: webhookUrl,
        online_store_id: parseInt(online_store_id),
        instructions: [
          '1. Copy the webhook URL above',
          '2. Go to your Paystack Dashboard → Settings → API Keys & Webhooks',
          '3. Click "Add Webhook"',
          '4. Paste the webhook URL',
          '5. Select events: charge.success and charge.failed',
          '6. Save the webhook'
        ]
      }
    });
  } catch (error) {
    console.error('Error getting webhook URL:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get webhook URL',
      error: error.message
    });
  }
}

module.exports = {
  initializePayment,
  verifyPayment,
  handlePaymentWebhook,
  getWebhookUrl
};

