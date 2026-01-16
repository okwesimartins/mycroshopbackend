const axios = require('axios');
const crypto = require('crypto');
const { decryptSecretKey } = require('./paymentGatewayController');
const { getTenantById } = require('../config/tenant');

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
    const platformFee = Math.min(calculatedFee, 500); // Cap at 500 NGN
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
 */
async function verifyPayment(req, res) {
  try {
    const { reference } = req.query; // For Paystack
    const { tx_ref } = req.query; // For Flutterwave

    const transactionReference = reference || tx_ref;

    if (!transactionReference) {
      return res.status(400).json({
        success: false,
        message: 'Transaction reference is required'
      });
    }

    // Find transaction
    const transaction = await req.db.models.PaymentTransaction.findOne({
      where: { transaction_reference: transactionReference },
      include: [
        {
          model: req.db.models.PaymentGateway,
          attributes: ['gateway_name', 'secret_key', 'test_mode']
        }
      ]
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    const secretKey = decryptSecretKey(transaction.PaymentGateway.secret_key);
    let verificationResult;

    // Verify with gateway
    if (transaction.gateway_name === 'paystack') {
      verificationResult = await verifyPaystackPayment(transactionReference, secretKey);
    } else if (transaction.gateway_name === 'flutterwave') {
      verificationResult = await verifyFlutterwavePayment(transactionReference, secretKey);
    } else {
      return res.status(400).json({
        success: false,
        message: 'Unsupported payment gateway'
      });
    }

    // Update transaction status
    const newStatus = verificationResult.status === 'success' ? 'success' : 'failed';
    await transaction.update({
      status: newStatus,
      gateway_response: verificationResult,
      paid_at: newStatus === 'success' ? new Date() : null,
      failure_reason: newStatus === 'failed' ? verificationResult.message : null
    });

    // Update order status if payment successful
    if (newStatus === 'success' && transaction.order_id) {
      await req.db.models.OnlineStoreOrder.update(
        { payment_status: 'paid', status: 'confirmed' },
        { where: { id: transaction.order_id } }
      );

      // Send order confirmation email after successful payment
      try {
        const order = await req.db.models.OnlineStoreOrder.findByPk(transaction.order_id, {
          include: [
            {
              model: req.db.models.OnlineStoreOrderItem
            }
          ]
        });

        if (order && transaction.customer_email) {
          const tenant = await getTenantById(req.user.tenantId);
          if (tenant) {
            const { sendOrderConfirmationEmail } = require('../services/emailService');
            await sendOrderConfirmationEmail({
              tenant,
              order: order.toJSON(),
              customerEmail: transaction.customer_email,
              customerName: transaction.customer_name || order.customer_name || 'Customer',
              items: order.OnlineStoreOrderItems || []
            });
          }
        }
      } catch (emailError) {
        console.error('Error sending order confirmation email:', emailError);
        // Don't fail payment verification if email fails
      }
    }

    // Update invoice status if payment successful
    if (newStatus === 'success' && transaction.invoice_id) {
      await req.db.models.Invoice.update(
        { status: 'paid', payment_date: new Date() },
        { where: { id: transaction.invoice_id } }
      );
    }

    res.json({
      success: newStatus === 'success',
      message: verificationResult.message,
      data: {
        transaction: {
          id: transaction.id,
          reference: transaction.transaction_reference,
          status: newStatus,
          amount: transaction.amount,
          platform_fee: transaction.platform_fee,
          merchant_amount: transaction.merchant_amount
        }
      }
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment'
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

    if (event === 'charge.success') {
      // Payment successful
      const reference = data.reference;
      const amount = data.amount / 100; // Convert from kobo
      const customerEmail = data.customer?.email;
      const metadata = data.metadata || {};

      // Find transaction by reference
      const transaction = await req.db.models.PaymentTransaction.findOne({
        where: { transaction_reference: reference }
      });

      if (transaction) {
    // Update transaction status
        await transaction.update({
          status: 'success',
          gateway_response: data,
          paid_at: new Date(data.paid_at || new Date()),
          failure_reason: null
        });

        // Update order status if payment successful
        if (transaction.order_id) {
          const order = await req.db.models.OnlineStoreOrder.findByPk(transaction.order_id, {
            include: [
              {
                model: req.db.models.OnlineStoreOrderItem
              }
            ]
          });

          if (order) {
            await order.update({
              payment_status: 'paid',
              status: 'confirmed',
              paid_at: new Date()
            });

            // Send order confirmation email after successful payment
            try {
              const tenantId = transaction.tenant_id;
              if (tenantId) {
                const tenant = await getTenantById(tenantId);
                if (tenant && (transaction.customer_email || order.customer_email)) {
                  const { sendOrderConfirmationEmail } = require('../services/emailService');
                  await sendOrderConfirmationEmail({
                    tenant,
                    order: order.toJSON(),
                    customerEmail: transaction.customer_email || order.customer_email,
                    customerName: transaction.customer_name || order.customer_name || 'Customer',
                    items: order.OnlineStoreOrderItems || []
                  });
                }
              }
            } catch (emailError) {
              console.error('Error sending order confirmation email:', emailError);
              // Don't fail webhook processing if email fails
            }
          }
        }

        // Update invoice status if payment successful
        if (transaction.invoice_id) {
          await req.db.models.Invoice.update(
            { 
              status: 'paid', 
              payment_date: new Date(),
              payment_method: data.authorization?.channel || 'card'
            },
            { where: { id: transaction.invoice_id } }
          );
        }

        console.log(`Payment webhook processed: Transaction ${transaction.id} marked as success`);
      } else {
        console.warn(`Transaction not found for reference: ${reference}`);
      }
    } else if (event === 'charge.failed') {
      // Payment failed
      const reference = data.reference;
      const transaction = await req.db.models.PaymentTransaction.findOne({
        where: { transaction_reference: reference }
      });

      if (transaction) {
        await transaction.update({
          status: 'failed',
          gateway_response: data,
          failure_reason: data.gateway_response || 'Payment failed'
        });

        console.log(`Payment webhook processed: Transaction ${transaction.id} marked as failed`);
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

    // Verify online store exists and belongs to user
    const onlineStore = await req.db.models.OnlineStore.findOne({
      where: {
        id: online_store_id,
        tenant_id: req.user.tenantId
      }
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // Build webhook URL with online_store_id parameter
    const baseUrl = process.env.BASE_URL || process.env.API_URL || 'http://localhost:3000';
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

