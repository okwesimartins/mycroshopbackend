const axios = require('axios');
const crypto = require('crypto');

/**
 * Get connection status for tenant
 */
async function getConnectionStatus(req, res) {
  try {
    const config = await req.db.models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (!config) {
      return res.json({
        success: true,
        data: {
          whatsapp: { connected: false },
          instagram: { connected: false }
        }
      });
    }

    res.json({
      success: true,
      data: {
        whatsapp: {
          connected: config.whatsapp_enabled && !!config.whatsapp_phone_number_id,
          phoneNumberId: config.whatsapp_phone_number_id,
          phoneNumber: config.whatsapp_phone_number
        },
        instagram: {
          connected: config.instagram_enabled && !!config.instagram_account_id,
          accountId: config.instagram_account_id
        }
      }
    });
  } catch (error) {
    console.error('Error getting connection status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get connection status'
    });
  }
}

/**
 * Initiate WhatsApp connection (OAuth flow)
 */
async function initiateWhatsAppConnection(req, res) {
  try {
    // Generate state for OAuth security
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state in session/config (for production, use Redis or database)
    // For now, we'll include tenant_id in state
    const stateWithTenant = `${state}:${req.user.tenantId}`;
    
    // Meta OAuth URL
    const redirectUri = 'https://mycroshop.com/';
    const appId = process.env.META_APP_ID;
    
    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?` +
      `client_id=${appId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${stateWithTenant}` +
      `&scope=whatsapp_business_management,whatsapp_business_messaging` +
      `&response_type=code`;

    // Store state temporarily (in production, use Redis with expiration)
    // For now, we'll return it and frontend will include it in callback
    
    res.json({
      success: true,
      data: {
        authUrl,
        state: stateWithTenant
      }
    });
  } catch (error) {
    console.error('Error initiating WhatsApp connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate WhatsApp connection'
    });
  }
}

/**
 * Handle WhatsApp OAuth callback
 */



async function metaGet(path, accessToken, params = {}) {
  const url = `https://graph.facebook.com/v18.0/${path}`;
  const res = await axios.get(url, { params: { access_token: accessToken, ...params } });
  return res.data;
}

async function discoverWabaAndPhone(accessToken) {
  // 1) businesses
  const bizRes = await metaGet("me/businesses", accessToken, { fields: "id,name" });
  const businesses = bizRes?.data || [];

  for (const biz of businesses) {
    // 2) owned WABAs under that business
    let wabas = [];
    try {
      const wabaRes = await metaGet(`${biz.id}/owned_whatsapp_business_accounts`, accessToken, { fields: "id,name" });
      wabas = wabaRes?.data || [];
    } catch (_) {
      continue;
    }

    for (const waba of wabas) {
      // 3) phone numbers under WABA
      try {
        const phoneRes = await metaGet(`${waba.id}/phone_numbers`, accessToken, {
          fields: "id,display_phone_number,verified_name,code_verification_status,quality_rating",
        });
        const phones = phoneRes?.data || [];
        if (phones.length) return { wabaId: waba.id, phone: phones[0] };
      } catch (_) {
        continue;
      }
    }
  }

  return { wabaId: null, phone: null };
}

async function handleWhatsAppCallback(req, res) {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ success: false, message: "OAuth failed: Missing code or state", error: "oauth_failed" });
    }

    const stateString = Array.isArray(state) ? state[0] : String(state);
    const parts = stateString.split(":");

    // token:tenantId:phone_number_id:waba_id
    const tenantId = parts[1] || null;
    const hintedPhoneNumberId = parts[2] || null;
    const hintedWabaId = parts[3] || null;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: "Invalid state: tenant_id missing", error: "invalid_state" });
    }

    // IMPORTANT: this must EXACTLY match the redirect URI you configured in Meta app settings
    const redirectUri = process.env.META_REDIRECT_URI || "https://mycroshop.com/";

    // Exchange code for user access token
    const tokenResponse = await axios.get("https://graph.facebook.com/v18.0/oauth/access_token", {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: redirectUri,
        code,
      },
    });

    const accessToken = tokenResponse?.data?.access_token;
    if (!accessToken) {
      return res.status(400).json({ success: false, message: "No access token received", error: "no_access_token" });
    }

    // If embedded signup gave you phone_number_id/waba_id, prefer them
    let wabaId = hintedWabaId;
    let phoneNumberId = hintedPhoneNumberId;
    let phone = null;

    // If we have phone_number_id, try to fetch details directly
    if (phoneNumberId) {
      try {
        phone = await metaGet(`${phoneNumberId}`, accessToken, {
          fields: "id,display_phone_number,verified_name,code_verification_status,quality_rating",
        });
      } catch (_) {
        phone = null;
      }
    }

    // If still missing, discover properly
    if (!phoneNumberId || !phone?.id || !wabaId) {
      const discovered = await discoverWabaAndPhone(accessToken);
      if (!wabaId) wabaId = discovered.wabaId;
      if (!phoneNumberId && discovered.phone?.id) phoneNumberId = discovered.phone.id;
      if (!phone && discovered.phone) phone = discovered.phone;
    }

    if (!phoneNumberId) {
      return res.status(400).json({
        success: false,
        message: "Could not find WhatsApp phone number. Verify the number in WhatsApp Manager and ensure this Meta account owns a WABA with a phone number.",
        error: "no_phone_number_found",
        debug: { hintedPhoneNumberId, hintedWabaId, note: "Your screenshot shows the number is Unverified." },
      });
    }

    // === SAVE TO DB (your existing logic) ===
    const { getTenantById } = require("../config/tenant");
    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: "Tenant not found", error: "tenant_not_found" });

    const subscriptionPlan = tenant.subscription_plan || "enterprise";
    const { getTenantConnection, mainSequelize } = require("../config/database");
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const initializeModels = require("../models");
    const models = initializeModels(sequelize);

    // Encrypt token if util exists
    let encryptedToken = accessToken;
    try {
      const { encrypt } = require("../utils/encryption");
      if (typeof encrypt === "function") encryptedToken = encrypt(accessToken);
    } catch (_) {}

    // Upsert tenant DB connection record
    await models.WhatsAppConnection.upsert({
      ...(subscriptionPlan === "free" && { tenant_id: tenantId }),
      phone_number_id: phoneNumberId,
      waba_id: wabaId || null,
      access_token: encryptedToken,
    });

    // Optional: main DB lookup table (phone_number_id -> tenant)
    try {
      await mainSequelize.query(
        `
        INSERT INTO whatsapp_connections (tenant_id, phone_number_id, waba_id, access_token, connected_at, updated_at)
        VALUES (?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          waba_id = VALUES(waba_id),
          access_token = VALUES(access_token),
          updated_at = NOW()
        `,
        { replacements: [tenantId, phoneNumberId, wabaId || null, encryptedToken] }
      );
    } catch (e) {
      // don't fail the whole flow
      console.error("Main DB store failed:", e.message);
    }

    return res.json({
      success: true,
      message: "WhatsApp connected successfully",
      data: {
        tenant_id: tenantId,
        phone_number_id: phoneNumberId,
        phone_number: phone?.display_phone_number || phone?.verified_name || null,
        waba_id: wabaId || null,
      },
    });
  } catch (error) {
    console.error("WhatsApp callback error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to connect WhatsApp",
      error: "connection_failed",
      details: error.response?.data || error.message,
    });
  }
}





/**
 * Initiate Instagram connection
 */
async function initiateInstagramConnection(req, res) {
  try {
    const state = crypto.randomBytes(32).toString('hex');
    const stateWithTenant = `${state}:${req.user.tenantId}`;
    
    const redirectUri = 'https://mycroshop.com/';
    const appId = process.env.META_APP_ID;
    
    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?` +
      `client_id=${appId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${stateWithTenant}` +
      `&scope=instagram_basic,instagram_manage_messages,pages_show_list` +
      `&response_type=code`;

    res.json({
      success: true,
      data: {
        authUrl,
        state: stateWithTenant
      }
    });
  } catch (error) {
    console.error('Error initiating Instagram connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate Instagram connection'
    });
  }
}

/**
 * Handle Instagram OAuth callback
 */
async function handleInstagramCallback(req, res) {
  try {
    const { code, state } = req.query;
    
    if (!code || !state) {
      return res.status(400).json({
        success: false,
        message: 'OAuth failed: Missing code or state parameter',
        error: 'oauth_failed'
      });
    }

    // Normalize state - Express query params can be arrays or strings
    // If it's an array, take the first element; if it's already a string, use it
    const stateString = Array.isArray(state) ? state[0] : String(state);
    
    // Validate state is not empty
    if (!stateString || !stateString.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Invalid state parameter: state is empty',
        error: 'invalid_state_format'
      });
    }

    // Extract tenant_id from state
    const stateParts = stateString.split(':');
    
    if (stateParts.length < 2 || !stateParts[1]) {
      return res.status(400).json({
        success: false,
        message: 'Invalid state parameter: tenant_id not found in state',
        error: 'invalid_state'
      });
    }

    const [stateToken, tenantId] = stateParts;
    
    if (!tenantId || !tenantId.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Invalid state parameter: tenant_id is empty',
        error: 'invalid_state'
      });
    }
    
    const redirectUri = 'https://mycroshop.com/';
    
    let tokenResponse;
    try {
      tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
        params: {
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          redirect_uri: redirectUri,
          code: code
        }
      });
    } catch (error) {
      console.error('Error exchanging OAuth code for token:', error.response?.data || error.message);
      return res.status(400).json({
        success: false,
        message: 'Failed to exchange OAuth code for access token',
        error: 'token_exchange_failed',
        details: error.response?.data || error.message
      });
    }

    const accessToken = tokenResponse.data.access_token;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: 'No access token received from Meta',
        error: 'no_access_token'
      });
    }

    // Get Instagram Business Account
    let pagesResponse;
    try {
      pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
        params: {
          access_token: accessToken
        }
      });
    } catch (error) {
      console.error('Error fetching pages:', error.response?.data || error.message);
      return res.status(400).json({
        success: false,
        message: 'Failed to fetch Facebook pages',
        error: 'pages_fetch_failed',
        details: error.response?.data || error.message
      });
    }

    // Find Instagram account connected to page
    let instagramAccountId = null;
    try {
      for (const page of pagesResponse.data.data || []) {
        const instagramResponse = await axios.get(`https://graph.facebook.com/v18.0/${page.id}`, {
          params: {
            fields: 'instagram_business_account',
            access_token: accessToken
          }
        });
        
        if (instagramResponse.data.instagram_business_account) {
          instagramAccountId = instagramResponse.data.instagram_business_account.id;
          break;
        }
      }
    } catch (error) {
      console.error('Error fetching Instagram account:', error.response?.data || error.message);
      return res.status(400).json({
        success: false,
        message: 'Failed to fetch Instagram Business Account',
        error: 'instagram_account_fetch_failed',
        details: error.response?.data || error.message
      });
    }

    if (!instagramAccountId) {
      return res.status(400).json({
        success: false,
        message: 'No Instagram Business Account found. Please ensure your Instagram account is connected to a Facebook Page.',
        error: 'no_instagram_account'
      });
    }

    // Get tenant info to determine subscription plan
    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenantId);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
        error: 'tenant_not_found'
      });
    }

    const subscriptionPlan = tenant.subscription_plan || 'enterprise';

    // Get tenant database connection (handles both free and enterprise)
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const initializeModels = require('../models');
    const models = initializeModels(sequelize);

    // Update or create AI agent config
    let config = await models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (!config) {
      config = await models.AIAgentConfig.create({
        instagram_enabled: true,
        instagram_account_id: instagramAccountId,
        instagram_access_token: accessToken
      });
    } else {
      await config.update({
        instagram_enabled: true,
        instagram_account_id: instagramAccountId,
        instagram_access_token: accessToken
      });
    }

    // Return success JSON response
    return res.json({
      success: true,
      message: 'Instagram connected successfully',
      data: {
        tenant_id: tenantId,
        instagram_account_id: instagramAccountId,
        connected: true
      }
    });
  } catch (error) {
    console.error('Error handling Instagram callback:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to connect Instagram',
      error: 'connection_failed',
      details: error.message
    });
  }
}

/**
 * Disconnect WhatsApp
 */
async function disconnectWhatsApp(req, res) {
  try {
    const config = await req.db.models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (config) {
      await config.update({
        whatsapp_enabled: false,
        whatsapp_phone_number_id: null,
        whatsapp_phone_number: null,
        whatsapp_access_token: null
      });
    }

    res.json({
      success: true,
      message: 'WhatsApp disconnected successfully'
    });
  } catch (error) {
    console.error('Error disconnecting WhatsApp:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to disconnect WhatsApp'
    });
  }
}

/**
 * Disconnect Instagram
 */
async function disconnectInstagram(req, res) {
  try {
    const config = await req.db.models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (config) {
      await config.update({
        instagram_enabled: false,
        instagram_account_id: null,
        instagram_access_token: null
      });
    }

    res.json({
      success: true,
      message: 'Instagram disconnected successfully'
    });
  } catch (error) {
    console.error('Error disconnecting Instagram:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to disconnect Instagram'
    });
  }
}

/**
 * Test WhatsApp connection
 */
async function testWhatsAppConnection(req, res) {
  try {
    const config = await req.db.models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (!config || !config.whatsapp_enabled || !config.whatsapp_access_token) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp not connected'
      });
    }

    // Test by getting phone number info
    const response = await axios.get(`https://graph.facebook.com/v18.0/${config.whatsapp_phone_number_id}`, {
      params: {
        access_token: config.whatsapp_access_token
      }
    });

    res.json({
      success: true,
      message: 'WhatsApp connection is active',
      data: {
        phoneNumber: response.data.display_phone_number,
        verified: response.data.verified_name
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'WhatsApp connection test failed',
      error: error.response?.data || error.message
    });
  }
}

/**
 * Test Instagram connection
 */
async function testInstagramConnection(req, res) {
  try {
    const config = await req.db.models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (!config || !config.instagram_enabled || !config.instagram_access_token) {
      return res.status(400).json({
        success: false,
        message: 'Instagram not connected'
      });
    }

    // Test by getting account info
    const response = await axios.get(`https://graph.facebook.com/v18.0/${config.instagram_account_id}`, {
      params: {
        fields: 'username,profile_picture_url',
        access_token: config.instagram_access_token
      }
    });

    res.json({
      success: true,
      message: 'Instagram connection is active',
      data: {
        username: response.data.username,
        profilePicture: response.data.profile_picture_url
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Instagram connection test failed',
      error: error.response?.data || error.message
    });
  }
}

module.exports = {
  getConnectionStatus,
  initiateWhatsAppConnection,
  handleWhatsAppCallback,
  initiateInstagramConnection,
  handleInstagramCallback,
  disconnectWhatsApp,
  disconnectInstagram,
  testWhatsAppConnection,
  testInstagramConnection
};

