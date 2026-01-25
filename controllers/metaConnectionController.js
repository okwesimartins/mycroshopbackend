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
    res.status(500).json({
      success: false,
      message: 'Failed to initiate WhatsApp connection'
    });
  }
}

/**
 * Handle WhatsApp OAuth callback
 */
async function handleWhatsAppCallback(req, res) {
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

    // Check token permissions first
    let tokenPermissions = null;
    try {
      const debugTokenResponse = await axios.get('https://graph.facebook.com/v18.0/debug_token', {
        params: {
          input_token: accessToken,
          access_token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`
        }
      });
      tokenPermissions = debugTokenResponse.data.data?.scopes || [];
    } catch (debugError) {
      // Continue even if debug fails
    }

    // Get WhatsApp Business Account ID and phone numbers
    // For test accounts, we need to access through the app's WhatsApp configuration
    let wabaId = null;
    let phoneNumberId = null;
    let phoneNumber = null;
    let lastError = null;
    
    // Method 1: Try with App Access Token FIRST (works best for test mode, no App Review needed)
    // App Access Token format: APP_ID|APP_SECRET - works in test mode without App Review
    const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
    
    try {
      const appTokenResponse = await axios.get(`https://graph.facebook.com/v18.0/${process.env.META_APP_ID}`, {
        params: {
          access_token: appAccessToken,
          fields: 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
        }
      });
      
      if (appTokenResponse.data.whatsapp_business_accounts && appTokenResponse.data.whatsapp_business_accounts.data) {
        const waba = appTokenResponse.data.whatsapp_business_accounts.data[0];
        wabaId = waba.id;
        
        if (waba.phone_numbers && waba.phone_numbers.data && waba.phone_numbers.data.length > 0) {
          phoneNumber = waba.phone_numbers.data[0];
          phoneNumberId = phoneNumber.id;
        }
      }
    } catch (appTokenError) {
      // Store the App Access Token error separately for better diagnostics
      const appTokenErrorDetails = appTokenError.response?.data || { message: appTokenError.message };
      lastError = appTokenErrorDetails;
      
      // If App Access Token fails, it might mean:
      // 1. WhatsApp product not properly configured
      // 2. No test phone number assigned
      // 3. App Access Token doesn't have WhatsApp permissions (shouldn't happen in test mode)
    }
    
    // Method 2: If App Access Token fails, try with user OAuth token
    if (!phoneNumberId) {
      try {
        const appWabaResponse = await axios.get(`https://graph.facebook.com/v18.0/${process.env.META_APP_ID}`, {
          params: {
            access_token: accessToken,
            fields: 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
          }
        });
        
        if (appWabaResponse.data.whatsapp_business_accounts && appWabaResponse.data.whatsapp_business_accounts.data) {
          const waba = appWabaResponse.data.whatsapp_business_accounts.data[0];
          wabaId = waba.id;
          
          if (waba.phone_numbers && waba.phone_numbers.data && waba.phone_numbers.data.length > 0) {
            phoneNumber = waba.phone_numbers.data[0];
            phoneNumberId = phoneNumber.id;
          }
        }
      } catch (appError) {
        lastError = appError.response?.data || { message: appError.message };
      }
    }
    
    // Method 3: Try to get WABA ID from user's whatsapp_business_accounts field
    // Note: /me endpoints require user token, not App Access Token
    if (!phoneNumberId) {
      try {
        const wabaResponse = await axios.get('https://graph.facebook.com/v18.0/me', {
          params: {
            access_token: accessToken,
            fields: 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
          }
        });
        
        if (wabaResponse.data.whatsapp_business_accounts && wabaResponse.data.whatsapp_business_accounts.data && wabaResponse.data.whatsapp_business_accounts.data.length > 0) {
          const waba = wabaResponse.data.whatsapp_business_accounts.data[0];
          wabaId = waba.id;
          
          if (waba.phone_numbers && waba.phone_numbers.data && waba.phone_numbers.data.length > 0) {
            phoneNumber = waba.phone_numbers.data[0];
            phoneNumberId = phoneNumber.id;
          }
        }
      } catch (altError) {
        lastError = altError.response?.data || { message: altError.message };
      }
    }
    
    // Method 4: Try direct whatsapp_business_accounts endpoint
    // Note: /me endpoints require user token, not App Access Token
    if (!phoneNumberId) {
      try {
        const wabaDirectResponse = await axios.get('https://graph.facebook.com/v18.0/me/whatsapp_business_accounts', {
          params: {
            access_token: accessToken,
            fields: 'id,name,phone_numbers{id,display_phone_number,verified_name}'
          }
        });
        
        if (wabaDirectResponse.data.data && wabaDirectResponse.data.data.length > 0) {
          const waba = wabaDirectResponse.data.data[0];
          wabaId = waba.id;
          
          if (waba.phone_numbers && waba.phone_numbers.data && waba.phone_numbers.data.length > 0) {
            phoneNumber = waba.phone_numbers.data[0];
            phoneNumberId = phoneNumber.id;
          }
        }
      } catch (directError) {
        lastError = directError.response?.data || { message: directError.message };
      }
    }
    
    // Method 5: If we have WABA ID but no phone number, try getting phone numbers separately (with App Access Token fallback)
    if (wabaId && !phoneNumberId) {
      const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
      
      // Try with App Access Token first
      try {
        const phoneNumbersResponse = await axios.get(`https://graph.facebook.com/v18.0/${wabaId}/phone_numbers`, {
          params: {
            access_token: appAccessToken
          }
        });
        
        if (phoneNumbersResponse.data.data && phoneNumbersResponse.data.data.length > 0) {
          phoneNumber = phoneNumbersResponse.data.data[0];
          phoneNumberId = phoneNumber.id;
        }
      } catch (phoneError) {
        // Fallback to user token
        try {
          const phoneNumbersResponse = await axios.get(`https://graph.facebook.com/v18.0/${wabaId}/phone_numbers`, {
            params: {
              access_token: accessToken
            }
          });
          
          if (phoneNumbersResponse.data.data && phoneNumbersResponse.data.data.length > 0) {
            phoneNumber = phoneNumbersResponse.data.data[0];
            phoneNumberId = phoneNumber.id;
          }
        } catch (userTokenError) {
          lastError = userTokenError.response?.data || { message: userTokenError.message };
        }
      }
    }
    
    // Method 6: Try businesses endpoint (with App Access Token fallback)
    if (!wabaId) {
      const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
      
      // Try with App Access Token first
      try {
        const businessesResponse = await axios.get('https://graph.facebook.com/v18.0/me/businesses', {
          params: {
            access_token: appAccessToken,
            fields: 'id,name'
          }
        });
        
        if (businessesResponse.data.data && businessesResponse.data.data.length > 0) {
          wabaId = businessesResponse.data.data[0].id;
          
          const phoneNumbersResponse = await axios.get(`https://graph.facebook.com/v18.0/${wabaId}/phone_numbers`, {
            params: {
              access_token: appAccessToken
            }
          });
          
          if (phoneNumbersResponse.data.data && phoneNumbersResponse.data.data.length > 0) {
            phoneNumber = phoneNumbersResponse.data.data[0];
            phoneNumberId = phoneNumber.id;
          }
        }
      } catch (businessError) {
        // Fallback to user token
        try {
          const businessesResponse = await axios.get('https://graph.facebook.com/v18.0/me/businesses', {
            params: {
              access_token: accessToken,
              fields: 'id,name'
            }
          });
          
          if (businessesResponse.data.data && businessesResponse.data.data.length > 0) {
            wabaId = businessesResponse.data.data[0].id;
            
            const phoneNumbersResponse = await axios.get(`https://graph.facebook.com/v18.0/${wabaId}/phone_numbers`, {
              params: {
                access_token: accessToken
              }
            });
            
            if (phoneNumbersResponse.data.data && phoneNumbersResponse.data.data.length > 0) {
              phoneNumber = phoneNumbersResponse.data.data[0];
              phoneNumberId = phoneNumber.id;
            }
          }
        } catch (userTokenError) {
          lastError = userTokenError.response?.data || { message: userTokenError.message };
        }
      }
    }
    
    // If still no phone number found, try one more method: Direct test phone number lookup
    // In test mode, Meta assigns test phone numbers that can be accessed via app-level endpoints
    if (!phoneNumberId) {
      const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
      
      try {
        // Try to get all WhatsApp Business Accounts associated with the app
        const allWabaResponse = await axios.get(`https://graph.facebook.com/v18.0/${process.env.META_APP_ID}`, {
          params: {
            access_token: appAccessToken,
            fields: 'whatsapp_business_accounts'
          }
        });
        
        if (allWabaResponse.data.whatsapp_business_accounts && allWabaResponse.data.whatsapp_business_accounts.data) {
          // Try each WABA to find phone numbers
          for (const waba of allWabaResponse.data.whatsapp_business_accounts.data) {
            try {
              const phoneNumbersResponse = await axios.get(`https://graph.facebook.com/v18.0/${waba.id}/phone_numbers`, {
                params: {
                  access_token: appAccessToken
                }
              });
              
              if (phoneNumbersResponse.data.data && phoneNumbersResponse.data.data.length > 0) {
                wabaId = waba.id;
                phoneNumber = phoneNumbersResponse.data.data[0];
                phoneNumberId = phoneNumber.id;
                break;
              }
            } catch (wabaError) {
              // Continue to next WABA
            }
          }
        }
      } catch (finalError) {
        // This is the last attempt, so we'll use this error if nothing else worked
        if (!lastError) {
          lastError = finalError.response?.data || { message: finalError.message };
        }
      }
    }
    
    // If still no phone number found, return exact error from Meta API
    if (!phoneNumberId) {
      return res.status(400).json({
        success: false,
        message: 'Could not find WhatsApp phone number',
        error: 'no_phone_number_found',
        details: {
          error: lastError?.error || lastError,
          token_permissions: tokenPermissions,
          required_permissions: ['whatsapp_business_management', 'whatsapp_business_messaging'],
          note: 'In test mode, ensure your Meta App has WhatsApp product configured and a test phone number assigned. The App Access Token method was attempted but may require App Review for production use.',
          troubleshooting: [
            '1. Go to Meta App Dashboard → WhatsApp product section',
            '2. Ensure WhatsApp is added as a product',
            '3. Check if a test phone number is assigned',
            '4. Verify META_APP_ID and META_APP_SECRET are correct in environment variables',
            '5. For test mode, the App Access Token (APP_ID|APP_SECRET) should work without App Review'
          ]
        }
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

    // Update or create AI agent config in tenant database
    let config = await models.AIAgentConfig.findOne({
      where: {},
      order: [['created_at', 'DESC']]
    });

    if (!config) {
      config = await models.AIAgentConfig.create({
        whatsapp_enabled: true,
        whatsapp_phone_number_id: phoneNumberId,
        whatsapp_phone_number: phoneNumber?.display_phone_number || phoneNumber?.phone_number || phoneNumber?.verified_name || null,
        whatsapp_access_token: accessToken // Store securely - in production, encrypt this
      });
    } else {
      await config.update({
        whatsapp_enabled: true,
        whatsapp_phone_number_id: phoneNumberId,
        whatsapp_phone_number: phoneNumber?.display_phone_number || phoneNumber?.phone_number || phoneNumber?.verified_name || null,
        whatsapp_access_token: accessToken
      });
    }

    // Also store in tenant database whatsapp_connections table
    // WABA ID is already fetched above (or null if not available)
    
    // Encrypt access token before storing (if encryption utility exists)
    let encryptedToken = accessToken;
    try {
      const { encrypt } = require('../utils/encryption');
      if (encrypt) {
        encryptedToken = encrypt(accessToken);
      }
    } catch (e) {
      // Encryption utility not available, store as-is (should be encrypted in production)
    }

    // Store or update in tenant database
    await models.WhatsAppConnection.upsert({
      ...(subscriptionPlan === 'free' && { tenant_id: tenantId }),
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: encryptedToken
    });
    

    // Also store in main database for AI agent lookup (phone_number_id → tenant_id)
    // This allows the AI agent webhook to quickly identify which tenant a message belongs to
    try {
      const { mainSequelize } = require('../config/database');
      
      // Store in main database (whatsapp_connections table)
      // This table should exist in mycroshop_main database
      await mainSequelize.query(`
        INSERT INTO whatsapp_connections 
        (tenant_id, phone_number_id, waba_id, access_token, connected_at, updated_at)
        VALUES (?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
        waba_id = VALUES(waba_id),
        access_token = VALUES(access_token),
        updated_at = NOW()
      `, {
        replacements: [tenantId, phoneNumberId, wabaId, encryptedToken]
      });
      
    } catch (error) {
      // Don't fail the connection if this fails - it's for AI agent lookup only
      // The connection is still stored in tenant database above
    }

    // Return success JSON response
    return res.json({
      success: true,
      message: 'WhatsApp connected successfully',
      data: {
        tenant_id: tenantId,
        phone_number_id: phoneNumberId,
        phone_number: phoneNumber?.display_phone_number || phoneNumber?.phone_number || phoneNumber?.verified_name || null,
        waba_id: wabaId,
        connected: true
      }
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

