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
    let foundWabaIds = []; // Track all WABA IDs found for diagnostics
    let wabaDiagnostics = []; // Track diagnostic info for each WABA
    
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
        // Log all WABAs found
        for (const waba of appTokenResponse.data.whatsapp_business_accounts.data) {
          foundWabaIds.push(waba.id);
          wabaDiagnostics.push({
            waba_id: waba.id,
            waba_name: waba.name,
            phone_numbers_count: waba.phone_numbers?.data?.length || 0,
            phone_numbers: waba.phone_numbers?.data?.map(p => ({
              id: p.id,
              display_phone_number: p.display_phone_number,
              verified_name: p.verified_name
            })) || []
          });
        }
        
        // Use first WABA
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
    // This is the KEY method - OAuth user token should have access to WABAs they selected
    if (!phoneNumberId) {
      try {
        const wabaResponse = await axios.get('https://graph.facebook.com/v18.0/me', {
          params: {
            access_token: accessToken,
            fields: 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
          }
        });
        
        if (wabaResponse.data.whatsapp_business_accounts && wabaResponse.data.whatsapp_business_accounts.data && wabaResponse.data.whatsapp_business_accounts.data.length > 0) {
          // Log all WABAs found via user token (these are the ones they selected in OAuth)
          for (const waba of wabaResponse.data.whatsapp_business_accounts.data) {
            if (!foundWabaIds.includes(waba.id)) {
              foundWabaIds.push(waba.id);
              wabaDiagnostics.push({
                waba_id: waba.id,
                waba_name: waba.name,
                phone_numbers_count: waba.phone_numbers?.data?.length || 0,
                phone_numbers: waba.phone_numbers?.data?.map(p => ({
                  id: p.id,
                  display_phone_number: p.display_phone_number,
                  verified_name: p.verified_name
                })) || [],
                found_via: 'user_oauth_token_me_endpoint',
                note: 'This WABA was selected during OAuth flow and is accessible via user token'
              });
            }
          }
          
          // Use first WABA (or the one they selected)
          const waba = wabaResponse.data.whatsapp_business_accounts.data[0];
          wabaId = waba.id;
          
          if (waba.phone_numbers && waba.phone_numbers.data && waba.phone_numbers.data.length > 0) {
            phoneNumber = waba.phone_numbers.data[0];
            phoneNumberId = phoneNumber.id;
          }
        }
      } catch (altError) {
        const altErrorDetails = altError.response?.data || { message: altError.message };
        lastError = altErrorDetails;
      }
    }
    
    // Method 4: Try direct whatsapp_business_accounts endpoint
    // Note: /me endpoints require user token, not App Access Token
    // Another way to access WABAs via user OAuth token
    if (!phoneNumberId) {
      try {
        const wabaDirectResponse = await axios.get('https://graph.facebook.com/v18.0/me/whatsapp_business_accounts', {
          params: {
            access_token: accessToken,
            fields: 'id,name,phone_numbers{id,display_phone_number,verified_name}'
          }
        });
        
        if (wabaDirectResponse.data.data && wabaDirectResponse.data.data.length > 0) {
          // Log all WABAs found via direct endpoint
          for (const waba of wabaDirectResponse.data.data) {
            if (!foundWabaIds.includes(waba.id)) {
              foundWabaIds.push(waba.id);
              wabaDiagnostics.push({
                waba_id: waba.id,
                waba_name: waba.name,
                phone_numbers_count: waba.phone_numbers?.data?.length || 0,
                phone_numbers: waba.phone_numbers?.data?.map(p => ({
                  id: p.id,
                  display_phone_number: p.display_phone_number,
                  verified_name: p.verified_name
                })) || [],
                found_via: 'user_oauth_token_direct_endpoint',
                note: 'This WABA was selected during OAuth flow and is accessible via user token'
              });
            }
          }
          
          const waba = wabaDirectResponse.data.data[0];
          wabaId = waba.id;
          
          if (waba.phone_numbers && waba.phone_numbers.data && waba.phone_numbers.data.length > 0) {
            phoneNumber = waba.phone_numbers.data[0];
            phoneNumberId = phoneNumber.id;
          }
        }
      } catch (directError) {
        const directErrorDetails = directError.response?.data || { message: directError.message };
        if (!lastError || (lastError.error && lastError.error.code !== 100)) {
          lastError = directErrorDetails;
        }
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
    
    // Method 7: Direct test phone number lookup - Try to get phone number from app's WhatsApp configuration
    // In test mode, Meta assigns test phone numbers that are app-level, not user-level
    if (!phoneNumberId) {
      const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
      
      try {
        // Try to get all WhatsApp Business Accounts associated with the app
        const allWabaResponse = await axios.get(`https://graph.facebook.com/v18.0/${process.env.META_APP_ID}`, {
          params: {
            access_token: appAccessToken,
            fields: 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
          }
        });
        
        if (allWabaResponse.data.whatsapp_business_accounts && allWabaResponse.data.whatsapp_business_accounts.data) {
          // Try each WABA to find phone numbers
          for (const waba of allWabaResponse.data.whatsapp_business_accounts.data) {
            if (waba.phone_numbers && waba.phone_numbers.data && waba.phone_numbers.data.length > 0) {
              wabaId = waba.id;
              phoneNumber = waba.phone_numbers.data[0];
              phoneNumberId = phoneNumber.id;
              break;
            }
            
            // If phone_numbers not in nested response, try direct endpoint
            if (!phoneNumberId) {
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
        }
      } catch (finalError) {
        // Store error but don't overwrite if we have a better one
        if (!lastError || (lastError.error && lastError.error.code !== 100)) {
          lastError = finalError.response?.data || { message: finalError.message };
        }
      }
    }
    
    // Method 8: Last resort - Try to get phone number using user token with different endpoint structure
    // Sometimes the phone number is accessible via a different path
    if (!phoneNumberId && wabaId) {
      try {
        // Try with user token one more time, but with explicit fields
        const phoneNumbersResponse = await axios.get(`https://graph.facebook.com/v18.0/${wabaId}/phone_numbers`, {
          params: {
            access_token: accessToken,
            fields: 'id,display_phone_number,verified_name'
          }
        });
        
        if (phoneNumbersResponse.data.data && phoneNumbersResponse.data.data.length > 0) {
          phoneNumber = phoneNumbersResponse.data.data[0];
          phoneNumberId = phoneNumber.id;
        }
      } catch (finalUserTokenError) {
        // This is expected to fail if user token doesn't have permission
      }
    }
    
    // If still no phone number found, return exact error from Meta API with detailed diagnostics
    if (!phoneNumberId) {
      // Collect all error details for better diagnostics
      const errorDetails = {
        error: lastError?.error || lastError,
        token_permissions: tokenPermissions,
        required_permissions: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        app_access_token_used: true,
        app_id: process.env.META_APP_ID ? `${process.env.META_APP_ID.substring(0, 4)}...` : 'not_set',
        waba_diagnostics: {
          found_waba_ids: foundWabaIds,
          waba_count: foundWabaIds.length,
          waba_details: wabaDiagnostics,
          waba_id_attempted: wabaId || 'none',
          note: wabaId 
            ? `Found WABA ID ${wabaId} but could not access phone numbers. Check if this WABA has phone numbers assigned in WhatsApp Manager.` 
            : 'No WABA IDs found. This means the WhatsApp Business Account is NOT linked to your Meta App. This is the root cause - you need to link the WABA to your app first.',
          root_cause: foundWabaIds.length === 0 
            ? 'WhatsApp Business Account is not linked to your Meta App. Even though you can see a test phone number in WhatsApp Manager, the Graph API cannot access it because the WABA is not associated with your app.' 
            : null,
          solution: foundWabaIds.length === 0 
            ? 'You have two options: 1) Link the WABA to your app in Meta App Dashboard (recommended), or 2) Use manual connection endpoint with Phone Number ID from WhatsApp Manager (workaround).'
            : null
        },
        last_error_context: lastError?.waba_id_attempted ? {
          waba_id: lastError.waba_id_attempted,
          method: lastError.method,
          endpoint: lastError.endpoint,
          error: lastError.error || lastError
        } : null,
        note: 'All methods attempted: App Access Token, User OAuth Token, and various endpoint combinations. The "Missing Permission" error suggests that even the App Access Token cannot access WhatsApp Business Accounts. This may indicate:',
        possible_causes: [
          '1. **ROOT CAUSE: WhatsApp Business Account is NOT linked to your Meta App** - This is why no WABA IDs are found',
          '2. WhatsApp product not properly configured in Meta App Dashboard',
          '3. No test phone number assigned to the app',
          wabaId ? `4. WABA ID ${wabaId} found but phone numbers are not accessible (check WhatsApp Manager)` : '4. No WABA IDs found - WhatsApp Business Account not linked to app',
          '5. App Access Token requires additional permissions (unlikely in test mode)',
          '6. The test phone number exists in WhatsApp Manager UI but is not accessible via Graph API because WABA is not linked'
        ],
        troubleshooting_steps: [
          '**STEP 1: Link WhatsApp Business Account to Your App (CRITICAL)**',
          '   1. Go to Meta App Dashboard → WhatsApp → Getting Started',
          '   2. Look for "Add Phone Number" or "Connect WhatsApp Business Account"',
          '   3. If you see a test phone number in WhatsApp Manager, you need to link it to your app',
          '   4. In WhatsApp Manager, go to Settings → WhatsApp Business Account → Apps',
          '   5. Add your app to the WABA, or create a new WABA and link it to your app',
          '',
          '**STEP 2: Verify Configuration**',
          '   1. Ensure WhatsApp is added as a product in your Meta App',
          '   2. Check if a test phone number is assigned (should show in WhatsApp Manager)',
          '   3. Verify META_APP_ID and META_APP_SECRET are correct in environment variables',
          '',
          '**STEP 3: Test API Access**',
          `   Try in Graph API Explorer: GET https://graph.facebook.com/v18.0/${process.env.META_APP_ID}?access_token=${process.env.META_APP_ID}|${process.env.META_APP_SECRET}&fields=whatsapp_business_accounts`,
          '   If this returns empty data or error, the WABA is not linked.',
          '',
          '**STEP 4: Alternative - Manual Connection (Workaround)**',
          '   If linking WABA to app is not possible, use manual connection endpoint:',
          '   POST /api/v1/meta-connection/whatsapp/manual-connect',
          '   Get Phone Number ID from WhatsApp Manager URL when viewing phone number details'
        ],
        alternative_approach: 'If the phone number is visible in WhatsApp Manager but not accessible via API, use the manual connection endpoint: POST /api/v1/meta-connection/whatsapp/manual-connect. Get the Phone Number ID from WhatsApp Manager URL when viewing phone number details.',
        manual_connection_endpoint: '/api/v1/meta-connection/whatsapp/manual-connect',
        manual_connection_guide: 'See WHATSAPP_MANUAL_CONNECTION_GUIDE.md for step-by-step instructions'
      };
      
      return res.status(400).json({
        success: false,
        message: 'Could not find WhatsApp phone number',
        error: 'no_phone_number_found',
        details: errorDetails
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

    let finalAccessToken = access_token;

    // If code is provided, exchange it for access token
    if (code && !access_token) {
      try {
        const redirectUri = 'https://mycroshop.com/';
        const tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
          params: {
            client_id: process.env.META_APP_ID,
            client_secret: process.env.META_APP_SECRET,
            redirect_uri: redirectUri,
            code: code
          }
        });

        if (!tokenResponse.data.access_token) {
          return res.status(400).json({
            success: false,
            message: 'Failed to exchange code for access token',
            error: 'token_exchange_failed',
            details: tokenResponse.data
          });
        }

        finalAccessToken = tokenResponse.data.access_token;
      } catch (exchangeError) {
        return res.status(400).json({
          success: false,
          message: 'Failed to exchange OAuth code for access token',
          error: 'code_exchange_failed',
          details: exchangeError.response?.data || { message: exchangeError.message },
          help: 'The OAuth code may have expired (codes are single-use and expire quickly). Complete the OAuth flow again to get a new code.'
        });
      }
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
    let wabas = [];
    let wabaError = null;
    try {
      const wabaResponse = await axios.get('https://graph.facebook.com/v18.0/me', {
        params: {
          access_token: finalAccessToken,
          fields: 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}'
        }
      });
      
      if (wabaResponse.data.whatsapp_business_accounts && wabaResponse.data.whatsapp_business_accounts.data) {
        wabas = wabaResponse.data.whatsapp_business_accounts.data.map(waba => ({
          id: waba.id,
          name: waba.name,
          phone_numbers_count: waba.phone_numbers?.data?.length || 0,
          phone_numbers: waba.phone_numbers?.data?.map(p => ({
            id: p.id,
            display_phone_number: p.display_phone_number,
            verified_name: p.verified_name
          })) || []
        }));
      }
    } catch (error) {
      wabaError = error.response?.data || { message: error.message };
    }

    // Try direct endpoint
    if (wabas.length === 0) {
      try {
        const wabaDirectResponse = await axios.get('https://graph.facebook.com/v18.0/me/whatsapp_business_accounts', {
          params: {
            access_token: finalAccessToken,
            fields: 'id,name,phone_numbers{id,display_phone_number,verified_name}'
          }
        });
        
        if (wabaDirectResponse.data.data && wabaDirectResponse.data.data.length > 0) {
          wabas = wabaDirectResponse.data.data.map(waba => ({
            id: waba.id,
            name: waba.name,
            phone_numbers_count: waba.phone_numbers?.data?.length || 0,
            phone_numbers: waba.phone_numbers?.data?.map(p => ({
              id: p.id,
              display_phone_number: p.display_phone_number,
              verified_name: p.verified_name
            })) || []
          }));
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
          : '❌ FAILED: No WABAs found. OAuth may not have completed properly or WABA was not selected.',
        next_steps: wabas.length > 0
          ? 'WABA is accessible. If phone numbers are missing, use manual connection endpoint with Phone Number ID from WhatsApp Manager.'
          : '1. Complete OAuth flow again and ensure you select the WABA and click "Continue". 2. Check if the WABA is linked to your app in Meta App Dashboard.',
        token_source: code ? 'exchanged_from_code' : 'provided_directly',
        note: code ? 'Code was successfully exchanged for access token. Note: OAuth codes are single-use and expire quickly.' : 'Access token was provided directly.'
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

