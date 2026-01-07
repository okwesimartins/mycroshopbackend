const axios = require('axios');
const crypto = require('crypto');

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
        instagram_enabled: false,
        auto_reply_enabled: true
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
      auto_reply_enabled,
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
        auto_reply_enabled: auto_reply_enabled !== undefined ? auto_reply_enabled : true,
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
        ...(auto_reply_enabled !== undefined && { auto_reply_enabled }),
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

    const { name, tenant_id } = req.query;

    if (!name || !tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Product name and tenant_id are required'
      });
    }

    // Get tenant database connection
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenant_id);
    const models = require('../models')(sequelize);

    // Search for product
    const product = await models.Product.findOne({
      where: {
        [sequelize.Sequelize.Op.or]: [
          { name: { [sequelize.Sequelize.Op.like]: `%${name}%` } },
          { sku: { [sequelize.Sequelize.Op.like]: `%${name}%` } }
        ],
        is_active: true
      }
    });

    if (!product) {
      return res.json({
        success: true,
        exists: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      exists: true,
      product: {
        id: product.id,
        name: product.name,
        price: product.price,
        stock: product.stock,
        available: product.stock > 0
      }
    });
  } catch (error) {
    console.error('Error checking product:', error);
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

    const { product_id, tenant_id } = req.query;

    if (!product_id || !tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Product ID and tenant_id are required'
      });
    }

    // Get tenant database connection
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenant_id);
    const models = require('../models')(sequelize);

    const product = await models.Product.findByPk(product_id);

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
        category: product.category
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

module.exports = {
  handleWebhook,
  getConfig,
  updateConfig,
  checkProduct,
  getProductInfo
};

