const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { User, Tenant, getTenantBySubdomain } = require('../config/tenant');
const { initializeSharedFreeDatabase } = require('../config/database');
const { validationResult } = require('express-validator');
const { generateOtp, validateOtp, sendOtpEmail, sendWelcomeEmail } = require('../services/authEmailService');
const { signAccessToken, createRefreshToken } = require('../utils/tokenUtils');
const { validatePasswordStrength } = require('./authController');

const REGISTRATION_TOKEN_TTL = '10m'; // same window as OTP

// ─── Step 1: validate fields, send OTP, return registration_token ─────────────

/**
 * POST /api/v1/auth/register-free
 * Body: { name, subdomain, adminEmail, adminPassword, business_type?,
 *         business_category?, country? }
 *
 * → Sends a 6-digit OTP to adminEmail.
 * → Returns { encrypted_data, registration_token } — both required for step 2.
 *   The registration_token is a signed JWT (expires in 10 min) that encodes
 *   all the registration data so step 2 doesn't need to resend it.
 */
async function registerFreeUser(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
      name,
      subdomain,
      adminEmail,
      adminPassword,
      country           = 'Nigeria',
      business_type     = 'company',
      business_category = 'small_business'
    } = req.body;

    const normalizedEmail = adminEmail.trim().toLowerCase();

    // Password strength
    const pwCheck = validatePasswordStrength(adminPassword);
    if (!pwCheck.valid) {
      return res.status(400).json({ success: false, message: pwCheck.message });
    }

    // Email must not already exist
    const existingUser = await User.findOne({ where: { email: normalizedEmail } });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Subdomain must not already exist
    const existingTenant = await getTenantBySubdomain(subdomain);
    if (existingTenant) {
      return res.status(409).json({ success: false, message: 'Subdomain already exists' });
    }

    // Hash password now so step 2 is lightweight
    const passwordHash = await bcrypt.hash(adminPassword, 10);

    // Package all registration data into a short-lived signed token
    const registration_token = jwt.sign(
      { name, subdomain, email: normalizedEmail, passwordHash, country, business_type, business_category },
      process.env.JWT_SECRET,
      { expiresIn: REGISTRATION_TOKEN_TTL }
    );

    // Generate OTP + send — awaited because the user cannot proceed without it
    const { otp, encrypted_data } = generateOtp(normalizedEmail);
    try {
      await sendOtpEmail(normalizedEmail, otp, 'signup');
    } catch (emailErr) {
      console.error('OTP email failed:', emailErr.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to send verification email. Please check your email address and try again.',
        error: process.env.NODE_ENV === 'development' ? emailErr.message : undefined
      });
    }

    return res.json({
      success: true,
      message: 'OTP sent to your email address. Enter it to complete registration.',
      data: { encrypted_data, registration_token }
    });
  } catch (error) {
    console.error('registerFreeUser error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// ─── Step 2: verify OTP, create account, return tokens ───────────────────────

/**
 * POST /api/v1/auth/complete-signup
 * Body: { email, otp, hash, registration_token }
 *
 * → Verifies the OTP and the registration_token.
 * → Creates the tenant + user.
 * → Returns auth tokens + fires welcome email.
 */
async function completeSignup(req, res) {
  try {
    const { email, otp, hash, registration_token } = req.body;

    if (!email || !otp || !hash || !registration_token) {
      return res.status(400).json({
        success: false,
        message: 'email, otp, hash, and registration_token are all required'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Verify OTP (stateless)
    const otpCheck = validateOtp(normalizedEmail, otp, hash);
    if (!otpCheck.valid) {
      return res.status(400).json({ success: false, message: otpCheck.reason });
    }

    // Decode + verify registration_token
    let regData;
    try {
      regData = jwt.verify(registration_token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err.name === 'TokenExpiredError'
          ? 'Registration session expired. Please start again.'
          : 'Invalid registration token'
      });
    }

    // Token email must match submitted email
    if (regData.email !== normalizedEmail) {
      return res.status(400).json({ success: false, message: 'Email mismatch' });
    }

    const { name, subdomain, passwordHash, country, business_type, business_category } = regData;

    // Re-check uniqueness (race condition guard)
    const existingUser = await User.findOne({ where: { email: normalizedEmail } });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    const existingTenant = await getTenantBySubdomain(subdomain);
    if (existingTenant) {
      return res.status(409).json({ success: false, message: 'Subdomain already exists' });
    }

    // Create tenant
    const tenant = await Tenant.create({
      name,
      subdomain,
      db_name:                    null,
      country,
      business_type,
      business_category,
      subscription_plan:          'free',
      transaction_fee_percentage: 4.00,
      status:                     'active'
    });

    // Ensure shared free DB is ready
    try { await initializeSharedFreeDatabase(); } catch (e) {
      console.error('initializeSharedFreeDatabase error:', e.message);
    }

    // Create admin user (password already hashed in step 1)
    const user = await User.create({
      tenant_id:     tenant.id,
      email:         normalizedEmail,
      password_hash: passwordHash,
      role:          'admin'
    });

    // Issue auth tokens
    const accessToken  = signAccessToken({ userId: user.id, email: user.email, role: user.role, tenantId: tenant.id });
    const refreshToken = await createRefreshToken(user.id);

    // Welcome email — fire-and-forget
    sendWelcomeEmail(normalizedEmail, name).catch(err =>
      console.error('Welcome email error:', err.message)
    );

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        token:         accessToken,
        refresh_token: refreshToken,
        expires_in:    process.env.JWT_ACCESS_EXPIRES_IN || '15m',
        user: {
          id:                user.id,
          email:             user.email,
          role:              user.role,
          tenantId:          tenant.id,
          tenantName:        tenant.name,
          subscription_plan: 'free'
        }
      }
    });
  } catch (error) {
    console.error('completeSignup error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to complete registration',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = { registerFreeUser, completeSignup };
