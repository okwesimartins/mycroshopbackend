/**
 * Test script to simulate Paystack webhook
 * 
 * Usage:
 * node test-webhook.js
 * 
 * This script simulates a Paystack webhook event for testing
 */

const crypto = require('crypto');
const axios = require('axios');

// Configuration
const WEBHOOK_URL = 'https://backend.mycroshop.com/api/v1/payments/webhook?online_store_id=6';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'your_secret_key_here';

// Sample webhook payload (charge.success event)
const webhookPayload = {
  event: 'charge.success',
  data: {
    id: 1234567890,
    domain: 'test',
    status: 'success',
    reference: 'TXN-1768837205191-5EE2F01C', // Use an actual transaction reference from your database
    amount: 16770, // Amount in kobo (16770.00 NGN)
    message: 'Successful',
    gateway_response: 'Successful',
    paid_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    channel: 'card',
    currency: 'NGN',
    ip_address: '197.210.52.72',
    metadata: {
      tenant_id: 21, // Your tenant ID // Your transaction ID
      online_store_id: 6,
      custom_fields: []
    },
    log: null,
    fees: null,
    fees_split: null,
    authorization: {
      authorization_code: 'AUTH_xxxxxx',
      bin: '408408',
      last4: '4081',
      exp_month: '12',
      exp_year: '2030',
      channel: 'card',
      card_type: 'visa',
      bank: 'TEST BANK',
      country_code: 'NG',
      brand: 'visa',
      reusable: true,
      signature: 'SIG_xxxxxx',
      account_name: null
    },
    customer: {
      id: 123456,
      first_name: 'Martins',
      last_name: 'Okwesi',
      email: 'okwesimartins@gmail.com',
      customer_code: 'CUS_xxxxxx',
      phone: null,
      metadata: null,
      risk_action: 'default'
    },
    plan: null,
    split: {},
    order_id: null,
    paidAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    requested_amount: 1677000
  }
};

// Generate webhook signature
function generateWebhookSignature(payload, secret) {
  return crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Send webhook
async function sendWebhook() {
  try {
    const signature = generateWebhookSignature(webhookPayload, PAYSTACK_SECRET_KEY);
    
    console.log('Sending webhook to:', WEBHOOK_URL);
    console.log('Event:', webhookPayload.event);
    console.log('Reference:', webhookPayload.data.reference);
    console.log('Signature:', signature);
    console.log('\nPayload:', JSON.stringify(webhookPayload, null, 2));
    
    const response = await axios.post(WEBHOOK_URL, webhookPayload, {
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature
      }
    });
    
    console.log('\n✅ Webhook sent successfully!');
    console.log('Response status:', response.status);
    console.log('Response data:', response.data);
  } catch (error) {
    console.error('\n❌ Error sending webhook:');
    console.error('Status:', error.response?.status);
    console.error('Response:', error.response?.data);
    console.error('Error:', error.message);
  }
}

// Test charge.failed event
async function sendFailedWebhook() {
  const failedPayload = {
    event: 'charge.failed',
    data: {
      id: 1234567891,
      domain: 'test',
      status: 'failed',
      reference: 'TXN-1234567890-ABCD',
      amount: 1677000,
      message: 'Declined',
      gateway_response: 'Declined',
      created_at: new Date().toISOString(),
      channel: 'card',
      currency: 'NGN',
      metadata: {
        tenant_id: 21,
        transaction_id: 123
      },
      customer: {
        email: 'okwesimartins@gmail.com'
      }
    }
  };
  
  try {
    const signature = generateWebhookSignature(failedPayload, PAYSTACK_SECRET_KEY);
    
    console.log('\nSending FAILED webhook...');
    const response = await axios.post(WEBHOOK_URL, failedPayload, {
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': signature
      }
    });
    
    console.log('✅ Failed webhook sent successfully!');
    console.log('Response:', response.data);
  } catch (error) {
    console.error('❌ Error sending failed webhook:', error.response?.data || error.message);
  }
}

// Run tests
if (require.main === module) {
  console.log('=== Paystack Webhook Test Script ===\n');
  
  if (PAYSTACK_SECRET_KEY === 'your_secret_key_here') {
    console.error('⚠️  Please set PAYSTACK_SECRET_KEY environment variable');
    console.error('   Example: PAYSTACK_SECRET_KEY=sk_test_xxxxx node test-webhook.js');
    process.exit(1);
  }
  
  // Send success webhook
  sendWebhook().then(() => {
    // Uncomment to also test failed webhook
    // setTimeout(() => sendFailedWebhook(), 2000);
  });
}

module.exports = { sendWebhook, sendFailedWebhook, generateWebhookSignature };

