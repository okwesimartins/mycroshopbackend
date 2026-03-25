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

async function getWhatsappConnectionForTenant(tenantId) {
  try {
    let ownerCol = null;
    const [columns] = await mainSequelize.query('SHOW COLUMNS FROM whatsapp_connections');
    const availableCols = new Set((columns || []).map(c => c.Field));
    const ownerCandidates = ['owner_whatsapp_number', 'owner_phone', 'phone', 'owner_number', 'notification_phone'];
    ownerCol = ownerCandidates.find(c => availableCols.has(c)) || null;
    const selectOwner = ownerCol ? `, ${ownerCol} AS owner_whatsapp_number` : '';
    const [rows] = await mainSequelize.query(
      `SELECT phone_number_id, access_token${selectOwner} FROM whatsapp_connections WHERE tenant_id = ? LIMIT 1`,
      { replacements: [tenantId] }
    );
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

async function sendWhatsAppTextRaw(phoneNumberId, accessToken, to, body) {
  if (!phoneNumberId || !accessToken || !to || !body) return false;
  try {
    const toNum = String(to).replace(/[+\s]/g, '');
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toNum,
        type: 'text',
        text: { body: String(body).slice(0, 4096) }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    return true;
  } catch (e) {
    console.warn('sendWhatsAppTextRaw failed:', e.message);
    return false;
  }
}

function extensionFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('pdf')) return 'pdf';
  return 'bin';
}

function isValidIsoDateLike(v) {
  if (!v) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}

function validateProductMetadata(md, amountNum) {
  const errs = [];
  if (!md.customer_phone || !String(md.customer_phone).trim()) {
    errs.push('metadata.customer_phone is required');
  }
  const items = Array.isArray(md.items) ? md.items : null;
  if (!items || items.length === 0) {
    errs.push('metadata.items is required for product payments');
    return errs;
  }

  let itemTotal = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const prefix = `metadata.items[${i}]`;
    const qty = Number(it.quantity);
    const price = Number(it.unit_price);
    if (!it.product_id || Number.isNaN(Number(it.product_id))) errs.push(`${prefix}.product_id is required`);
    if (!Number.isFinite(qty) || qty <= 0) errs.push(`${prefix}.quantity must be > 0`);
    if (!Number.isFinite(price) || price <= 0) errs.push(`${prefix}.unit_price must be > 0`);

    // Optional variant support:
    // - simple item: no variant_id and no variant_options (valid)
    // - variant item: variant_id, optionally variant_options
    // - options-only item: variant_options with no variant_id (still valid for stores without strict variant IDs)
    if (it.variant_options != null) {
      if (!Array.isArray(it.variant_options)) {
        errs.push(`${prefix}.variant_options must be an array when provided`);
      } else {
        for (let j = 0; j < it.variant_options.length; j++) {
          const opt = it.variant_options[j] || {};
          if (!opt.name || !String(opt.name).trim()) errs.push(`${prefix}.variant_options[${j}].name is required`);
          if (!opt.value || !String(opt.value).trim()) errs.push(`${prefix}.variant_options[${j}].value is required`);
        }
      }
    }
    itemTotal += (Number.isFinite(qty) ? qty : 0) * (Number.isFinite(price) ? price : 0);
  }

  if (md.total != null) {
    const declaredTotal = Number(md.total);
    if (!Number.isFinite(declaredTotal) || declaredTotal <= 0) {
      errs.push('metadata.total must be a positive number when provided');
    } else {
      const diff = Math.abs(declaredTotal - amountNum);
      if (diff > 1) errs.push(`amount (${amountNum}) does not match metadata.total (${declaredTotal})`);
    }
  } else {
    const diff = Math.abs(itemTotal - amountNum);
    // Allow slight slack for fees/discounts if they exist
    const hasAdjustments = md.delivery_fee != null || md.discount != null || md.tax != null;
    if (!hasAdjustments && diff > 1) {
      errs.push(`amount (${amountNum}) does not match item total (${itemTotal})`);
    }
  }
  return errs;
}

function validateServiceMetadata(md) {
  const errs = [];
  if (!md.service_id || Number.isNaN(Number(md.service_id))) errs.push('metadata.service_id is required');
  if (!md.scheduled_at || !isValidIsoDateLike(md.scheduled_at)) errs.push('metadata.scheduled_at must be a valid datetime');
  if (!md.customer_phone || !String(md.customer_phone).trim()) errs.push('metadata.customer_phone is required');
  if (md.booking_id != null && Number.isNaN(Number(md.booking_id))) errs.push('metadata.booking_id must be numeric when provided');
  return errs;
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
        { sku: { [Op.like]: likeTerm } },
        { category: { [Op.like]: likeTerm } }
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

    // Pull owner notification number from whatsapp_connections when available.
    // Column names differ across environments, so discover columns dynamically.
    let ownerCol = null;
    try {
      const [columns] = await mainSequelize.query('SHOW COLUMNS FROM whatsapp_connections');
      const availableCols = new Set((columns || []).map(c => c.Field));
      const ownerCandidates = [
        'owner_whatsapp_number',
        'owner_phone',
        'phone',
        'owner_number',
        'notification_phone'
      ];
      ownerCol = ownerCandidates.find(c => availableCols.has(c)) || null;
    } catch (_) {}

    const selectOwner = ownerCol ? `, ${ownerCol} AS owner_whatsapp_number` : '';
    const [rows] = await mainSequelize.query(
      `SELECT tenant_id, access_token${selectOwner} FROM whatsapp_connections WHERE phone_number_id = ? LIMIT 1`,
      { replacements: [phoneNumberId] }
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No WhatsApp connection found for this phone number ID'
      });
    }

    const { tenant_id, access_token, owner_whatsapp_number: ownerFromConnection } = rows[0];
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
        owner_whatsapp_number: ownerFromConnection || tenant.owner_whatsapp_number || tenant.owner_phone || tenant.phone || null,
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
    const { tenant_id, order_id, receipt_url, receipt_image_base64, mime_type } = req.body || {};
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
      const ext = extensionFromMime(mime_type);
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
      attributes: ['id', 'service_title', 'description', 'price', 'duration_minutes', 'location_type', 'service_image_url'],
      order: [['sort_order', 'ASC'], ['service_title', 'ASC']]
    });

    const baseUrl = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');
    const toFullImageUrl = (url) => {
      if (!url) return null;
      if (String(url).startsWith('http')) return url;
      return `${baseUrl}${String(url).startsWith('/') ? '' : '/'}${url}`;
    };

    res.json({
      success: true,
      services: services.map(s => ({
        id: s.id,
        service_title: s.service_title,
        description: s.description || null,
        price: parseFloat(s.price || 0),
        duration_minutes: s.duration_minutes || 30,
        location_type: s.location_type || 'in_person',
        service_image_url: toFullImageUrl(s.service_image_url) || null
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
 * Helpers for service availability (single day + range).
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

function addDaysToYMD(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function todayYMDLocal() {
  const dt = new Date();
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function bookingDateKey(scheduledAt) {
  const at = new Date(scheduledAt);
  const yy = at.getFullYear();
  const mm = String(at.getMonth() + 1).padStart(2, '0');
  const dd = String(at.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function buildRawSlotsFromAvailability(availRows, durationMinutes) {
  const slots = [];
  const pad = pad2;
  if (!availRows.length) {
    const start = 9 * 60;
    const end = 17 * 60;
    for (let t = start; t + durationMinutes <= end; t += 30) {
      const h = Math.floor(t / 60);
      const m = t % 60;
      slots.push({
        start: `${pad(h)}:${pad(m)}:00`,
        end: `${pad(Math.floor((t + durationMinutes) / 60))}:${pad((t + durationMinutes) % 60)}:00`,
        slot: `${pad(h)}:${pad(m)}`,
        label: `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`,
        max_bookings_per_slot: 1,
      });
    }
    return slots;
  }
  for (const row of availRows) {
    const startStr = row.start_time;
    const endStr = row.end_time;
    const [sh, sm] = (typeof startStr === 'string' ? startStr : '').split(':').map(Number);
    const [eh, em] = (typeof endStr === 'string' ? endStr : '').split(':').map(Number);
    const startMins = (sh || 0) * 60 + (sm || 0);
    const endMins = (eh || 0) * 60 + (em || 0);
    const capacity = Math.max(1, parseInt(row.max_bookings_per_slot, 10) || 1);
    for (let t = startMins; t + durationMinutes <= endMins; t += 30) {
      const h = Math.floor(t / 60);
      const m = t % 60;
      slots.push({
        start: `${pad(h)}:${pad(m)}:00`,
        end: `${pad(Math.floor((t + durationMinutes) / 60))}:${pad((t + durationMinutes) % 60)}:00`,
        slot: `${pad(h)}:${pad(m)}`,
        label: `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`,
        max_bookings_per_slot: capacity,
      });
    }
  }
  return slots;
}

function filterSlotsByBookings(slots, existingBookings, durationMinutes) {
  const bookedRanges = existingBookings.map(b => {
    const at = new Date(b.scheduled_at);
    const dur = b.duration_minutes || 30;
    const start = at.getHours() * 60 + at.getMinutes();
    const end = start + dur;
    return [start, end];
  });
  return slots.filter(s => {
    const [sh, sm] = s.start.split(':').map(Number);
    const slotStart = sh * 60 + sm;
    const slotEnd = slotStart + durationMinutes;
    const overlapCount = bookedRanges.filter(([bStart, bEnd]) => slotStart < bEnd && slotEnd > bStart).length;
    const capacity = Math.max(1, parseInt(s.max_bookings_per_slot, 10) || 1);
    return overlapCount < capacity;
  });
}

/** JS Date.getDay(): 0=Sun … 6=Sat — matches StoreService.availability JSON keys */
const AVAILABILITY_DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function normalizeServiceAvailabilityColumn(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

/** True if object looks like { monday: { available, time_slots }, ... } */
function usesStoreServiceAvailabilityJson(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return AVAILABILITY_DAY_NAMES.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function getDayBlockFromAvailabilityJson(availObj, dayOfWeek) {
  const want = AVAILABILITY_DAY_NAMES[dayOfWeek];
  if (availObj[want] != null) return availObj[want];
  const found = Object.keys(availObj).find((k) => k.toLowerCase() === want);
  return found ? availObj[found] : null;
}

function normalizeTimeToHHmm(timeStr) {
  const s = String(timeStr).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${pad2(hh)}:${pad2(mm)}`;
}

function slotFromStartHHmm(hhmm, durationMinutes, capacity = 1) {
  const pad = pad2;
  const [sh, sm] = hhmm.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = startMins + durationMinutes;
  const h = Math.floor(startMins / 60);
  const m = startMins % 60;
  const eh = Math.floor(endMins / 60);
  const em = endMins % 60;
  const hour12 = (hr) => {
    if (hr === 0) return 12;
    if (hr > 12) return hr - 12;
    return hr;
  };
  const ampm = h >= 12 ? 'PM' : 'AM';
  return {
    start: `${pad(h)}:${pad(m)}:00`,
    end: `${pad(eh)}:${pad(em)}:00`,
    slot: `${pad(h)}:${pad(m)}`,
    label: `${hour12(h)}:${pad(m)} ${ampm}`,
    max_bookings_per_slot: Math.max(1, parseInt(capacity, 10) || 1),
  };
}

/**
 * Slots from store_services.availability JSON (explicit time_slots per weekday).
 */
function buildSlotsFromStoreServiceJson(availObj, dayOfWeek, durationMinutes) {
  const day = getDayBlockFromAvailabilityJson(availObj, dayOfWeek);
  if (!day || typeof day !== 'object') return [];
  if (day.available === false) return [];
  const dayCapacity = Math.max(
    1,
    parseInt(day.max_bookings_per_slot ?? day.slot_capacity ?? day.staff_count ?? 1, 10) || 1
  );
  const times = Array.isArray(day.time_slots)
    ? day.time_slots
    : Array.isArray(day.timeSlots)
      ? day.timeSlots
      : [];
  const seen = new Set();
  const slots = [];
  for (const t of times) {
    const hhmm = normalizeTimeToHHmm(t);
    if (!hhmm || seen.has(hhmm)) continue;
    seen.add(hhmm);
    slots.push(slotFromStartHHmm(hhmm, durationMinutes, dayCapacity));
  }
  return slots;
}

/**
 * Weekdays (0=Sun … 6=Sat) that are explicitly bookable in store JSON:
 * key exists, available !== false, and at least one valid time_slots entry.
 * Weekdays omitted from JSON are NOT bookable (no fallback for range walking).
 */
function getBookableWeekdayIndicesFromStoreJson(availObj) {
  const set = new Set();
  if (!availObj || typeof availObj !== 'object') return set;
  for (let dow = 0; dow < 7; dow++) {
    const day = getDayBlockFromAvailabilityJson(availObj, dow);
    if (!day || typeof day !== 'object') continue;
    if (day.available === false) continue;
    const times = Array.isArray(day.time_slots)
      ? day.time_slots
      : Array.isArray(day.timeSlots)
        ? day.timeSlots
        : [];
    let anyValid = false;
    for (const t of times) {
      if (normalizeTimeToHHmm(t)) {
        anyValid = true;
        break;
      }
    }
    if (anyValid) set.add(dow);
  }
  return set;
}

/** Local calendar weekday for YYYY-MM-DD (noon avoids DST midnight edge cases). */
function localDayOfWeekFromYMD(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00');
  return d.getDay();
}

/**
 * Raw slots for one calendar day: prefer StoreService.availability JSON, else booking_availability rows, else default grid.
 */
async function resolveRawSlotsForDay({
  models,
  tenantId,
  serviceId,
  subscriptionPlan,
  dateStr,
  service
}) {
  const durationMinutes = service.duration_minutes || 30;
  const dayOfWeek = localDayOfWeekFromYMD(dateStr);

  const availJson = normalizeServiceAvailabilityColumn(service.availability);
  if (usesStoreServiceAvailabilityJson(availJson)) {
    const slots = buildSlotsFromStoreServiceJson(availJson, dayOfWeek, durationMinutes);
    return { slots, source: 'store_service_json' };
  }

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
    attributes: ['start_time', 'end_time', 'max_bookings_per_slot']
  });

  const slots = buildRawSlotsFromAvailability(availRows, durationMinutes);
  const source = availRows.length ? 'booking_availability' : 'default_hours';
  return { slots, source };
}

/**
 * Get available time slots for a service.
 * Uses BookingAvailability (day_of_week, start_time, end_time) and existing Bookings to compute free slots.
 *
 * GET /api/v1/ai-agent/service-availability
 *
 * Query:
 * - tenant_id (required)
 * - service_id (required)
 * - date (optional) — YYYY-MM-DD. If omitted, returns **mode: "range"**.
 * - subscription_plan (optional)
 * - from (optional, range mode) — anchor date YYYY-MM-DD to start walking forward; default: today (local)
 * - days (optional, range mode) — default 14, max 60:
 *   - If **store_services.availability** JSON is used: **max bookable dates** to return (weekdays that
 *     exist in JSON with `available !== false` and at least one `time_slot`). Other weekdays are **skipped**
 *     (they never appear in `dates`). Walks forward day-by-day until enough bookable days are filled or cap.
 *   - Else (booking_availability / default hours): **calendar window length** in days (unchanged).
 * - include_empty (optional, range mode) — if "true", include bookable weekdays that are **sold out**
 *   (zero free slots after bookings); default false
 */
async function getServiceAvailability(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { tenant_id, service_id, date, subscription_plan, from, days, include_empty } = req.query;
    if (!tenant_id || !service_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id and service_id are required'
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
    const { Op } = require('sequelize');

    const baseUrl = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');
    const toFullImageUrl = (url) => {
      if (!url) return null;
      if (String(url).startsWith('http')) return url;
      return `${baseUrl}${String(url).startsWith('/') ? '' : '/'}${url}`;
    };

    const service = await models.StoreService.findOne({
      where: subscriptionPlan === 'free' ? { id: serviceId, tenant_id: tenantId } : { id: serviceId },
      attributes: ['id', 'service_title', 'duration_minutes', 'availability', 'service_image_url']
    });
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    const durationMinutes = service.duration_minutes || 30;
    const parsedStoreAvailability = normalizeServiceAvailabilityColumn(service.availability);

    // ── Single date (date provided) ─────────────────────────────────────────
    if (date != null && String(date).trim() !== '') {
      const dateStr = String(date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' });
      }

      const { slots, source: availability_source } = await resolveRawSlotsForDay({
        models,
        tenantId,
        serviceId,
        subscriptionPlan,
        dateStr,
        service
      });

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

      const available = filterSlotsByBookings(slots, existingBookings, durationMinutes);

      return res.json({
        success: true,
        mode: 'single',
        date: dateStr,
        service_id: serviceId,
        service_title: service.service_title,
        service_image_url: toFullImageUrl(service.service_image_url) || null,
        duration_minutes: durationMinutes,
        store_service_availability: parsedStoreAvailability,
        availability_source,
        slots: available.map(s => ({ start: s.start, end: s.end, slot: s.slot, label: s.label }))
      });
    }

    // ── Range: no date — return availability per day with date + time slots ──
    let fromStr = (from && String(from).trim()) || todayYMDLocal();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
      return res.status(400).json({ success: false, message: 'from must be YYYY-MM-DD' });
    }

    let numDays = parseInt(days, 10);
    if (Number.isNaN(numDays) || numDays < 1) numDays = 14;
    numDays = Math.min(numDays, 60);

    const includeEmpty = String(include_empty || '').toLowerCase() === 'true';

    const MAX_CALENDAR_DAYS_STORE_SCAN = 120;
    const usesStoreJson = usesStoreServiceAvailabilityJson(parsedStoreAvailability);

    let scanEndStr;
    if (usesStoreJson) {
      scanEndStr = addDaysToYMD(fromStr, MAX_CALENDAR_DAYS_STORE_SCAN - 1);
    } else {
      scanEndStr = addDaysToYMD(fromStr, numDays - 1);
    }

    const rangeStart = new Date(fromStr + 'T00:00:00');
    const rangeEnd = new Date(scanEndStr + 'T23:59:59.999');

    const rangeBookingWhere = {
      service_id: serviceId,
      status: { [Op.notIn]: ['cancelled'] },
      scheduled_at: { [Op.between]: [rangeStart, rangeEnd] }
    };
    if (subscriptionPlan === 'free') {
      rangeBookingWhere.tenant_id = tenantId;
    }
    const rangeBookings = await models.Booking.findAll({
      where: rangeBookingWhere,
      attributes: ['scheduled_at', 'duration_minutes']
    });

    const bookingsByDate = new Map();
    for (const b of rangeBookings) {
      const key = bookingDateKey(b.scheduled_at);
      if (!bookingsByDate.has(key)) bookingsByDate.set(key, []);
      bookingsByDate.get(key).push(b);
    }

    const datesOut = [];
    let totalSlots = 0;
    const sourcesSeen = new Set();

    if (usesStoreJson) {
      const bookableDowSet = getBookableWeekdayIndicesFromStoreJson(parsedStoreAvailability);
      let currentDate = fromStr;
      let calendarSteps = 0;
      let bookableDatesCollected = 0;

      while (bookableDatesCollected < numDays && calendarSteps < MAX_CALENDAR_DAYS_STORE_SCAN) {
        const dow = localDayOfWeekFromYMD(currentDate);

        if (!bookableDowSet.has(dow)) {
          currentDate = addDaysToYMD(currentDate, 1);
          calendarSteps++;
          continue;
        }

        const { slots, source } = await resolveRawSlotsForDay({
          models,
          tenantId,
          serviceId,
          subscriptionPlan,
          dateStr: currentDate,
          service
        });
        sourcesSeen.add(source);

        const dayBookings = bookingsByDate.get(currentDate) || [];
        const available = filterSlotsByBookings(slots, dayBookings, durationMinutes);

        const slotPayload = available.map(s => ({
          date: currentDate,
          weekday: AVAILABILITY_DAY_NAMES[dow],
          start: s.start,
          end: s.end,
          slot: s.slot,
          label: s.label
        }));

        const soldOutBookableDay = slots.length > 0 && slotPayload.length === 0;
        const shouldEmit =
          slotPayload.length > 0 || (includeEmpty && soldOutBookableDay);

        if (shouldEmit) {
          totalSlots += slotPayload.length;
          datesOut.push({
            date: currentDate,
            weekday: AVAILABILITY_DAY_NAMES[dow],
            slots: slotPayload
          });
          bookableDatesCollected++;
        }

        currentDate = addDaysToYMD(currentDate, 1);
        calendarSteps++;
      }

      const availability_source =
        sourcesSeen.size === 1 ? [...sourcesSeen][0] : 'mixed';

      const bookableWeekdayNames = [...bookableDowSet]
        .sort((a, b) => a - b)
        .map((i) => AVAILABILITY_DAY_NAMES[i]);

      const firstReturned = datesOut[0]?.date || null;
      const lastReturned = datesOut.length ? datesOut[datesOut.length - 1].date : null;

      return res.json({
        success: true,
        mode: 'range',
        range_style: 'bookable_dates_from_store_json',
        service_id: serviceId,
        service_title: service.service_title,
        service_image_url: toFullImageUrl(service.service_image_url) || null,
        duration_minutes: durationMinutes,
        store_service_availability: parsedStoreAvailability,
        bookable_weekdays: bookableWeekdayNames,
        scan_anchor: fromStr,
        calendar_days_scanned: calendarSteps,
        from: firstReturned,
        to: lastReturned,
        days: numDays,
        dates_returned: datesOut.length,
        total_slots: totalSlots,
        availability_source,
        dates: datesOut
      });
    }

    // ── Range without store JSON: fixed calendar window (original behaviour) ──
    const toStr = addDaysToYMD(fromStr, numDays - 1);

    for (let i = 0; i < numDays; i++) {
      const dateStr = addDaysToYMD(fromStr, i);
      const dow = localDayOfWeekFromYMD(dateStr);

      const { slots, source } = await resolveRawSlotsForDay({
        models,
        tenantId,
        serviceId,
        subscriptionPlan,
        dateStr,
        service
      });
      sourcesSeen.add(source);

      const dayBookings = bookingsByDate.get(dateStr) || [];
      const available = filterSlotsByBookings(slots, dayBookings, durationMinutes);

      const slotPayload = available.map(s => ({
        date: dateStr,
        weekday: AVAILABILITY_DAY_NAMES[dow],
        start: s.start,
        end: s.end,
        slot: s.slot,
        label: s.label
      }));

      totalSlots += slotPayload.length;

      if (includeEmpty || slotPayload.length > 0) {
        datesOut.push({
          date: dateStr,
          weekday: AVAILABILITY_DAY_NAMES[dow],
          slots: slotPayload
        });
      }
    }

    const availability_source =
      sourcesSeen.size === 1 ? [...sourcesSeen][0] : 'mixed';

    return res.json({
      success: true,
      mode: 'range',
      range_style: 'calendar_window',
      service_id: serviceId,
      service_title: service.service_title,
      service_image_url: toFullImageUrl(service.service_image_url) || null,
      duration_minutes: durationMinutes,
      store_service_availability: parsedStoreAvailability,
      from: fromStr,
      to: toStr,
      days: numDays,
      total_slots: totalSlots,
      availability_source,
      dates: datesOut
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
 * Body: { tenant_id, service_id, scheduled_at, customer_name, customer_phone, customer_email?, subscription_plan?, notes?, status? }
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
      subscription_plan,
      notes,
      status
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
      attributes: ['id', 'store_id', 'service_title', 'description', 'duration_minutes', 'location_type']
    });
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    const at = new Date(scheduled_at);
    if (Number.isNaN(at.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid scheduled_at' });
    }

    // Capacity-safe slot check: ensure selected start time is still available before insert.
    const dateStr = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const { Op } = require('sequelize');
    const dayStart = new Date(dateStr + 'T00:00:00').getTime();
    const dayEnd = new Date(dateStr + 'T23:59:59').getTime();
    const bookingWhere = {
      service_id: serviceId,
      status: { [Op.notIn]: ['cancelled'] },
      scheduled_at: { [Op.gte]: new Date(dayStart), [Op.lte]: new Date(dayEnd) }
    };
    if (subscriptionPlan === 'free') bookingWhere.tenant_id = tenantId;
    const existingBookings = await models.Booking.findAll({
      where: bookingWhere,
      attributes: ['scheduled_at', 'duration_minutes']
    });
    const { slots } = await resolveRawSlotsForDay({
      models, tenantId, serviceId, subscriptionPlan, dateStr, service
    });
    const available = filterSlotsByBookings(slots, existingBookings, service.duration_minutes || 30);
    const requested = available.find(s => s.slot === hhmm);
    if (!requested) {
      return res.status(409).json({
        success: false,
        message: 'Selected slot is no longer available'
      });
    }

    const allowedStatuses = new Set(['pending', 'confirmed']);
    const initialStatus = allowedStatuses.has(String(status || '').toLowerCase())
      ? String(status).toLowerCase()
      : 'pending';

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
      status: initialStatus,
      payment_status: initialStatus === 'confirmed' ? 'approved' : 'unpaid',
      notes: notes ? String(notes).slice(0, 4000) : null
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

/**
 * Attach payment receipt to a booking (service flow).
 * POST /api/v1/ai-agent/attach-booking-receipt
 * Body: { tenant_id, booking_id, receipt_url?: string, receipt_image_base64?: string }
 * Headers: x-api-key
 */
async function attachBookingReceipt(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const { tenant_id, booking_id, receipt_url, receipt_image_base64, mime_type } = req.body || {};
    const tenantId = tenant_id != null ? parseInt(tenant_id, 10) : null;
    const bookingId = booking_id != null ? parseInt(booking_id, 10) : null;
    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }
    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: 'booking_id is required' });
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

    const where = tenant.subscription_plan === 'free'
      ? { id: bookingId, tenant_id: tenantId }
      : { id: bookingId };
    const booking = await models.Booking.findOne({ where });
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    let finalReceiptUrl = receipt_url || null;
    if (receipt_image_base64) {
      const uploadsDir = path.join(__dirname, '..', 'uploads', 'receipts', String(tenantId));
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      const ext = extensionFromMime(mime_type);
      const filename = `booking-${bookingId}-${Date.now()}.${ext}`;
      const filePath = path.join(uploadsDir, filename);
      const buf = Buffer.from(receipt_image_base64, 'base64');
      fs.writeFileSync(filePath, buf);
      finalReceiptUrl = `/uploads/receipts/${tenantId}/${filename}`;
    }

    await booking.update({
      payment_receipt_url: finalReceiptUrl,
      payment_receipt_received_at: new Date(),
      payment_status: 'receipt_uploaded',
    });

    return res.json({
      success: true,
      message: 'Receipt attached to booking',
      data: { booking: await booking.reload(), receipt_url: finalReceiptUrl }
    });
  } catch (error) {
    console.error('attachBookingReceipt error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to attach booking receipt',
      error: error.message
    });
  }
}

/**
 * Confirm or decline booking payment by store owner approval.
 * POST /api/v1/ai-agent/confirm-booking-payment
 * Body: { tenant_id, booking_id, action: 'approve' | 'decline' }
 * Headers: x-api-key
 */
async function confirmBookingPayment(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { tenant_id, booking_id, action } = req.body || {};
    const tenantId = tenant_id != null ? parseInt(tenant_id, 10) : null;
    const bookingId = booking_id != null ? parseInt(booking_id, 10) : null;
    const act = String(action || '').toLowerCase();

    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }
    if (!bookingId || Number.isNaN(bookingId)) {
      return res.status(400).json({ success: false, message: 'booking_id is required' });
    }
    if (!['approve', 'decline'].includes(act)) {
      return res.status(400).json({ success: false, message: 'action must be "approve" or "decline"' });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    const subscriptionPlan = tenant.subscription_plan || 'enterprise';
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);

    const where = subscriptionPlan === 'free'
      ? { id: bookingId, tenant_id: tenantId }
      : { id: bookingId };
    const booking = await models.Booking.findOne({ where });
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (act === 'approve') {
      await booking.update({
        status: 'confirmed',
        payment_status: 'approved',
        payment_approved_at: new Date(),
        payment_declined_at: null,
      });
      return res.json({
        success: true,
        message: 'Booking payment approved and booking confirmed',
        data: { booking: await booking.reload() }
      });
    }

    await booking.update({
      status: 'pending',
      payment_status: 'declined',
      payment_declined_at: new Date(),
    });
    return res.json({
      success: true,
      message: 'Booking payment declined',
      data: { booking: await booking.reload() }
    });
  } catch (error) {
    console.error('confirmBookingPayment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm booking payment',
      error: error.message
    });
  }
}

/**
 * Initialize a payment link for AI sales agent (WhatsApp context aware metadata).
 * POST /api/v1/ai-agent/initialize-payment-link
 * Body: { tenant_id, amount, email?, name?, currency?, callback_url?, metadata? }
 */
async function initializeAIPaymentLink(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const {
      tenant_id, amount, email, name, currency, callback_url, metadata
    } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }
    const amountNum = Number(amount);
    if (!amount || !Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: 'amount is required' });
    }
    const md = {
      ...(metadata || {}),
      source: 'whatsapp_ai',
      channel: 'whatsapp',
      tenant_id: tenantId,
    };
    if (md.whatsapp_message_id == null && req.body?.whatsapp_message_id) {
      md.whatsapp_message_id = req.body.whatsapp_message_id;
    }
    if (md.customer_phone == null && req.body?.customer_phone) {
      md.customer_phone = req.body.customer_phone;
    }

    // Flow-aware payload validation
    const explicitFlow = String(md.flow || '').toLowerCase();
    const looksService = !!(md.service_id || md.scheduled_at || md.booking_type === 'service' || explicitFlow === 'service_booking');
    const looksProduct = !!(md.order_id || md.items || explicitFlow === 'product_order');
    if (looksService && looksProduct) {
      return res.status(400).json({
        success: false,
        message: 'metadata must represent one flow only (product_order OR service_booking)'
      });
    }
    if (!looksService && !looksProduct) {
      return res.status(400).json({
        success: false,
        message: 'metadata.flow must indicate product_order or service_booking (or provide identifying fields)'
      });
    }

    const validationErrors = looksService
      ? validateServiceMetadata(md)
      : validateProductMetadata(md, amountNum);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment payload',
        errors: validationErrors
      });
    }

    if (looksService) {
      md.flow = 'service_booking';
      md.booking_type = 'service';
      md.is_booking = true;
    } else {
      md.flow = 'product_order';
      md.is_booking = false;
    }

    const safeEmail = email || `${String(req.body?.customer_phone || 'customer').replace(/\D/g, '') || 'customer'}@wa.mycroshop.local`;
    const base = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || '').replace(/\/$/, '');
    if (!base) {
      return res.status(500).json({ success: false, message: 'BACKEND_BASE_URL not configured' });
    }
    const payRes = await axios.post(
      `${base}/api/v1/payments/initialize`,
      {
        tenant_id: tenantId,
        amount: amountNum,
        email: safeEmail,
        name: name || 'WhatsApp Customer',
        currency: currency || 'NGN',
        callback_url: callback_url || undefined,
        metadata: md,
      },
      { timeout: 20000 }
    );
    return res.json(payRes.data);
  } catch (error) {
    console.error('initializeAIPaymentLink error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to initialize AI payment link',
      error: error.response?.data?.message || error.message
    });
  }
}

/**
 * Submit refund request from AI/WhatsApp.
 * POST /api/v1/ai-agent/refund-request
 */
async function submitRefundRequest(req, res) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.AI_AGENT_API_KEY) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const body = req.body || {};
    const tenantId = parseInt(body.tenant_id, 10);
    if (!tenantId || Number.isNaN(tenantId)) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }
    if (!body.reason || !String(body.reason).trim()) {
      return res.status(400).json({ success: false, message: 'reason is required' });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    const subscriptionPlan = tenant.subscription_plan || 'enterprise';
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const models = require('../models')(sequelize);

    let verificationStatus = 'unverified';
    const orderId = body.order_id ? parseInt(body.order_id, 10) : null;
    if (orderId && !Number.isNaN(orderId)) {
      const orderWhere = subscriptionPlan === 'free'
        ? { id: orderId, tenant_id: tenantId }
        : { id: orderId };
      const exists = await models.OnlineStoreOrder.findOne({ where: orderWhere, attributes: ['id'] });
      if (exists) verificationStatus = 'verified';
    }
    if (verificationStatus !== 'verified' && body.receipt_id) {
      try {
        const [rows] = await sequelize.query(
          `SELECT id FROM receipts WHERE receipt_number = ? LIMIT 1`,
          { replacements: [String(body.receipt_id)] }
        );
        if (rows && rows.length > 0) verificationStatus = 'verified';
      } catch {
        // receipts table may not exist in some tenants; keep unverified
      }
    }

    const payload = {
      tenant_id: subscriptionPlan === 'free' ? tenantId : null,
      customer_name: body.customer_name || null,
      customer_phone: body.customer_phone || null,
      customer_email: body.customer_email || null,
      order_id: orderId || null,
      receipt_id: body.receipt_id || null,
      source_channel: body.source_channel || 'whatsapp_ai',
      reason: String(body.reason).slice(0, 255),
      details: body.details ? String(body.details).slice(0, 4000) : null,
      verification_status: verificationStatus,
      status: 'submitted',
    };
    const refund = await models.RefundRequest.create(payload);

    const waConn = await getWhatsappConnectionForTenant(tenantId);
    const ownerPhone = waConn?.owner_whatsapp_number;
    if (waConn?.phone_number_id && waConn?.access_token && ownerPhone) {
      await sendWhatsAppTextRaw(
        waConn.phone_number_id,
        waConn.access_token,
        ownerPhone,
        `Refund request submitted (#${refund.id}).\nCustomer: ${payload.customer_name || 'N/A'} (${payload.customer_phone || 'N/A'})\n` +
        `Order ID: ${payload.order_id || 'N/A'}\nReason: ${payload.reason}\nVerification: ${verificationStatus}`
      );
    }

    return res.json({
      success: true,
      message: 'Refund request submitted',
      data: {
        refund_request: refund.toJSON(),
        owner_whatsapp_number: ownerPhone || null,
        verification_status: verificationStatus,
      }
    });
  } catch (error) {
    console.error('submitRefundRequest error:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit refund request', error: error.message });
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
  attachBookingReceipt,
  confirmBookingPayment,
  initializeAIPaymentLink,
  submitRefundRequest,
  listServices,
  getServiceAvailability,
  createBooking
};

