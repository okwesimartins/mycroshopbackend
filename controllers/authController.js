const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { User, Tenant, getTenantByUserEmail, createTenant, getTenantById, getTenantBySubdomain } = require('../config/tenant');
const { migrateFreeUserToEnterprise, createTenantDatabase, mainSequelize } = require('../config/database');
const { validationResult } = require('express-validator');

// ── Token helpers ─────────────────────────────────────────────────────────────

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m'
  });
}

async function createRefreshToken(userId) {
  const raw       = crypto.randomBytes(40).toString('hex');
  const hash      = crypto.createHash('sha256').update(raw).digest('hex');
  const days      = parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS || '30', 10);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  await mainSequelize.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    { replacements: [userId, hash, expiresAt] }
  );

  return raw; // return raw token to send to client; only the hash is stored
}

async function rotateRefreshToken(oldRaw, userId) {
  const oldHash = crypto.createHash('sha256').update(oldRaw).digest('hex');
  // Delete the old token (rotation — one-time use)
  await mainSequelize.query(
    `DELETE FROM refresh_tokens WHERE token_hash = ? AND user_id = ?`,
    { replacements: [oldHash, userId] }
  );
  return createRefreshToken(userId);
}

/**
 * Register a new tenant
 */
async function register(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { 
      name, 
      subdomain, 
      adminEmail, 
      adminPassword, 
      license_key,
      country = 'Nigeria',
      business_type = 'company',
      business_category = 'small_business',
      annual_turnover,
      total_fixed_assets
    } = req.body;

    // Enterprise registration requires license key
    if (!license_key) {
      return res.status(400).json({
        success: false,
        message: 'License key is required for enterprise registration. For free tier, use /api/v1/auth/register-free endpoint'
      });
    }

    // Check if subdomain already exists
    const { getTenantBySubdomain } = require('../config/tenant');
    const existingTenant = await getTenantBySubdomain(subdomain);
    if (existingTenant) {
      return res.status(409).json({
        success: false,
        message: 'Subdomain already exists'
      });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ where: { email: adminEmail } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'Email already registered'
      });
    }

    // Create tenant (will validate license key)
    try {
      const tenant = await createTenant({
        name,
        subdomain,
        adminEmail,
        adminPassword,
        license_key,
        country,
        business_type,
        business_category,
        annual_turnover,
        total_fixed_assets
      });

      res.status(201).json({
        success: true,
        message: 'Tenant registered successfully',
        data: {
          tenantId: tenant.id,
          name: tenant.name,
          subdomain: tenant.subdomain
        }
      });
    } catch (error) {
      // Handle license key validation errors
      if (error.message.includes('license') || error.message.includes('License')) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }
      throw error; // Re-throw other errors
    }
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Login
 */
async function login(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if platform admin (no tenant required)
    if (user.is_platform_admin || user.role === 'platform_admin') {
      const accessToken   = signAccessToken({ userId: user.id, email: user.email, role: 'platform_admin', is_platform_admin: true });
      const refreshToken  = await createRefreshToken(user.id);

      return res.json({
        success: true,
        message: 'Login successful',
        data: {
          token: accessToken,
          refresh_token: refreshToken,
          expires_in: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
          user: { id: user.id, email: user.email, role: 'platform_admin', is_platform_admin: true }
        }
      });
    }

    // Regular tenant user - get tenant
    const tenant = await getTenantByUserEmail(email);
    if (!tenant || tenant.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is inactive' });
    }

    const accessToken  = signAccessToken({ userId: user.id, email: user.email, role: user.role, tenantId: tenant.id });
    const refreshToken = await createRefreshToken(user.id);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token: accessToken,
        refresh_token: refreshToken,
        expires_in: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
        user: { id: user.id, email: user.email, role: user.role, tenantId: tenant.id, tenantName: tenant.name }
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed', error: error.message });
  }
}

/**
 * Refresh — exchange a refresh token for a new access token + rotated refresh token
 * POST /api/v1/auth/refresh
 * Body: { refresh_token: "..." }
 */
async function refreshToken(req, res) {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(401).json({ success: false, message: 'refresh_token is required' });
    }

    const hash = crypto.createHash('sha256').update(refresh_token).digest('hex');

    const [rows] = await mainSequelize.query(
      `SELECT rt.*, u.email, u.role, u.is_platform_admin
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = ?
         AND rt.expires_at > NOW()
       LIMIT 1`,
      { replacements: [hash] }
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    const row    = rows[0];
    const userId = row.user_id;

    // Rotate: delete old token, issue new one
    const newRefreshToken = await rotateRefreshToken(refresh_token, userId);

    // Issue new access token
    let payload;
    if (row.is_platform_admin || row.role === 'platform_admin') {
      payload = { userId, email: row.email, role: 'platform_admin', is_platform_admin: true };
    } else {
      // Re-fetch tenantId from tenant table
      const tenant = await getTenantByUserEmail(row.email);
      payload = { userId, email: row.email, role: row.role, tenantId: tenant?.id };
    }

    const newAccessToken = signAccessToken(payload);

    res.json({
      success: true,
      data: {
        token: newAccessToken,
        refresh_token: newRefreshToken,
        expires_in: process.env.JWT_ACCESS_EXPIRES_IN || '15m'
      }
    });
  } catch (error) {
    console.error('refreshToken error:', error);
    res.status(401).json({ success: false, message: 'Token refresh failed' });
  }
}

/**
 * Logout — invalidate the refresh token
 * POST /api/v1/auth/logout
 * Body: { refresh_token: "..." }
 */
async function logout(req, res) {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      const hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
      await mainSequelize.query(
        `DELETE FROM refresh_tokens WHERE token_hash = ?`,
        { replacements: [hash] }
      );
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Logout failed' });
  }
}

/**
 * GET /api/v1/auth/biometric
 * Returns whether the authenticated user has biometric login enabled.
 */
async function getBiometricStatus(req, res) {
  try {
    const user = await User.findByPk(req.user.id, { attributes: ['id', 'biometric_enabled'] });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({
      success: true,
      data: { biometric_enabled: user.biometric_enabled ? 1 : 0 }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get biometric status' });
  }
}

/**
 * PUT /api/v1/auth/biometric
 * Enable or disable biometric login for the authenticated user.
 * Body: { enabled: 1 } or { enabled: 0 }
 */
async function setBiometricStatus(req, res) {
  try {
    const { enabled } = req.body;

    if (enabled === undefined || enabled === null) {
      return res.status(400).json({ success: false, message: 'enabled is required (1 or 0)' });
    }

    const value = enabled == 1 ? 1 : 0;

    await User.update(
      { biometric_enabled: value },
      { where: { id: req.user.id } }
    );

    res.json({
      success: true,
      message: value ? 'Biometric login enabled' : 'Biometric login disabled',
      data: { biometric_enabled: value }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update biometric status' });
  }
}

/**
 * Get current user (requires authentication)
 */
async function getCurrentUser(req, res) {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'email', 'role', 'is_platform_admin', 'created_at']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Handle platform admin
    if (user.is_platform_admin || user.role === 'platform_admin') {
      return res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            role: 'platform_admin',
            is_platform_admin: true
          }
        }
      });
    }

    // Handle regular tenant user
    res.json({
      success: true,
      data: {
        user: {
          ...user.toJSON(),
          tenantId: req.user.tenantId
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get user'
    });
  }
}

/**
 * Get tenant profile
 * Returns tenant info along with online store and physical stores (for enterprise users)
 */
async function getTenantProfile(req, res) {
  try {
    const tenant = await getTenantById(req.user.tenantId);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    const subscriptionPlan = tenant.subscription_plan || 'enterprise';
    const isFreeUser = subscriptionPlan === 'free';

    // Get tenant database connection and models
    const { getTenantConnection } = require('../config/database');
    const sequelize = await getTenantConnection(req.user.tenantId, subscriptionPlan);
    const initializeModels = require('../models');
    const models = initializeModels(sequelize);

    // Build where clause for stores based on tenant type
    const storeWhere = {};
    if (isFreeUser) {
      // Free users: only query stores with tenant_id
      storeWhere.tenant_id = req.user.tenantId;
    }

    // Get online stores (all users have online stores)
    const onlineStores = await models.OnlineStore.findAll({
      where: storeWhere,
      attributes: ['id', 'username', 'store_name', 'custom_domain', 'is_published', 'setup_completed'],
      order: [['created_at', 'DESC']]
    });

    // Get physical stores (only for enterprise users)
    let physicalStores = [];
    if (!isFreeUser) {
      const { Sequelize } = require('sequelize');
      physicalStores = await models.Store.findAll({
        where: {
          ...storeWhere,
          store_type: { [Sequelize.Op.ne]: 'online_only' },
          is_active: true
        },
        attributes: ['id', 'name', 'store_type', 'address', 'city', 'state', 'country', 'phone', 'email'],
        order: [['created_at', 'DESC']]
      });
    }

    // Get WhatsApp connection status from tenant DB
    const aiConfig = await models.AIAgentConfig.findOne({
      where: isFreeUser ? { tenant_id: req.user.tenantId } : {},
      attributes: ['whatsapp_enabled', 'whatsapp_phone_number', 'whatsapp_phone_number_id'],
      order: [['created_at', 'DESC']]
    }).catch(() => null);

    // Get WhatsApp subscription from main DB
    const [[waSub]] = await mainSequelize.query(
      `SELECT ws.status, ws.current_period_end, ws.follow_ups_used,
              wp.name AS plan_name, wp.slug AS plan_slug,
              wp.price_kobo, wp.max_customers, wp.follow_up_limit
       FROM whatsapp_subscriptions ws
       JOIN whatsapp_plans wp ON ws.plan_id = wp.id
       WHERE ws.tenant_id = ?
       LIMIT 1`,
      { replacements: [req.user.tenantId] }
    ).catch(() => [[]]);

    // Format response
    const response = {
      success: true,
      data: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          subdomain: tenant.subdomain,
          logo_url: tenant.logo_url,
          phone: tenant.phone,
          address: tenant.address,
          website: tenant.website,
          country: tenant.country,
          business_type: tenant.business_type,
          annual_turnover: tenant.annual_turnover,
          total_fixed_assets: tenant.total_fixed_assets,
          status: tenant.status,
          subscription_plan: subscriptionPlan,
          created_at: tenant.created_at,
          payment_instruction_type: tenant.payment_instruction_type || 'paystack',
          paypal_email: tenant.paypal_email || null,
          bank_account_name: tenant.bank_account_name || null,
          bank_name: tenant.bank_name || null,
          bank_account_number: tenant.bank_account_number || null,
          bank_code: tenant.bank_code || null,
          payment_instructions: tenant.payment_instructions || null,
        },
        online_stores: onlineStores.map(store => ({
          id: store.id,
          name: store.store_name,
          username: store.username,
          custom_domain: store.custom_domain,
          is_published: store.is_published,
          setup_completed: store.setup_completed
        })),
        whatsapp: {
          connected: !!(aiConfig?.whatsapp_enabled && aiConfig?.whatsapp_phone_number_id),
          phone_number: aiConfig?.whatsapp_phone_number || null,
          phone_number_id: aiConfig?.whatsapp_phone_number_id || null,
          subscription: waSub ? {
            status: waSub.status,
            plan_name: waSub.plan_name,
            plan_slug: waSub.plan_slug,
            price_kobo: waSub.price_kobo,
            max_customers: waSub.max_customers,
            follow_up_limit: waSub.follow_up_limit,
            follow_ups_used: waSub.follow_ups_used,
            current_period_end: waSub.current_period_end
          } : null
        }
      }
    };

    // Add physical stores only for enterprise users
    if (!isFreeUser) {
      response.data.physical_stores = physicalStores.map(store => ({
        id: store.id,
        name: store.name,
        store_type: store.store_type,
        address: store.address,
        city: store.city,
        state: store.state,
        country: store.country,
        phone: store.phone,
        email: store.email
      }));
    }

    res.json(response);
  } catch (error) {
    console.error('Error getting tenant profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tenant profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Update tenant profile (name, subdomain, phone, address, website)
 */
async function updateTenantProfile(req, res) {
  try {
    const {
      name, subdomain, phone, address, website, country, business_type, annual_turnover, total_fixed_assets,
      payment_instruction_type, paypal_email, bank_account_name, bank_name, bank_account_number, bank_code, payment_instructions
    } = req.body;
    
    const tenant = await getTenantById(req.user.tenantId);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // If subdomain is being changed, check if new subdomain is available
    if (subdomain && subdomain !== tenant.subdomain) {
      // Validate subdomain format
      const subdomainRegex = /^[a-z0-9-]+$/;
      if (!subdomainRegex.test(subdomain)) {
        return res.status(400).json({
          success: false,
          message: 'Subdomain can only contain lowercase letters, numbers, and hyphens'
        });
      }

      // Check if subdomain is already taken
      const existingTenant = await getTenantBySubdomain(subdomain);
      if (existingTenant && existingTenant.id !== tenant.id) {
        return res.status(409).json({
          success: false,
          message: 'Subdomain already exists'
        });
      }
    }

    // Update tenant
    await tenant.update({
      ...(name !== undefined && { name }),
      ...(subdomain !== undefined && { subdomain }),
      ...(phone !== undefined && { phone }),
      ...(address !== undefined && { address }),
      ...(website !== undefined && { website }),
      ...(country !== undefined && { country }),
      ...(business_type !== undefined && { business_type }),
      ...(annual_turnover !== undefined && { annual_turnover: annual_turnover ? parseFloat(annual_turnover) : null }),
      ...(total_fixed_assets !== undefined && { total_fixed_assets: total_fixed_assets ? parseFloat(total_fixed_assets) : null }),
      ...(payment_instruction_type !== undefined && { payment_instruction_type: payment_instruction_type || 'paystack' }),
      ...(paypal_email !== undefined && { paypal_email: paypal_email || null }),
      ...(bank_account_name !== undefined && { bank_account_name: bank_account_name || null }),
      ...(bank_name !== undefined && { bank_name: bank_name || null }),
      ...(bank_account_number !== undefined && { bank_account_number: bank_account_number || null }),
      ...(bank_code !== undefined && { bank_code: bank_code || null }),
      ...(payment_instructions !== undefined && { payment_instructions: payment_instructions || null }),
      updated_at: new Date()
    });

    res.json({
      success: true,
      message: 'Tenant profile updated successfully',
      data: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          subdomain: tenant.subdomain,
          logo_url: tenant.logo_url,
          phone: tenant.phone,
          address: tenant.address,
          website: tenant.website,
          country: tenant.country,
          business_type: tenant.business_type,
          business_category: tenant.business_category,
          annual_turnover: tenant.annual_turnover,
          total_fixed_assets: tenant.total_fixed_assets,
          payment_instruction_type: tenant.payment_instruction_type || 'paystack',
          paypal_email: tenant.paypal_email || null,
          bank_account_name: tenant.bank_account_name || null,
          bank_name: tenant.bank_name || null,
          bank_account_number: tenant.bank_account_number || null,
          bank_code: tenant.bank_code || null,
          payment_instructions: tenant.payment_instructions || null,
        }
      }
    });
  } catch (error) {
    console.error('Error updating tenant profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update tenant profile'
    });
  }
}

/**
 * Upload/Update tenant logo
 * Expects multipart/form-data with 'logo' field
 */
async function uploadLogo(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No logo file provided'
      });
    }

    const tenant = await getTenantById(req.user.tenantId);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(req.file.mimetype)) {
      // Delete uploaded file
      if (req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        message: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP'
      });
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (req.file.size > maxSize) {
      if (req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 5MB'
      });
    }

    // Delete old logo if exists
    if (tenant.logo_url) {
      const oldLogoPath = path.join(__dirname, '..', 'uploads', 'logos', path.basename(tenant.logo_url));
      if (fs.existsSync(oldLogoPath)) {
        fs.unlinkSync(oldLogoPath);
      }
    }

    // Generate logo URL
    const logoUrl = `/uploads/logos/${req.file.filename}`;

    // Update tenant with new logo
    await tenant.update({
      logo_url: logoUrl,
      updated_at: new Date()
    });

    res.json({
      success: true,
      message: 'Logo uploaded successfully',
      data: {
        logo_url: logoUrl
      }
    });
  } catch (error) {
    console.error('Error uploading logo:', error);
    // Clean up uploaded file on error
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    res.status(500).json({
      success: false,
      message: 'Failed to upload logo'
    });
  }
}

/**
 * Delete tenant logo
 */
async function deleteLogo(req, res) {
  try {
    const tenant = await getTenantById(req.user.tenantId);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    if (!tenant.logo_url) {
      return res.status(400).json({
        success: false,
        message: 'No logo to delete'
      });
    }

    // Delete logo file
    const logoPath = path.join(__dirname, '..', 'uploads', 'logos', path.basename(tenant.logo_url));
    if (fs.existsSync(logoPath)) {
      fs.unlinkSync(logoPath);
    }

    // Update tenant
    await tenant.update({
      logo_url: null,
      updated_at: new Date()
    });

    res.json({
      success: true,
      message: 'Logo deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting logo:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete logo'
    });
  }
}

/**
 * Update user password
 */
async function updatePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters'
      });
    }

    const user = await User.findByPk(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await user.update({
      password_hash: newPasswordHash
    });

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update password'
    });
  }
}

/**
 * Update user email
 */
async function updateEmail(req, res) {
  try {
    const { newEmail, password } = req.body;

    if (!newEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'New email and password are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const user = await User.findByPk(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Password is incorrect'
      });
    }

    // Check if new email is already in use
    const existingUser = await User.findOne({ where: { email: newEmail } });
    if (existingUser && existingUser.id !== user.id) {
      return res.status(409).json({
        success: false,
        message: 'Email already in use'
      });
    }

    // Update email
    await user.update({
      email: newEmail
    });

    res.json({
      success: true,
      message: 'Email updated successfully',
      data: {
        email: newEmail
      }
    });
  } catch (error) {
    console.error('Error updating email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update email'
    });
  }
}

/**
 * Upgrade free user to enterprise plan
 * Migrates all data from shared database to new tenant database
 */
async function upgradeToEnterprise(req, res) {
  try {
    const tenantId = req.user.tenantId;
    const { license_key } = req.body;

    if (!license_key) {
      return res.status(400).json({
        success: false,
        message: 'License key is required for upgrade'
      });
    }

    // Get tenant
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }

    // Check if already enterprise
    if (tenant.subscription_plan === 'enterprise') {
      return res.status(400).json({
        success: false,
        message: 'Tenant is already on enterprise plan'
      });
    }

    // Validate license key (similar to registration)
    const { LicenseKey } = require('../config/tenant');
    const license = await LicenseKey.findOne({
      where: {
        license_key: license_key,
        status: 'active'
      }
    });

    if (!license) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or inactive license key'
      });
    }

    // Check if license is expired
    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'License key has expired'
      });
    }

    // Check if license is already used by another tenant
    if (license.tenant_id && license.tenant_id !== tenantId) {
      return res.status(400).json({
        success: false,
        message: 'License key is already in use'
      });
    }

    // Migrate data from shared DB to new tenant DB
    let newDbName;
    try {
      newDbName = await migrateFreeUserToEnterprise(tenantId);
    } catch (migrationError) {
      console.error('Migration error:', migrationError);
      return res.status(500).json({
        success: false,
        message: 'Failed to migrate data to enterprise database',
        error: process.env.NODE_ENV === 'development' ? migrationError.message : undefined
      });
    }

    // Update tenant record
    await Tenant.update(
      {
        subscription_plan: 'enterprise',
        db_name: newDbName,
        transaction_fee_percentage: null // No transaction fees for enterprise
      },
      {
        where: { id: tenantId }
      }
    );

    // Mark license as used
    await LicenseKey.update(
      {
        status: 'used',
        tenant_id: tenantId,
        used_at: new Date()
      },
      {
        where: { id: license.id }
      }
    );

    // Close old connection if exists
    const { closeTenantConnection } = require('../config/database');
    closeTenantConnection(tenantId);

    res.json({
      success: true,
      message: 'Successfully upgraded to enterprise plan. All your data has been migrated.',
      data: {
        tenant: {
          id: tenantId,
          subscription_plan: 'enterprise',
          db_name: newDbName
        }
      }
    });
  } catch (error) {
    console.error('Upgrade error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upgrade to enterprise plan',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * GET /auth/bank-details
 * Returns the tenant's bank transfer details
 */
async function getBankDetails(req, res) {
  try {
    const tenant = await getTenantById(req.user.tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    res.json({
      success: true,
      data: {
        bank_account_name: tenant.bank_account_name || null,
        bank_name: tenant.bank_name || null,
        bank_account_number: tenant.bank_account_number || null,
        bank_code: tenant.bank_code || null,
        payment_instructions: tenant.payment_instructions || null
      }
    });
  } catch (error) {
    console.error('Error fetching bank details:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bank details' });
  }
}

/**
 * PUT /auth/bank-details
 * Create or update bank transfer details
 * Body: { bank_account_name, bank_name, bank_account_number, bank_code, payment_instructions }
 */
async function upsertBankDetails(req, res) {
  try {
    const { bank_account_name, bank_name, bank_account_number, bank_code, payment_instructions } = req.body;

    const tenant = await getTenantById(req.user.tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    await tenant.update({
      ...(bank_account_name !== undefined && { bank_account_name: bank_account_name || null }),
      ...(bank_name !== undefined && { bank_name: bank_name || null }),
      ...(bank_account_number !== undefined && { bank_account_number: bank_account_number || null }),
      ...(bank_code !== undefined && { bank_code: bank_code || null }),
      ...(payment_instructions !== undefined && { payment_instructions: payment_instructions || null }),
      updated_at: new Date()
    });

    res.json({
      success: true,
      message: 'Bank details updated successfully',
      data: {
        bank_account_name: tenant.bank_account_name || null,
        bank_name: tenant.bank_name || null,
        bank_account_number: tenant.bank_account_number || null,
        bank_code: tenant.bank_code || null,
        payment_instructions: tenant.payment_instructions || null
      }
    });
  } catch (error) {
    console.error('Error updating bank details:', error);
    res.status(500).json({ success: false, message: 'Failed to update bank details' });
  }
}

/**
 * DELETE /auth/bank-details
 * Clears all bank transfer details
 */
async function deleteBankDetails(req, res) {
  try {
    const tenant = await getTenantById(req.user.tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    await tenant.update({
      bank_account_name: null,
      bank_name: null,
      bank_account_number: null,
      bank_code: null,
      payment_instructions: null,
      updated_at: new Date()
    });

    res.json({ success: true, message: 'Bank details cleared successfully' });
  } catch (error) {
    console.error('Error deleting bank details:', error);
    res.status(500).json({ success: false, message: 'Failed to delete bank details' });
  }
}

/**
 * GET /auth/payment-method
 * Returns the current payment method configuration for the AI sales agent
 */
async function getPaymentMethod(req, res) {
  try {
    const tenant = await getTenantById(req.user.tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    res.json({
      success: true,
      data: {
        payment_instruction_type: tenant.payment_instruction_type || 'paystack',
        paypal_email: tenant.paypal_email || null
      }
    });
  } catch (error) {
    console.error('Error fetching payment method:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch payment method' });
  }
}

/**
 * PUT /auth/payment-method
 * Set which payment method the AI sales agent uses after an order
 * Body: { payment_instruction_type: 'paystack' | 'bank_transfer' | 'paypal', paypal_email? }
 */
async function updatePaymentMethod(req, res) {
  try {
    const { payment_instruction_type, paypal_email } = req.body;

    const validTypes = ['paystack', 'bank_transfer', 'paypal'];
    if (!payment_instruction_type || !validTypes.includes(payment_instruction_type)) {
      return res.status(400).json({
        success: false,
        message: `payment_instruction_type must be one of: ${validTypes.join(', ')}`
      });
    }

    if (payment_instruction_type === 'paypal' && !paypal_email) {
      return res.status(400).json({
        success: false,
        message: 'paypal_email is required when payment_instruction_type is paypal'
      });
    }

    const tenant = await getTenantById(req.user.tenantId);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    if (payment_instruction_type === 'bank_transfer' && (!tenant.bank_account_number || !tenant.bank_name)) {
      return res.status(400).json({
        success: false,
        message: 'Please add your bank details first before setting payment type to bank_transfer'
      });
    }

    await tenant.update({
      payment_instruction_type,
      ...(paypal_email !== undefined && { paypal_email: paypal_email || null }),
      updated_at: new Date()
    });

    res.json({
      success: true,
      message: 'Payment method updated successfully',
      data: {
        payment_instruction_type: tenant.payment_instruction_type,
        paypal_email: tenant.paypal_email || null
      }
    });
  } catch (error) {
    console.error('Error updating payment method:', error);
    res.status(500).json({ success: false, message: 'Failed to update payment method' });
  }
}

/**
 * PUT /auth/device-token
 * Register or update an FCM device token for push notifications.
 * Body: { token: string, platform?: 'android' | 'ios' | 'web' }
 */
async function registerDeviceToken(req, res) {
  try {
    const { token, platform = 'android' } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, message: 'token is required' });
    }

    const validPlatforms = ['android', 'ios', 'web'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ success: false, message: 'platform must be android, ios, or web' });
    }

    const tenantId = req.user.tenantId;
    const userId = req.user.id;

    await mainSequelize.query(
      `INSERT INTO device_tokens (tenant_id, user_id, token, platform)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tenant_id  = VALUES(tenant_id),
         user_id    = VALUES(user_id),
         platform   = VALUES(platform),
         updated_at = CURRENT_TIMESTAMP`,
      { replacements: [tenantId, userId, token, platform] }
    );

    res.json({ success: true, message: 'Device token registered successfully' });
  } catch (error) {
    console.error('registerDeviceToken error:', error);
    res.status(500).json({ success: false, message: 'Failed to register device token' });
  }
}

/**
 * DELETE /auth/device-token
 * Remove an FCM device token (call on logout to stop receiving notifications).
 * Body: { token: string }
 */
async function removeDeviceToken(req, res) {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'token is required' });
    }

    await mainSequelize.query(
      'DELETE FROM device_tokens WHERE token = ? AND user_id = ?',
      { replacements: [token, req.user.id] }
    );

    res.json({ success: true, message: 'Device token removed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to remove device token' });
  }
}

/**
 * DELETE /auth/account
 * Disable or permanently delete the merchant's account.
 * Body: { password: string, action: 'disable' | 'delete' }
 *
 * disable → status = 'inactive'  (can be reactivated by platform admin)
 * delete  → status = 'terminated' (soft delete, data retained, irreversible via app)
 */
async function deleteAccount(req, res) {
  try {
    const { password, action } = req.body;

    if (!password) {
      return res.status(400).json({ success: false, message: 'Password is required to confirm this action' });
    }

    if (!['disable', 'delete'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action must be either "disable" or "delete"' });
    }

    const userId   = req.user.id;
    const tenantId = req.user.tenantId;

    // Verify password using User model (same as other auth functions)
    const user = await User.findOne({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Incorrect password' });
    }

    const newStatus = action === 'delete' ? 'terminated' : 'inactive';

    // Update tenant status using Tenant model (same as other auth functions)
    await Tenant.update({ status: newStatus }, { where: { id: tenantId } });

    // Revoke all refresh tokens for this tenant's users
    await mainSequelize.query(
      `DELETE rt FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       WHERE u.tenant_id = ?`,
      { replacements: [tenantId] }
    );

    // Remove all device tokens so push notifications stop
    await mainSequelize.query(
      'DELETE FROM device_tokens WHERE tenant_id = ?',
      { replacements: [tenantId] }
    );

    const message = action === 'delete'
      ? 'Account permanently deleted. Your data will be retained for 30 days then removed.'
      : 'Account disabled. Contact support to reactivate.';

    res.json({ success: true, message });
  } catch (error) {
    console.error('deleteAccount error:', error);
    res.status(500).json({ success: false, message: 'Failed to process account request', error: error.message });
  }
}

// Export with authenticate middleware attached
const { authenticate } = require('../middleware/auth');
getCurrentUser.authenticate = authenticate;

module.exports = {
  register,
  login,
  refreshToken,
  getCurrentUser,
  getTenantProfile,
  updateTenantProfile,
  uploadLogo,
  deleteLogo,
  updatePassword,
  updateEmail,
  upgradeToEnterprise,
  getBankDetails,
  upsertBankDetails,
  deleteBankDetails,
  getPaymentMethod,
  updatePaymentMethod,
  logout,
  getBiometricStatus,
  setBiometricStatus,
  registerDeviceToken,
  removeDeviceToken,
  deleteAccount
};

