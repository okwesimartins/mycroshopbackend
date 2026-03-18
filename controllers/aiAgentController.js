const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { getTenantById } = require('../config/tenant');
const { mainSequelize, getTenantConnection } = require('../config/database');
const { fetchVariantsForProductIds } = require('./onlineStoreController');

/**
 * Verify webhook signature from Meta
 */
function verifyWebhookSignature(payload, signature, secret) {
  if (!signature || !secret) return false;
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  const providedSignature = signature.replace('sha256=', '');
  
  return crypto.timingSafeEqual(
    Buffer.from(providedSignature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Handle webhook from Meta/Google Cloud
 * This endpoint receives messages from WhatsApp/Instagram
 */
async function handleWebhook(req, res) {
  try {
    // Handle GET request for webhook verification
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
        console.log('Webhook verified');
        return res.status(200).send(challenge);
      } else {
        return res.sendStatus(403);
      }
    }

    // Handle POST request for webhook events
    const signature = req.headers['x-hub-signature-256'];
    
    // Verify signature if secret is provided
    if (process.env.META_APP_SECRET) {
      if (!verifyWebhookSignature(req.body, signature, process.env.META_APP_SECRET)) {
        console.error('Invalid webhook signature');
        return res.sendStatus(403);
      }
    }

    const body = req.body;

    // Handle WhatsApp webhook
    if (body.object === 'whatsapp_business_account') {
      await handleWhatsAppWebhook(body);
    }

    // Handle Instagram webhook
    if (body.object === 'instagram') {
      await handleInstagramWebhook(body);
    }

    // Always return 200 to acknowledge receipt
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
}

/**
 * Handle WhatsApp webhook
 */
async function handleWhatsAppWebhook(body) {
  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages') {
          const value = change.value;
          
          if (value.messages && value.messages.length > 0) {
            for (const message of value.messages) {
              const from = message.from;
              const messageText = message.text?.body || '';
              const messageId = message.id;

              console.log(`WhatsApp message from ${from}: ${messageText}`);

              // Forward to Dialogflow or process directly
              // This should call your Google Cloud Function that handles Dialogflow
              await processMessage('whatsapp', from, messageText, value.metadata?.phone_number_id);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error handling WhatsApp webhook:', error);
  }
}

/**
 * Handle Instagram webhook
 */
async function handleInstagramWebhook(body) {
  try {
    for (const entry of body.entry || []) {
      if (entry.messaging) {
        for (const messaging of entry.messaging) {
          if (messaging.message) {
            const from = messaging.sender.id;
            const messageText = messaging.message.text || '';

            console.log(`Instagram message from ${from}: ${messageText}`);

            // Forward to Dialogflow or process directly
            await processMessage('instagram', from, messageText, entry.id);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error handling Instagram webhook:', error);
  }
}

/**
 * Process message and send to Dialogflow
 * This should be implemented to call your Google Cloud Function
 */
async function processMessage(platform, senderId, messageText, accountId) {
  try {
    // Call Google Cloud Function that handles Dialogflow
    // Replace with your actual Cloud Function URL
    const cloudFunctionUrl = `https://${process.env.GOOGLE_CLOUD_REGION}-${process.env.GOOGLE_CLOUD_PROJECT_ID}.cloudfunctions.net/dialogflow-webhook`;

    const response = await axios.post(cloudFunctionUrl, {
      platform,
      senderId,
      messageText,
      accountId,
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // The Cloud Function will handle Dialogflow and send response back
    return response.data;
  } catch (error) {
    console.error('Error processing message:', error);
    // Fallback: send default response
    await sendMessage(platform, senderId, 'Sorry, I am having trouble processing your message. Please try again later.', accountId);
  }
}

/**
 * Send message via Meta API
 */
async function sendMessage(platform, recipientId, messageText, accountId) {
  try {
    let url, payload;

    if (platform === 'whatsapp') {
      url = `https://graph.facebook.com/v18.0/${accountId || process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
      payload = {
        messaging_product: 'whatsapp',
        to: recipientId,
        type: 'text',
        text: { body: messageText }
      };
    } else if (platform === 'instagram') {
      url = `https://graph.facebook.com/v18.0/${accountId || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID}/messages`;
      payload = {
        recipient: { id: recipientId },
        message: { text: messageText }
      };
    } else {
      throw new Error('Unsupported platform');
    }

    const accessToken = platform === 'whatsapp' 
      ? process.env.WHATSAPP_ACCESS_TOKEN 
      : process.env.INSTAGRAM_ACCESS_TOKEN;

    await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Message sent to ${platform} user ${recipientId}`);
  } catch (error) {
    console.error(`Error sending ${platform} message:`, error.response?.data || error.message);
  }
}

/**
 * Get AI agent configuration
 */
async function getConfig(req, res) {
  try {
    let config = await req.db.models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (!config) {
      // Create default config
      config = await req.db.models.AIAgentConfig.create({
        whatsapp_enabled: false,
        instagram_enabled: false
      });
    }

    res.json({
      success: true,
      data: { config }
    });
  } catch (error) {
    console.error('Error getting AI agent config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get AI agent configuration'
    });
  }
}

/**
 * Update AI agent configuration
 */
async function updateConfig(req, res) {
  try {
    let config = await req.db.models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    const {
      whatsapp_enabled,
      instagram_enabled,
      whatsapp_phone_number,
      instagram_account_id,
      greeting_message,
      unavailable_message,
      business_hours,
      settings
    } = req.body;

    if (!config) {
      config = await req.db.models.AIAgentConfig.create({
        whatsapp_enabled: whatsapp_enabled || false,
        instagram_enabled: instagram_enabled || false,
        whatsapp_phone_number: whatsapp_phone_number || null,
        instagram_account_id: instagram_account_id || null,
        greeting_message: greeting_message || null,
        unavailable_message: unavailable_message || null,
        business_hours: business_hours || null,
        settings: settings || null
      });
    } else {
      await config.update({
        ...(whatsapp_enabled !== undefined && { whatsapp_enabled }),
        ...(instagram_enabled !== undefined && { instagram_enabled }),
        ...(whatsapp_phone_number !== undefined && { whatsapp_phone_number }),
        ...(instagram_account_id !== undefined && { instagram_account_id }),
        ...(greeting_message !== undefined && { greeting_message }),
        ...(unavailable_message !== undefined && { unavailable_message }),
        ...(business_hours !== undefined && { business_hours }),
        ...(settings !== undefined && { settings })
      });
    }

    res.json({
      success: true,
      message: 'AI agent configuration updated successfully',
      data: { config }
    });
  } catch (error) {
    console.error('Error updating AI agent config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update AI agent configuration'
    });
  }
}

/**
 * Check product availability (for AI agent)
 * This endpoint is called by the AI agent to check if a product exists
 */
async function checkProduct(req, res) {
  try {
    // Verify API key for AI agent
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const { name, tenant_id, subscription_plan } = req.query;

    if (!name || !tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Product name and tenant_id are required'
      });
    }

    const tenantId = parseInt(tenant_id, 10);
    if (Number.isNaN(tenantId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenant_id'
      });
    }

    const subscriptionPlan = subscription_plan || 'enterprise';
    const { getTenantConnection } = require('../config/database');
    const { Op } = require('sequelize');

    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);

    const searchTerm = String(name).trim();
    const likeTerm = `%${searchTerm}%`;

    const where = {
      [Op.or]: [
        { name: { [Op.like]: likeTerm } },
        { sku: { [Op.like]: likeTerm } }
      ],
      is_active: true
    };
    // Free users: scope by tenant_id in shared DB (required for correct store)
    if (subscriptionPlan === 'free') {
      where.tenant_id = tenantId;
    }

    const baseUrl = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');
    const toFullImageUrl = (url) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
    };

    // Explicit attributes: shared DB (free) has no store_id; include variations and options
    const product = await models.Product.findOne({
      where,
      attributes: ['id', 'name', 'price', 'stock', 'category', 'image_url', 'description'],
      include: [
        {
          model: models.ProductVariation,
          required: false,
          attributes: ['id', 'variation_name', 'variation_type'],
          include: [{
            model: models.ProductVariationOption,
            required: false,
            attributes: ['id', 'option_value', 'option_display_name', 'price_adjustment', 'stock', 'is_available', 'image_url']
          }]
        }
      ]
    });

    if (!product) {
      return res.json({
        success: true,
        exists: false,
        message: 'Product not found'
      });
    }

    const stock = product.get('stock');
    const available = stock != null ? Number(stock) > 0 : false;

    const variantsByProduct = await fetchVariantsForProductIds(sequelize, [product.id], toFullImageUrl);
    const variations = (product.ProductVariations || []).map(v => ({
      id: v.id,
      variation_name: v.variation_name,
      variation_type: v.variation_type,
      options: (v.ProductVariationOptions || []).map(o => ({
        id: o.id,
        option_value: o.option_value,
        option_display_name: o.option_display_name || o.option_value,
        price_adjustment: parseFloat(o.price_adjustment || 0),
        stock: o.stock,
        is_available: o.is_available,
        image_url: toFullImageUrl(o.image_url) || null
      }))
    }));

    res.json({
      success: true,
      exists: true,
      product: {
        id: product.id,
        name: product.name,
        price: product.price,
        stock: product.stock,
        category: product.category,
        description: product.description || null,
        image_url: toFullImageUrl(product.image_url) || null,
        available,
        variations: variations.length ? variations : undefined,
        variants: variantsByProduct.get(product.id) || []
      }
    });
  } catch (error) {
    console.error('Error checking product:', error.message, error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to check product'
    });
  }
}

/**
 * Get product info (for AI agent)
 */
async function getProductInfo(req, res) {
  try {
    // Verify API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const { product_id, tenant_id, subscription_plan } = req.query;

    if (!product_id || !tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Product ID and tenant_id are required'
      });
    }

    const tenantId = parseInt(tenant_id, 10);
    if (Number.isNaN(tenantId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenant_id'
      });
    }

    const subscriptionPlan = subscription_plan || 'enterprise';
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);

    const productId = parseInt(product_id, 10);
    if (Number.isNaN(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product_id'
      });
    }

    const where = { id: productId };
    if (subscriptionPlan === 'free') {
      where.tenant_id = tenantId;
    }

    // Explicit attributes: shared DB has no store_id
    const product = await models.Product.findOne({
      where,
      attributes: ['id', 'name', 'description', 'price', 'stock', 'category', 'image_url']
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      product: {
        id: product.id,
        name: product.name,
        description: product.description,
        price: product.price,
        stock: product.stock,
        category: product.category,
        image_url: product.image_url || null
      }
    });
  } catch (error) {
    console.error('Error getting product info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product info'
    });
  }
}

/**
 * List products for AI agent (inventory/catalog with optional search, returns image_url for media)
 */
async function listProducts(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { tenant_id, subscription_plan, search, limit } = req.query;
    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id is required'
      });
    }

    const tenantId = parseInt(tenant_id, 10);
    if (Number.isNaN(tenantId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tenant_id'
      });
    }

    const subscriptionPlan = subscription_plan || 'enterprise';
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);
    const { Op } = require('sequelize');

    const where = { is_active: true };
    if (subscriptionPlan === 'free') {
      where.tenant_id = tenantId;
    }
    if (search && String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      where[Op.or] = [
        { name: { [Op.like]: term } },
        { sku: { [Op.like]: term } },
        { category: { [Op.like]: term } }
      ];
    }

    const limitNum = Math.min(parseInt(limit, 10) || 20, 50);

    const products = await models.Product.findAll({
      where,
      attributes: ['id', 'name', 'price', 'stock', 'category', 'image_url', 'description'],
      order: [['name', 'ASC']],
      limit: limitNum,
      include: [
        {
          model: models.ProductVariation,
          required: false,
          attributes: ['id', 'variation_name', 'variation_type'],
          include: [{
            model: models.ProductVariationOption,
            required: false,
            attributes: ['id', 'option_value', 'option_display_name', 'price_adjustment', 'stock', 'is_available', 'image_url']
          }]
        }
      ]
    });

    const baseUrl = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');
    const toFullImageUrl = (url) => {
      if (!url) return null;
      if (url.startsWith('http')) return url;
      return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
    };

    const productIds = products.map(p => p.id);
    const variantsByProduct = await fetchVariantsForProductIds(sequelize, productIds, toFullImageUrl);

    res.json({
      success: true,
      products: products.map(p => {
        const variations = (p.ProductVariations || []).map(v => ({
          id: v.id,
          variation_name: v.variation_name,
          variation_type: v.variation_type,
          options: (v.ProductVariationOptions || []).map(o => ({
            id: o.id,
            option_value: o.option_value,
            option_display_name: o.option_display_name || o.option_value,
            price_adjustment: parseFloat(o.price_adjustment || 0),
            stock: o.stock,
            is_available: o.is_available,
            image_url: toFullImageUrl(o.image_url) || null
          }))
        }));
        return {
          id: p.id,
          name: p.name,
          price: p.price,
          stock: p.stock,
          category: p.category,
          image_url: toFullImageUrl(p.image_url) || null,
          description: p.description ? String(p.description).slice(0, 200) : null,
          variations: variations.length ? variations : undefined,
          variants: variantsByProduct.get(p.id) || []
        };
      })
    });
  } catch (error) {
    console.error('Error listing products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list products'
    });
  }
}

/**
 * Resolve tenant and WhatsApp token from phone_number_id (for Google Cloud AI agent).
 * Single source of truth: main DB only (same pattern as domain resolution).
 * All WhatsApp connections (free + enterprise) are stored in main DB; one indexed lookup, fast at scale.
 * Called by Cloud with x-api-key. Returns tenant_id, access_token, store_name, subscription_plan, default_online_store_id.
 */
async function resolveTenant(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const phoneNumberId = req.query.phone_number_id || req.body?.phone_number_id;
    if (!phoneNumberId) {
      return res.status(400).json({
        success: false,
        message: 'phone_number_id is required'
      });
    }

    const [rows] = await mainSequelize.query(
      'SELECT tenant_id, access_token FROM whatsapp_connections WHERE phone_number_id = ? LIMIT 1',
      { replacements: [phoneNumberId] }
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No WhatsApp connection found for this phone number ID'
      });
    }

    const { tenant_id, access_token } = rows[0];
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Same flow for free and enterprise: get subscription, then tenant DB for default_online_store_id
    const subscriptionPlan = tenant.subscription_plan || 'enterprise';
    let default_online_store_id = null;
    try {
      const sequelize = await getTenantConnection(tenant_id, subscriptionPlan);
      const models = require('../models')(sequelize);
      const where = subscriptionPlan === 'free' ? { tenant_id } : {};
      const firstStore = await models.OnlineStore.findOne({
        where,
        order: [['id', 'ASC']],
        attributes: ['id']
      });
      default_online_store_id = firstStore?.id ?? null;
    } catch (e) {
      // ignore
    }

    const paymentType = tenant.payment_instruction_type || 'paystack';
    res.json({
      success: true,
      data: {
        tenant_id,
        access_token,
        store_name: tenant.name || 'our store',
        business_bio: tenant.business_bio || null,
        subscription_plan: subscriptionPlan,
        default_online_store_id,
        payment_instruction_type: paymentType,
        paypal_email: tenant.paypal_email || null,
        bank_account_name: tenant.bank_account_name || null,
        bank_name: tenant.bank_name || null,
        bank_account_number: tenant.bank_account_number || null,
        bank_code: tenant.bank_code || null,
        payment_instructions: tenant.payment_instructions || null,
      }
    });
  } catch (error) {
    console.error('resolveTenant error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resolve tenant',
      error: error.message
    });
  }
}

/**
 * Store the link between the "order confirmation" WhatsApp message we sent and the order_id.
 * When the customer replies to that message with a receipt image, we use this to attach to the correct order.
 * POST /api/v1/ai-agent/orders/record-confirmation-message
 * Body: { tenant_id, order_id, confirmation_message_id }
 * Headers: x-api-key
 */
async function recordOrderConfirmationMessage(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const { tenant_id, order_id, confirmation_message_id } = req.body || {};
    const tenantId = tenant_id != null ? parseInt(tenant_id, 10) : null;
    const orderId = order_id != null ? parseInt(order_id, 10) : null;
    const messageId = typeof confirmation_message_id === 'string' ? confirmation_message_id.trim() : '';
    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }
    if (!orderId || Number.isNaN(orderId)) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }
    if (!messageId) {
      return res.status(400).json({ success: false, message: 'confirmation_message_id is required' });
    }

    await mainSequelize.query(
      `INSERT INTO order_receipt_message_context (tenant_id, order_id, confirmation_message_id)
       VALUES (:tenantId, :orderId, :messageId)
       ON DUPLICATE KEY UPDATE order_id = VALUES(order_id), confirmation_message_id = VALUES(confirmation_message_id)`,
      { replacements: { tenantId, orderId, messageId } }
    );
    return res.json({ success: true, message: 'Confirmation message recorded' });
  } catch (error) {
    console.error('recordOrderConfirmationMessage error:', error);
    res.status(500).json({ success: false, message: 'Failed to record', error: error.message });
  }
}

/**
 * Get order_id for a given "order confirmation" message we sent (so receipt reply attaches to correct order).
 * GET /api/v1/ai-agent/orders/by-confirmation-message?tenant_id=&confirmation_message_id=
 * Headers: x-api-key
 */
async function getOrderByConfirmationMessageId(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const tenant_id = req.query?.tenant_id ?? req.body?.tenant_id;
    const confirmation_message_id = req.query?.confirmation_message_id ?? req.body?.confirmation_message_id;
    const tenantId = tenant_id != null ? parseInt(tenant_id, 10) : null;
    const messageId = typeof confirmation_message_id === 'string' ? confirmation_message_id.trim() : '';
    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }
    if (!messageId) {
      return res.status(400).json({ success: false, message: 'confirmation_message_id is required' });
    }

    const [rows] = await mainSequelize.query(
      `SELECT order_id FROM order_receipt_message_context
       WHERE tenant_id = :tenantId AND confirmation_message_id = :messageId
       LIMIT 1`,
      { replacements: { tenantId, messageId } }
    );
    const orderId = rows && rows[0] ? rows[0].order_id : null;
    return res.json({ success: true, data: { order_id: orderId } });
  } catch (error) {
    console.error('getOrderByConfirmationMessageId error:', error);
    res.status(500).json({ success: false, message: 'Failed to get order', error: error.message });
  }
}

/**
 * Get the most recent pending order (payment_status pending) for a customer phone.
 * Used by AI agent when customer sends an image to attach as receipt.
 * GET/POST /api/v1/ai-agent/orders/pending-by-phone?tenant_id=&customer_phone= (or in body)
 * Headers: x-api-key
 */
async function getPendingOrderByCustomerPhone(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const tenant_id = req.query?.tenant_id ?? req.body?.tenant_id;
    const customer_phone = req.query?.customer_phone ?? req.body?.customer_phone;
    const tenantId = tenant_id != null ? parseInt(tenant_id, 10) : null;
    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }
    const phone = typeof customer_phone === 'string' ? customer_phone.replace(/[+\s]/g, '') : '';
    if (!phone) {
      return res.status(400).json({ success: false, message: 'customer_phone is required' });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    const sequelize = await getTenantConnection(tenantId, tenant.subscription_plan || 'enterprise');
    const models = require('../models')(sequelize);

    const { Op } = require('sequelize');
    const where = {
      status: 'pending',
      payment_status: 'pending',
      [Op.and]: [
        sequelize.where(
          sequelize.fn('REPLACE', sequelize.fn('REPLACE', sequelize.col('customer_phone'), '+', ''), ' ', ''),
          Op.eq,
          phone
        )
      ]
    };
    if (tenant.subscription_plan === 'free') {
      where.tenant_id = tenantId;
    }
    const order = await models.OnlineStoreOrder.findOne({
      where,
      order: [['created_at', 'DESC']]
    });

    if (!order) {
      return res.json({ success: true, data: { order: null } });
    }
    return res.json({ success: true, data: { order: order.toJSON() } });
  } catch (error) {
    console.error('getPendingOrderByCustomerPhone error:', error);
    res.status(500).json({ success: false, message: 'Failed to get pending order', error: error.message });
  }
}

/**
 * Attach payment receipt to an order (URL or base64 image from WhatsApp).
 * POST /api/v1/ai-agent/attach-order-receipt
 * Body: { tenant_id, order_id, receipt_url?: string, receipt_image_base64?: string }
 * Headers: x-api-key
 */
async function attachOrderReceipt(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const { tenant_id, order_id, receipt_url, receipt_image_base64 } = req.body || {};
    const tenantId = tenant_id != null ? parseInt(tenant_id, 10) : null;
    const orderId = order_id != null ? parseInt(order_id, 10) : null;
    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }
    if (!orderId || Number.isNaN(orderId)) {
      return res.status(400).json({ success: false, message: 'order_id is required' });
    }
    if (!receipt_url && !receipt_image_base64) {
      return res.status(400).json({ success: false, message: 'receipt_url or receipt_image_base64 is required' });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    const sequelize = await getTenantConnection(tenantId, tenant.subscription_plan || 'enterprise');
    const models = require('../models')(sequelize);

    const order = await models.OnlineStoreOrder.findByPk(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    let finalReceiptUrl = receipt_url || null;
    if (receipt_image_base64) {
      const uploadsDir = path.join(__dirname, '..', 'uploads', 'receipts', String(tenantId));
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      const ext = 'jpg';
      const filename = `${orderId}-${Date.now()}.${ext}`;
      const filePath = path.join(uploadsDir, filename);
      const buf = Buffer.from(receipt_image_base64, 'base64');
      fs.writeFileSync(filePath, buf);
      finalReceiptUrl = `/uploads/receipts/${tenantId}/${filename}`;
    }

    await order.update({
      payment_receipt_url: finalReceiptUrl,
      payment_receipt_received_at: new Date()
    });

    return res.json({
      success: true,
      message: 'Receipt attached to order',
      data: { order: await order.reload() }
    });
  } catch (error) {
    console.error('attachOrderReceipt error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to attach receipt',
      error: error.message
    });
  }
}

/**
 * Confirm or decline order payment (for AI / WhatsApp flow when store owner approves receipt).
 * Called when store owner taps Approve/Decline on receipt notification.
 * POST /api/v1/ai-agent/confirm-order-payment
 * Body: { tenant_id, order_id, action: 'approve' | 'decline' }
 * Headers: x-api-key
 */
async function confirmOrderPayment(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { tenant_id, order_id, action } = req.body || {};
    const tenantId = tenant_id != null ? parseInt(tenant_id, 10) : null;
    const orderId = order_id != null ? parseInt(order_id, 10) : null;

    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id is required'
      });
    }
    if (!orderId || Number.isNaN(orderId)) {
      return res.status(400).json({
        success: false,
        message: 'order_id is required'
      });
    }
    if (!action || !['approve', 'decline'].includes(String(action).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'action must be "approve" or "decline"'
      });
    }

    const { getTenantConnection } = require('../config/database');
    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    const subscriptionPlan = tenant.subscription_plan || 'enterprise';
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);

    const order = await models.OnlineStoreOrder.findByPk(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const act = String(action).toLowerCase();
    if (act === 'approve') {
      await order.update({
        payment_status: 'paid',
        status: 'confirmed',
        updated_at: new Date()
      });
      return res.json({
        success: true,
        message: 'Payment confirmed and order approved',
        data: { order: await order.reload() }
      });
    }
    // decline: leave payment_status and status as-is (or could set a declined note)
    return res.json({
      success: true,
      message: 'Payment declined',
      data: { order: await order.reload() }
    });
  } catch (error) {
    console.error('confirmOrderPayment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm order payment',
      error: error.message
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Agent – Booking (list services, availability, create booking)
// x-api-key only; used by Cloud process-message.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List bookable services for the tenant (for AI agent).
 * GET /api/v1/ai-agent/list-services?tenant_id=…&subscription_plan=…&online_store_id=…
 */
async function listServices(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { tenant_id, subscription_plan, online_store_id } = req.query;
    if (!tenant_id) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }

    const tenantId = parseInt(tenant_id, 10);
    if (Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'Invalid tenant_id' });
    }

    const subscriptionPlan = subscription_plan || 'enterprise';
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);

    const where = { is_active: true };
    if (subscriptionPlan === 'free') {
      where.tenant_id = tenantId;
    }

    // Optional: filter services linked to a specific online store (free plan)
    let serviceIds = null;
    if (subscriptionPlan === 'free' && online_store_id) {
      const oss = await models.OnlineStoreService.findAll({
        where: { online_store_id: parseInt(online_store_id, 10), is_visible: true },
        attributes: ['service_id']
      });
      serviceIds = oss.map(o => o.service_id);
      if (serviceIds.length === 0) {
        return res.json({ success: true, services: [] });
      }
    }

    if (serviceIds && serviceIds.length) {
      const { Op } = require('sequelize');
      where.id = { [Op.in]: serviceIds };
    }

    const services = await models.StoreService.findAll({
      where,
      attributes: ['id', 'service_title', 'description', 'price', 'duration_minutes', 'location_type'],
      order: [['sort_order', 'ASC'], ['service_title', 'ASC']]
    });

    res.json({
      success: true,
      services: services.map(s => ({
        id: s.id,
        service_title: s.service_title,
        description: s.description || null,
        price: parseFloat(s.price || 0),
        duration_minutes: s.duration_minutes || 30,
        location_type: s.location_type || 'in_person'
      }))
    });
  } catch (error) {
    console.error('listServices error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list services',
      error: error.message
    });
  }
}

/**
 * Get available time slots for a service on a given date.
 * Uses BookingAvailability (day_of_week, start_time, end_time) and existing Bookings to compute free slots.
 * GET /api/v1/ai-agent/service-availability?tenant_id=…&service_id=…&date=YYYY-MM-DD&subscription_plan=…
 */
async function getServiceAvailability(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { tenant_id, service_id, date, subscription_plan } = req.query;
    if (!tenant_id || !service_id || !date) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id, service_id and date (YYYY-MM-DD) are required'
      });
    }

    const tenantId = parseInt(tenant_id, 10);
    const serviceId = parseInt(service_id, 10);
    if (Number.isNaN(tenantId) || Number.isNaN(serviceId)) {
      return res.status(400).json({ success: false, message: 'Invalid tenant_id or service_id' });
    }

    const dateStr = String(date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' });
    }

    const subscriptionPlan = subscription_plan || 'enterprise';
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);

    const service = await models.StoreService.findOne({
      where: subscriptionPlan === 'free' ? { id: serviceId, tenant_id: tenantId } : { id: serviceId },
      attributes: ['id', 'duration_minutes']
    });
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    const d = new Date(dateStr + 'T00:00:00');
    const dayOfWeek = d.getDay();
    const durationMinutes = service.duration_minutes || 30;

    const { Op } = require('sequelize');
    const availWhere = {
      service_id: serviceId,
      day_of_week: dayOfWeek,
      is_available: true
    };
    if (subscriptionPlan === 'free') {
      availWhere.tenant_id = tenantId;
    }
    const availRows = await models.BookingAvailability.findAll({
      where: availWhere,
      attributes: ['start_time', 'end_time']
    });

    const slots = [];
    const pad = (n) => String(n).padStart(2, '0');

    if (availRows.length === 0) {
      // No availability config: default 09:00–17:00, 30-min slots
      const start = 9 * 60;
      const end = 17 * 60;
      for (let t = start; t + durationMinutes <= end; t += 30) {
        const h = Math.floor(t / 60);
        const m = t % 60;
        slots.push({
          start: `${pad(h)}:${pad(m)}:00`,
          end: `${pad(Math.floor((t + durationMinutes) / 60))}:${pad((t + durationMinutes) % 60)}:00`,
          slot: `${pad(h)}:${pad(m)}`,
          label: `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`
        });
      }
    } else {
      for (const row of availRows) {
        const startStr = row.start_time;
        const endStr = row.end_time;
        const [sh, sm] = (typeof startStr === 'string' ? startStr : '').split(':').map(Number);
        const [eh, em] = (typeof endStr === 'string' ? endStr : '').split(':').map(Number);
        const startMins = (sh || 0) * 60 + (sm || 0);
        const endMins = (eh || 0) * 60 + (em || 0);
        for (let t = startMins; t + durationMinutes <= endMins; t += 30) {
          const h = Math.floor(t / 60);
          const m = t % 60;
          slots.push({
            start: `${pad(h)}:${pad(m)}:00`,
            end: `${pad(Math.floor((t + durationMinutes) / 60))}:${pad((t + durationMinutes) % 60)}:00`,
            slot: `${pad(h)}:${pad(m)}`,
            label: `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`
          });
        }
      }
    }

    const dayStart = new Date(dateStr + 'T00:00:00').getTime();
    const dayEnd = new Date(dateStr + 'T23:59:59').getTime();

    const bookingWhere = {
      service_id: serviceId,
      status: { [Op.notIn]: ['cancelled'] },
      scheduled_at: { [Op.gte]: new Date(dayStart), [Op.lte]: new Date(dayEnd) }
    };
    if (subscriptionPlan === 'free') {
      bookingWhere.tenant_id = tenantId;
    }
    const existingBookings = await models.Booking.findAll({
      where: bookingWhere,
      attributes: ['scheduled_at', 'duration_minutes']
    });

    const bookedRanges = existingBookings.map(b => {
      const at = new Date(b.scheduled_at);
      const dur = b.duration_minutes || 30;
      const start = at.getHours() * 60 + at.getMinutes();
      const end = start + dur;
      return [start, end];
    });

    const available = slots.filter(s => {
      const [sh, sm] = s.start.split(':').map(Number);
      const slotStart = sh * 60 + sm;
      const slotEnd = slotStart + durationMinutes;
      return !bookedRanges.some(([bStart, bEnd]) => slotStart < bEnd && slotEnd > bStart);
    });

    res.json({
      success: true,
      date: dateStr,
      service_id: serviceId,
      slots: available.map(s => ({ start: s.start, end: s.end, slot: s.slot, label: s.label }))
    });
  } catch (error) {
    console.error('getServiceAvailability error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get availability',
      error: error.message
    });
  }
}

/**
 * Create a booking (for AI agent).
 * POST /api/v1/ai-agent/create-booking
 * Body: { tenant_id, service_id, scheduled_at, customer_name, customer_phone, customer_email?, subscription_plan? }
 * scheduled_at: ISO datetime or "YYYY-MM-DDTHH:mm:ss"
 */
async function createBooking(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const body = req.body || {};
    const {
      tenant_id,
      service_id,
      scheduled_at,
      customer_name,
      customer_phone,
      customer_email,
      subscription_plan
    } = body;

    if (!tenant_id || !service_id || !scheduled_at || !customer_name || !customer_phone) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id, service_id, scheduled_at, customer_name and customer_phone are required'
      });
    }

    const tenantId = parseInt(tenant_id, 10);
    const serviceId = parseInt(service_id, 10);
    if (Number.isNaN(tenantId) || Number.isNaN(serviceId)) {
      return res.status(400).json({ success: false, message: 'Invalid tenant_id or service_id' });
    }

    const subscriptionPlan = subscription_plan || 'enterprise';
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);

    const service = await models.StoreService.findOne({
      where: subscriptionPlan === 'free' ? { id: serviceId, tenant_id: tenantId } : { id: serviceId },
      attributes: ['id', 'service_title', 'description', 'duration_minutes', 'location_type']
    });
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    const at = new Date(scheduled_at);
    if (Number.isNaN(at.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid scheduled_at' });
    }

    const booking = await models.Booking.create({
      tenant_id: subscriptionPlan === 'free' ? tenantId : null,
      store_id: service.store_id || null,
      service_id: serviceId,
      customer_id: null,
      customer_name: String(customer_name).trim(),
      customer_email: (customer_email && String(customer_email).trim()) || null,
      customer_phone: String(customer_phone).trim(),
      service_title: service.service_title,
      description: service.description || null,
      scheduled_at: at,
      duration_minutes: service.duration_minutes || 30,
      timezone: 'Africa/Lagos',
      location_type: service.location_type || 'in_person',
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      data: { booking: booking.toJSON(), created: true },
      message: 'Booking created'
    });
  } catch (error) {
    console.error('createBooking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: error.message
    });
  }
}

module.exports = {
  handleWebhook,
  getConfig,
  updateConfig,
  checkProduct,
  getProductInfo,
  listProducts,
  resolveTenant,
  recordOrderConfirmationMessage,
  getOrderByConfirmationMessageId,
  getPendingOrderByCustomerPhone,
  attachOrderReceipt,
  confirmOrderPayment,
  listServices,
  getServiceAvailability,
  createBooking
};

