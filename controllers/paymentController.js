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

    const platformFee = (parseFloat(amount) * transactionFeePercentage) / 100;
    const merchantAmount = parseFloat(amount) - platformFee;

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

    if (gateway.gateway_name === 'paystack') {
      paymentData = await initializePaystackPayment({
        amount: parseFloat(amount) * 100, // Paystack uses kobo (smallest currency unit)
        email,
        reference: transactionReference,
        callback_url: callback_url || `${process.env.FRONTEND_URL || 'http://localhost:3001'}/payment/callback`,
        metadata: {
          ...metadata,
          tenant_id: req.user.tenantId,
          transaction_id: paymentTransaction.id
        }
      }, secretKey, gateway.test_mode);
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
 * Initialize Paystack payment
 */
async function initializePaystackPayment(paymentData, secretKey, testMode) {
  const baseUrl = testMode 
    ? 'https://api.paystack.co'
    : 'https://api.paystack.co';

  try {
    const response = await axios.post(
      `${baseUrl}/transaction/initialize`,
      paymentData,
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
 * Handle payment webhook
 */
async function handlePaymentWebhook(req, res) {
  try {
    // Verify webhook signature (gateway-specific)
    // Then process webhook data
    // Update transaction status
    // Update order/invoice status

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

module.exports = {
  initializePayment,
  verifyPayment,
  handlePaymentWebhook
};

