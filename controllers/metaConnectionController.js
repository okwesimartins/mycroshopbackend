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
    res.status(500).json({
      success: false,
      message: 'Failed to get connection status'
    });
  }
}

/**
 * Initiate WhatsApp connection using OAuth flow
 * Note: Embedded Signup requires Solution Partner/Tech Provider status which may not be available yet.
 * OAuth flow works in test mode and uses the correct 3-step discovery: /me/businesses → /{business-id}/owned_whatsapp_business_accounts → /{waba-id}/phone_numbers
 */
async function initiateWhatsAppConnection(req, res) {
  try {
    // Generate state for OAuth security
    const state = crypto.randomBytes(32).toString('hex');
    const stateWithTenant = `${state}:${req.user.tenantId}`;
    
    // Meta OAuth URL with required permissions
    const redirectUri = 'https://mycroshop.com';
    const appId = process.env.META_APP_ID;
    
    // OAuth URL with business_management permission (required for WABA discovery)
    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?` +
      `client_id=${appId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${stateWithTenant}` +
      `&scope=business_management,whatsapp_business_management,whatsapp_business_messaging` +
      `&response_type=code`;
    
    res.json({
      success: true,
      data: {
        authUrl,
        state: stateWithTenant,
        method: 'oauth',
        note: 'OAuth flow works in test mode. After authorization, the callback will use the 3-step discovery flow to find WABA and phone numbers.'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to initiate WhatsApp connection',
      error: error.message
    });
  }
}

/**
 * Handle WhatsApp callback - supports both Embedded Signup and OAuth flow
 * Embedded Signup: Returns waba_id and phone_number_id directly (requires Solution Partner/Tech Provider)
 * OAuth: Uses 3-step discovery flow (works in test mode)
 */
async function handleWhatsAppCallback(req, res) {
  try {
    // Check for both Embedded Signup and OAuth parameters
    const { waba_id, phone_number_id, code, state, error, error_description } = req.query;
    
    // Check for errors from Meta
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp connection failed',
        error: 'connection_failed',
        details: {
          error,
          error_description
        },
        note: 'If you see this error with Embedded Signup, you may need Solution Partner/Tech Provider status. Try using OAuth flow instead.'
      });
    }
    
    // EMBEDDED SIGNUP FLOW - Returns waba_id and phone_number_id directly!
    // This only works if you're a Solution Partner or Tech Provider
    if (waba_id && phone_number_id) {
      // Extract tenant_id from state
      const stateString = Array.isArray(state) ? state[0] : String(state);
      const stateParts = stateString.split(':');
      
      if (stateParts.length < 2 || !stateParts[1]) {
        return res.status(400).json({
          success: false,
          message: 'Invalid state parameter: tenant_id not found',
          error: 'invalid_state'
        });
      }
      
      const tenantId = parseInt(stateParts[1]);
      
      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message: 'Invalid tenant_id in state',
          error: 'invalid_tenant_id'
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
      
      // Get tenant database connection
      const { getTenantConnection } = require('../config/database');
      const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
      const initializeModels = require('../models');
      const models = initializeModels(sequelize);
      
      // Get access token for this WABA (use App Access Token - in production, use System User token)
      const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
      
      // Get phone number details
      let phoneNumber = null;
      try {
        const phoneResponse = await axios.get(`https://graph.facebook.com/v18.0/${phone_number_id}`, {
          params: {
            access_token: appAccessToken,
            fields: 'display_phone_number,verified_name'
          }
        });
        phoneNumber = phoneResponse.data;
      } catch (phoneError) {
        // Continue even if phone details fail
      }
      
      // Encrypt access token before storing
      let encryptedToken = appAccessToken;
      try {
        const { encrypt } = require('../utils/encryption');
        if (encrypt) {
          encryptedToken = encrypt(appAccessToken);
        }
      } catch (e) {
        // Encryption utility not available
      }
      
      // Store connection in tenant database
      await models.WhatsAppConnection.upsert({
        ...(subscriptionPlan === 'free' && { tenant_id: tenantId }),
        phone_number_id: phone_number_id,
        waba_id: waba_id,
        access_token: encryptedToken
      });
      
      // Update AI agent config
      let config = await models.AIAgentConfig.findOne({
        where: {},
        order: [['created_at', 'DESC']]
      });
      
      if (!config) {
        config = await models.AIAgentConfig.create({
          whatsapp_enabled: true,
          whatsapp_phone_number_id: phone_number_id,
          whatsapp_phone_number: phoneNumber?.display_phone_number || phoneNumber?.verified_name || null,
          whatsapp_access_token: encryptedToken
        });
      } else {
        await config.update({
          whatsapp_enabled: true,
          whatsapp_phone_number_id: phone_number_id,
          whatsapp_phone_number: phoneNumber?.display_phone_number || phoneNumber?.verified_name || null,
          whatsapp_access_token: encryptedToken
        });
      }
      
      // Also store in main database for AI agent lookup
      try {
        const { mainSequelize } = require('../config/database');
        await mainSequelize.query(`
          INSERT INTO whatsapp_connections 
          (tenant_id, phone_number_id, waba_id, access_token, connected_at, updated_at)
          VALUES (?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
          waba_id = VALUES(waba_id),
          access_token = VALUES(access_token),
          updated_at = NOW()
        `, {
          replacements: [tenantId, phone_number_id, waba_id, encryptedToken]
        });
      } catch (error) {
        // Don't fail if this fails - it's for AI agent lookup only
      }
      
      return res.json({
        success: true,
        message: 'WhatsApp connected successfully via Embedded Signup',
        data: {
          tenant_id: tenantId,
          waba_id: waba_id,
          phone_number_id: phone_number_id,
          phone_number: phoneNumber?.display_phone_number || phoneNumber?.verified_name || null,
          connected: true,
          method: 'embedded_signup'
        }
      });
    }
    
    // OAUTH FLOW - Fallback if Embedded Signup is not available
    // This works in test mode and uses the correct 3-step discovery flow
    if (code && state) {
      // Normalize state
      const stateString = Array.isArray(state) ? state[0] : String(state);
      
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
      
      // Exchange code for access token
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

      // First, verify token permissions
      let tokenPermissions = [];
      let tokenInfo = null;
      try {
        const debugTokenResponse = await axios.get('https://graph.facebook.com/v18.0/debug_token', {
          params: {
            input_token: accessToken,
            access_token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
          }
        });
        tokenInfo = debugTokenResponse.data.data;
        tokenPermissions = tokenInfo?.scopes || [];
      } catch (debugError) {
        // Continue even if debug fails
      }

      // Use the correct 3-step discovery flow: /me/businesses → /{business-id}/owned_whatsapp_business_accounts → /{waba-id}/phone_numbers
      let wabaId = null;
      let phoneNumberId = null;
      let phoneNumber = null;
      let lastError = null;
      let discoverySteps = [];
      
      try {
        // Step 1: Get businesses the user manages
        discoverySteps.push('Step 1: GET /me/businesses');
        const businessesResponse = await axios.get('https://graph.facebook.com/v18.0/me/businesses', {
          params: {
            access_token: accessToken,
            fields: 'id,name'
          }
        });
        
        discoverySteps.push(`Step 1: Found ${businessesResponse.data.data?.length || 0} businesses`);
        
        if (businessesResponse.data.data && businessesResponse.data.data.length > 0) {
          // Step 2: For each business, get owned WABAs
          for (const business of businessesResponse.data.data) {
            try {
              discoverySteps.push(`Step 2: GET /${business.id}/owned_whatsapp_business_accounts`);
              const ownedWabaResponse = await axios.get(`https://graph.facebook.com/v18.0/${business.id}/owned_whatsapp_business_accounts`, {
                params: {
                  access_token: accessToken,
                  fields: 'id,name'
                }
              });
              
              discoverySteps.push(`Step 2: Found ${ownedWabaResponse.data.data?.length || 0} WABAs for business ${business.id}`);
              
              if (ownedWabaResponse.data.data && ownedWabaResponse.data.data.length > 0) {
                // Step 3: Get phone numbers for the first WABA found
                const waba = ownedWabaResponse.data.data[0];
                wabaId = waba.id;
                
                try {
                  discoverySteps.push(`Step 3: GET /${waba.id}/phone_numbers`);
                  const phoneNumbersResponse = await axios.get(`https://graph.facebook.com/v18.0/${waba.id}/phone_numbers`, {
                    params: {
                      access_token: accessToken,
                      fields: 'id,display_phone_number,verified_name'
                    }
                  });
                  
                  discoverySteps.push(`Step 3: Found ${phoneNumbersResponse.data.data?.length || 0} phone numbers for WABA ${waba.id}`);
                  
                  if (phoneNumbersResponse.data.data && phoneNumbersResponse.data.data.length > 0) {
                    phoneNumber = phoneNumbersResponse.data.data[0];
                    phoneNumberId = phoneNumber.id;
                    break; // Found phone number, exit loop
                  }
                } catch (phoneError) {
                  const phoneErrorDetails = phoneError.response?.data || { message: phoneError.message };
                  lastError = phoneErrorDetails;
                  discoverySteps.push(`Step 3 ERROR: ${JSON.stringify(phoneErrorDetails)}`);
                  // Continue to next business
                }
              }
            } catch (wabaError) {
              const wabaErrorDetails = wabaError.response?.data || { message: wabaError.message };
              if (!lastError) {
                lastError = wabaErrorDetails;
              }
              discoverySteps.push(`Step 2 ERROR for business ${business.id}: ${JSON.stringify(wabaErrorDetails)}`);
              // Continue to next business
            }
            if (phoneNumberId) break; // Found phone number, exit outer loop
          }
        } else {
          discoverySteps.push('Step 1: No businesses found - user may not have a Meta Business Account');
        }
      } catch (businessesError) {
        const businessesErrorDetails = businessesError.response?.data || { message: businessesError.message };
        lastError = businessesErrorDetails;
        discoverySteps.push(`Step 1 ERROR: ${JSON.stringify(businessesErrorDetails)}`);
      }

      // If 3-step flow failed, try alternative: direct app-level WABA access (for test mode)
      if (!phoneNumberId) {
        try {
          discoverySteps.push('Fallback: Trying app-level WABA access');
          const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
          
          const appWabaResponse = await axios.get(`https://graph.facebook.com/v18.0/${process.env.META_APP_ID}`, {
            params: {
              access_token: appAccessToken,
              fields: 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
            }
          });
          
          if (appWabaResponse.data.whatsapp_business_accounts && appWabaResponse.data.whatsapp_business_accounts.data) {
            const waba = appWabaResponse.data.whatsapp_business_accounts.data[0];
            wabaId = waba.id;
            
            if (waba.phone_numbers && waba.phone_numbers.data && waba.phone_numbers.data.length > 0) {
              phoneNumber = waba.phone_numbers.data[0];
              phoneNumberId = phoneNumber.id;
              discoverySteps.push(`Fallback SUCCESS: Found WABA ${wabaId} and phone number ${phoneNumberId} via app-level access`);
            }
          }
        } catch (fallbackError) {
          const fallbackErrorDetails = fallbackError.response?.data || { message: fallbackError.message };
          if (!lastError) {
            lastError = fallbackErrorDetails;
          }
          discoverySteps.push(`Fallback ERROR: ${JSON.stringify(fallbackErrorDetails)}`);
        }
      }

      if (!phoneNumberId) {
        return res.status(400).json({
          success: false,
          message: 'Could not find WhatsApp phone number',
          error: 'no_phone_number_found',
          details: {
            token_permissions: tokenPermissions,
            required_permissions: ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'],
            has_required_permissions: tokenPermissions.includes('business_management') && 
                                     tokenPermissions.includes('whatsapp_business_management') && 
                                     tokenPermissions.includes('whatsapp_business_messaging'),
            last_error: lastError,
            discovery_steps: discoverySteps,
            troubleshooting: [
              '1. Ensure you granted ALL permissions during OAuth: business_management, whatsapp_business_management, whatsapp_business_messaging',
              '2. Verify your Meta Business Account has a WhatsApp Business Account set up',
              '3. Check that the WhatsApp Business Account has a phone number assigned',
              '4. In test mode, ensure your app has a test phone number assigned in WhatsApp Manager',
              '5. Try the manual connection endpoint if automatic discovery fails: POST /api/v1/meta-connection/whatsapp/manual-connect'
            ]
          },
          help: 'No WhatsApp Business Account or phone number found. Ensure your Meta Business Account has a WhatsApp Business Account with a phone number assigned.'
        });
      }

      // Get tenant info to determine subscription plan
      const parsedTenantId = parseInt(tenantId);
      const { getTenantById } = require('../config/tenant');
      const tenant = await getTenantById(parsedTenantId);
      
      if (!tenant) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found',
          error: 'tenant_not_found'
        });
      }
      
      const subscriptionPlan = tenant.subscription_plan || 'enterprise';
      
      // Get tenant database connection
      const { getTenantConnection } = require('../config/database');
      const sequelize = await getTenantConnection(parsedTenantId, subscriptionPlan);
      const initializeModels = require('../models');
      const models = initializeModels(sequelize);
      
      // Encrypt access token before storing
      let encryptedToken = accessToken;
      try {
        const { encrypt } = require('../utils/encryption');
        if (encrypt) {
          encryptedToken = encrypt(accessToken);
        }
      } catch (e) {
        // Encryption utility not available
      }
      
      // Store connection in tenant database
      await models.WhatsAppConnection.upsert({
        ...(subscriptionPlan === 'free' && { tenant_id: parsedTenantId }),
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        access_token: encryptedToken
      });
      
      // Update AI agent config
      let config = await models.AIAgentConfig.findOne({
        where: {},
        order: [['created_at', 'DESC']]
      });
      
      if (!config) {
        config = await models.AIAgentConfig.create({
          whatsapp_enabled: true,
          whatsapp_phone_number_id: phoneNumberId,
          whatsapp_phone_number: phoneNumber?.display_phone_number || phoneNumber?.verified_name || null,
          whatsapp_access_token: encryptedToken
        });
      } else {
        await config.update({
          whatsapp_enabled: true,
          whatsapp_phone_number_id: phoneNumberId,
          whatsapp_phone_number: phoneNumber?.display_phone_number || phoneNumber?.verified_name || null,
          whatsapp_access_token: encryptedToken
        });
      }
      
      // Also store in main database for AI agent lookup
      try {
        const { mainSequelize } = require('../config/database');
        await mainSequelize.query(`
          INSERT INTO whatsapp_connections 
          (tenant_id, phone_number_id, waba_id, access_token, connected_at, updated_at)
          VALUES (?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
          waba_id = VALUES(waba_id),
          access_token = VALUES(access_token),
          updated_at = NOW()
        `, {
          replacements: [parsedTenantId, phoneNumberId, wabaId, encryptedToken]
        });
      } catch (error) {
        // Don't fail if this fails - it's for AI agent lookup only
      }
      
      return res.json({
        success: true,
        message: 'WhatsApp connected successfully via OAuth',
        data: {
          tenant_id: parsedTenantId,
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          phone_number: phoneNumber?.display_phone_number || phoneNumber?.verified_name || null,
          connected: true,
          method: 'oauth'
        }
      });
    }
    
    // If we reach here, neither Embedded Signup nor OAuth provided required parameters
    return res.status(400).json({
      success: false,
      message: 'WhatsApp connection failed: Missing required parameters',
      error: 'missing_parameters',
      help: 'Embedded Signup requires Solution Partner/Tech Provider status. If not available, use OAuth flow which works in test mode. Ensure you grant business_management, whatsapp_business_management, and whatsapp_business_messaging permissions during OAuth.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to connect WhatsApp',
      error: 'connection_failed',
      details: error.message
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
    
    const redirectUri = 'https://mycroshop.com';
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
    
    const redirectUri = 'https://mycroshop.com';
    
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
    res.status(500).json({
      success: false,
      message: 'Failed to disconnect Instagram'
    });
  }
}

/**
 * Verify OAuth token and check WABA access
 * This helps diagnose if OAuth worked and WABA is accessible
 * Accepts either 'code' (OAuth authorization code) or 'access_token'
 */
async function verifyOAuthToken(req, res) {
  try {
    const { access_token, code, state } = req.body;
    
    if (!access_token && !code) {
      return res.status(400).json({
        success: false,
        message: 'Either access_token or code is required',
        error: 'missing_token_or_code',
        help: 'If you have the OAuth callback URL, use the "code" parameter. If you already have an access token, use "access_token" parameter.'
      });
    }

    // Detect if access_token is actually a code (OAuth codes typically start with "AQC")
    const isCodePattern = /^AQC/i;
    const looksLikeCode = (token) => token && typeof token === 'string' && isCodePattern.test(token);
    
    // Determine what was provided
    const hasCodeParam = !!code;
    const hasAccessTokenParam = !!access_token;
    const accessTokenIsCode = hasAccessTokenParam && looksLikeCode(access_token);
    
    // Priority: explicit code param > access_token that looks like code > actual access_token
    const providedCode = code || (accessTokenIsCode ? access_token : null);
    const providedAccessToken = hasAccessTokenParam && !accessTokenIsCode ? access_token : null;

    let finalAccessToken = null;
    let tokenSource = 'unknown';

    // If code is provided (either as 'code' param or detected in 'access_token'), exchange it
    if (providedCode) {
      try {
        const redirectUri = 'https://mycroshop.com/';
        const tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
          params: {
            client_id: process.env.META_APP_ID,
            client_secret: process.env.META_APP_SECRET,
            redirect_uri: redirectUri,
            code: providedCode
          }
        });

        if (!tokenResponse.data || !tokenResponse.data.access_token) {
          return res.status(400).json({
            success: false,
            message: 'Failed to exchange code for access token',
            error: 'token_exchange_failed',
            details: tokenResponse.data || { message: 'No response data' },
            help: 'The response from Meta did not include an access_token. The code may be invalid, expired, or already used.',
            detected_input: {
              provided_code: providedCode.substring(0, 20) + '...',
              code_length: providedCode.length
            }
          });
        }

        finalAccessToken = tokenResponse.data.access_token;
        tokenSource = 'exchanged_from_code';
      } catch (exchangeError) {
        const errorDetails = exchangeError.response?.data || { message: exchangeError.message };
        return res.status(400).json({
          success: false,
          message: 'Failed to exchange OAuth code for access token',
          error: 'code_exchange_failed',
          details: errorDetails,
          help: 'The OAuth code may have expired (codes are single-use and expire quickly, usually within 10 minutes). Complete the OAuth flow again to get a new code.',
          detected_as_code: true,
          note: 'The value you provided appears to be an OAuth code (starts with "AQC"), not an access token. Codes must be exchanged for access tokens first.',
          meta_error_code: errorDetails.error?.code,
          meta_error_message: errorDetails.error?.message
        });
      }
    } else if (providedAccessToken) {
      // Use provided access token directly
      finalAccessToken = providedAccessToken;
      tokenSource = 'provided_directly';
    }

    // If we still don't have a token, return error
    if (!finalAccessToken) {
      return res.status(400).json({
        success: false,
        message: 'No valid access token available',
        error: 'missing_access_token',
        help: 'Provide either a valid access_token or an OAuth code (starts with "AQC"). If you have a code, it will be automatically exchanged for an access token.',
        detected_input: {
          has_code_param: hasCodeParam,
          has_access_token_param: hasAccessTokenParam,
          access_token_looks_like_code: accessTokenIsCode,
          provided_code: providedCode ? providedCode.substring(0, 20) + '...' : null,
          provided_access_token: providedAccessToken ? providedAccessToken.substring(0, 20) + '...' : null
        }
      });
    }

    // Check token permissions
    let tokenPermissions = null;
    let tokenInfo = null;
    try {
      const debugTokenResponse = await axios.get('https://graph.facebook.com/v18.0/debug_token', {
        params: {
          input_token: finalAccessToken,
          access_token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
        }
      });
      tokenInfo = debugTokenResponse.data.data;
      tokenPermissions = tokenInfo?.scopes || [];
    } catch (debugError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid access token',
        error: 'invalid_token',
        details: debugError.response?.data || { message: debugError.message },
        help: 'If you used a code, it may have expired. OAuth codes are single-use and expire quickly. Complete the OAuth flow again to get a new code.'
      });
    }

    // Try to get WABAs via user token
    // Note: whatsapp_business_accounts is not available on User node directly
    // We need to access it through businesses or app endpoints
    let wabas = [];
    let wabaError = null;
    let triedEndpoints = [];

    // Method 1: Try through businesses endpoint
    try {
      triedEndpoints.push('/me/businesses');
      const businessesResponse = await axios.get('https://graph.facebook.com/v18.0/me/businesses', {
        params: {
          access_token: finalAccessToken,
          fields: 'id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
        }
      });
      
      if (businessesResponse.data.data && businessesResponse.data.data.length > 0) {
        for (const business of businessesResponse.data.data) {
          if (business.whatsapp_business_accounts && business.whatsapp_business_accounts.data) {
            for (const waba of business.whatsapp_business_accounts.data) {
              wabas.push({
                id: waba.id,
                name: waba.name,
                phone_numbers_count: waba.phone_numbers?.data?.length || 0,
                phone_numbers: waba.phone_numbers?.data?.map(p => ({
                  id: p.id,
                  display_phone_number: p.display_phone_number,
                  verified_name: p.verified_name
                })) || []
              });
            }
          }
        }
      }
    } catch (error) {
      wabaError = error.response?.data || { message: error.message };
    }

    // Method 2: Try through app endpoint (if user has access to app's WABAs)
    if (wabas.length === 0) {
      try {
        triedEndpoints.push(`/${process.env.META_APP_ID}`);
        const appWabaResponse = await axios.get(`https://graph.facebook.com/v18.0/${process.env.META_APP_ID}`, {
          params: {
            access_token: finalAccessToken,
            fields: 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
          }
        });
        
        if (appWabaResponse.data.whatsapp_business_accounts && appWabaResponse.data.whatsapp_business_accounts.data) {
          for (const waba of appWabaResponse.data.whatsapp_business_accounts.data) {
            wabas.push({
              id: waba.id,
              name: waba.name,
              phone_numbers_count: waba.phone_numbers?.data?.length || 0,
              phone_numbers: waba.phone_numbers?.data?.map(p => ({
                id: p.id,
                display_phone_number: p.display_phone_number,
                verified_name: p.verified_name
              })) || []
            });
          }
        }
      } catch (error) {
        if (!wabaError) {
          wabaError = error.response?.data || { message: error.message };
        }
      }
    }

    // Method 3: Try direct whatsapp_business_accounts endpoint (usually doesn't work for User nodes)
    if (wabas.length === 0) {
      try {
        triedEndpoints.push('/me/whatsapp_business_accounts');
        const wabaDirectResponse = await axios.get('https://graph.facebook.com/v18.0/me/whatsapp_business_accounts', {
          params: {
            access_token: finalAccessToken,
            fields: 'id,name,phone_numbers{id,display_phone_number,verified_name}'
          }
        });
        
        if (wabaDirectResponse.data.data && wabaDirectResponse.data.data.length > 0) {
          for (const waba of wabaDirectResponse.data.data) {
            wabas.push({
              id: waba.id,
              name: waba.name,
              phone_numbers_count: waba.phone_numbers?.data?.length || 0,
              phone_numbers: waba.phone_numbers?.data?.map(p => ({
                id: p.id,
                display_phone_number: p.display_phone_number,
                verified_name: p.verified_name
              })) || []
            });
          }
        }
      } catch (error) {
        if (!wabaError) {
          wabaError = error.response?.data || { message: error.message };
        }
      }
    }

    return res.json({
      success: true,
      message: 'OAuth token verification complete',
      data: {
        token_valid: true,
        token_permissions: tokenPermissions,
        has_whatsapp_permissions: tokenPermissions.includes('whatsapp_business_management') && tokenPermissions.includes('whatsapp_business_messaging'),
        wabas_found: wabas.length,
        wabas: wabas,
        waba_error: wabaError,
        verification_status: wabas.length > 0 
          ? '✅ SUCCESS: WABA(s) accessible via OAuth token. OAuth flow worked correctly!'
          : '❌ FAILED: No WABAs found. The whatsapp_business_accounts field is not available on User nodes - this is a Meta API limitation.',
        next_steps: wabas.length > 0
          ? 'WABA is accessible. If phone numbers are missing, use manual connection endpoint with Phone Number ID from WhatsApp Manager.'
          : 'The WABA you selected during OAuth cannot be accessed via /me endpoint. This is a Meta API limitation. Solution: Use manual connection endpoint with Phone Number ID from WhatsApp Manager.',
        token_source: tokenSource,
        note: tokenSource === 'exchanged_from_code' 
          ? 'Code was successfully exchanged for access token. Note: OAuth codes are single-use and expire quickly (usually within 10 minutes).' 
          : 'Access token was provided directly.',
        endpoints_tried: triedEndpoints,
        api_limitation: wabas.length === 0 
          ? 'The whatsapp_business_accounts field is NOT available on User nodes (/me endpoint). This is a known Meta API limitation. When you select a WABA during OAuth, Meta grants access but the WABA must be accessed through different endpoints (businesses, app, or direct WABA ID). Since these alternative endpoints also failed, use the manual connection endpoint with Phone Number ID from WhatsApp Manager.'
          : null,
        solution: wabas.length === 0
          ? 'Since WABA cannot be accessed via API endpoints, use manual connection: POST /api/v1/meta-connection/whatsapp/manual-connect with phone_number_id from WhatsApp Manager.'
          : null
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to verify OAuth token',
      error: 'verification_failed',
      details: error.message
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

/**
 * Manually connect WhatsApp using Phone Number ID and WABA ID
 * This is a workaround when automatic detection fails due to Meta API limitations
 */
async function manuallyConnectWhatsApp(req, res) {
  try {
    const { phone_number_id, waba_id, access_token } = req.body;
    
    if (!phone_number_id) {
      return res.status(400).json({
        success: false,
        message: 'Phone Number ID is required',
        error: 'missing_phone_number_id'
      });
    }

    // Get tenant info
    const tenantId = req.user.tenantId;
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

    // Get tenant database connection
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(tenantId, subscriptionPlan);
    const initializeModels = require('../models');
    const models = initializeModels(sequelize);

    // If access_token is provided, use it; otherwise, try to get from OAuth flow
    // For manual connection, we'll use the provided access_token or require OAuth first
    let finalAccessToken = access_token;
    
    if (!finalAccessToken) {
      // Try to get from existing config
      const existingConfig = await models.AIAgentConfig.findOne({
        where: {},
        order: [['created_at', 'DESC']]
      });
      
      if (existingConfig && existingConfig.whatsapp_access_token) {
        finalAccessToken = existingConfig.whatsapp_access_token;
      } else {
        return res.status(400).json({
          success: false,
          message: 'Access token is required. Please provide access_token or complete OAuth flow first.',
          error: 'missing_access_token'
        });
      }
    }

    // Verify the phone number ID is valid by making a test API call
    let phoneNumberInfo = null;
    try {
      const phoneNumberResponse = await axios.get(`https://graph.facebook.com/v18.0/${phone_number_id}`, {
        params: {
          access_token: finalAccessToken,
          fields: 'display_phone_number,verified_name'
        }
      });
      phoneNumberInfo = phoneNumberResponse.data;
    } catch (verifyError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Phone Number ID or Access Token. Please verify the Phone Number ID from WhatsApp Manager.',
        error: 'invalid_phone_number_id',
        details: verifyError.response?.data || { message: verifyError.message },
        help: 'To get Phone Number ID: Go to Meta App Dashboard → WhatsApp → Phone Numbers → Click on your phone number → Check the URL for the ID'
      });
    }

    // Encrypt access token before storing
    let encryptedToken = finalAccessToken;
    try {
      const { encrypt } = require('../utils/encryption');
      if (encrypt) {
        encryptedToken = encrypt(finalAccessToken);
      }
    } catch (e) {
      // Encryption utility not available, store as-is
    }

    // Update or create AI agent config
    let config = await models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (!config) {
      config = await models.AIAgentConfig.create({
        whatsapp_enabled: true,
        whatsapp_phone_number_id: phone_number_id,
        whatsapp_phone_number: phoneNumberInfo?.display_phone_number || phoneNumberInfo?.verified_name || null,
        whatsapp_access_token: finalAccessToken
      });
    } else {
      await config.update({
        whatsapp_enabled: true,
        whatsapp_phone_number_id: phone_number_id,
        whatsapp_phone_number: phoneNumberInfo?.display_phone_number || phoneNumberInfo?.verified_name || null,
        whatsapp_access_token: finalAccessToken
      });
    }

    // Store in tenant database whatsapp_connections table
    await models.WhatsAppConnection.upsert({
      ...(subscriptionPlan === 'free' && { tenant_id: tenantId }),
      phone_number_id: phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedToken
    });

    // Also store in main database for AI agent lookup
    try {
      const { mainSequelize } = require('../config/database');
      
      await mainSequelize.query(`
        INSERT INTO whatsapp_connections 
        (tenant_id, phone_number_id, waba_id, access_token, connected_at, updated_at)
        VALUES (?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
        waba_id = VALUES(waba_id),
        access_token = VALUES(access_token),
        updated_at = NOW()
      `, {
        replacements: [tenantId, phone_number_id, waba_id || null, encryptedToken]
      });
      
    } catch (error) {
      // Don't fail if this fails - it's for AI agent lookup only
    }

    return res.json({
      success: true,
      message: 'WhatsApp connected successfully (manual entry)',
      data: {
        tenant_id: tenantId,
        phone_number_id: phone_number_id,
        phone_number: phoneNumberInfo?.display_phone_number || phoneNumberInfo?.verified_name || null,
        waba_id: waba_id || null,
        connected: true
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to manually connect WhatsApp',
      error: 'manual_connection_failed',
      details: error.message
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
  testInstagramConnection,
  manuallyConnectWhatsApp,
  verifyOAuthToken
};


