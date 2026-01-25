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
 * Initiate WhatsApp connection using Embedded Signup (RECOMMENDED)
 * Embedded Signup is better for SaaS platforms - returns waba_id and phone_number_id directly
 */
async function initiateWhatsAppConnection(req, res) {
  try {
    // Generate state for security
    const state = crypto.randomBytes(32).toString('hex');
    const stateWithTenant = `${state}:${req.user.tenantId}`;
    
    // Embedded Signup URL
    // This is the official way for solution providers to onboard businesses
    const redirectUri = 'https://mycroshop.com';
    const appId = process.env.META_APP_ID;
    
    // Embedded Signup URL format
    // Docs: https://developers.facebook.com/docs/whatsapp/embedded-signup
    const signupUrl = `https://www.facebook.com/dialog/whatsapp_signup?` +
      `app_id=${appId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${stateWithTenant}`;
    
    res.json({
      success: true,
      data: {
        signupUrl,
        state: stateWithTenant,
        method: 'embedded_signup',
        note: 'Embedded Signup returns waba_id and phone_number_id directly - no API discovery needed'
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
 * Handle WhatsApp Embedded Signup callback
 * Embedded Signup returns waba_id and phone_number_id directly - much simpler!
 */
async function handleWhatsAppCallback(req, res) {
  try {
    // Embedded Signup returns waba_id and phone_number_id directly
    const { waba_id, phone_number_id, state, error, error_description } = req.query;
    
    // Check for errors from Meta
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp signup failed',
        error: 'signup_failed',
        details: {
          error,
          error_description
        }
      });
    }
    
    // EMBEDDED SIGNUP FLOW - Returns waba_id and phone_number_id directly!
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
    
    // If we reach here, Embedded Signup didn't provide required parameters
    if (!waba_id || !phone_number_id) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp Embedded Signup failed: Missing waba_id or phone_number_id',
        error: 'signup_failed',
        help: 'Embedded Signup should return both waba_id and phone_number_id in the callback URL. Check your Meta App configuration and ensure Embedded Signup is properly set up.'
      });
    }
    
    // This should never be reached, but just in case
    return res.status(400).json({
      success: false,
      message: 'WhatsApp signup failed: Unexpected error',
      error: 'signup_failed'
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


