const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// Configure multer for logo uploads
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads', 'logos');
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: tenant_id_timestamp.ext
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `tenant_${req.user.tenantId}_${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const logoUpload = multer({
  storage: logoStorage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: JPEG, PNG, GIF, WebP'), false);
    }
  }
});

// ==================== PUBLIC ROUTES ====================

// ── OTP ──────────────────────────────────────────────────────────────────────

// Send OTP (for signup or forgot-password)
// Body: { email, type?: 'signup' | 'forgot_password' }
router.post('/send-otp',
  [body('email').isEmail().withMessage('Valid email is required')],
  authController.sendOtp
);

// Resend OTP
// - Signup flow:         { email, registration_token } → returns { encrypted_data, registration_token }
// - Forgot-password flow: { email }                   → returns { encrypted_data }
router.post('/resend-otp',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('registration_token').optional().notEmpty().withMessage('registration_token cannot be empty if provided')
  ],
  authController.resendOtp
);

// ── Forgot / Reset password ───────────────────────────────────────────────────

// Step 1 — request OTP
router.post('/forgot-password',
  [body('email').isEmail().withMessage('Valid email is required')],
  authController.forgotPassword
);

// Step 2 — verify OTP only → returns reset_token → frontend navigates to reset page
router.post('/verify-forgot-password-otp',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').notEmpty().withMessage('OTP is required'),
    body('hash').notEmpty().withMessage('Hash is required')
  ],
  authController.verifyForgotPasswordOtp
);

// Step 3 — submit new password using reset_token (no OTP needed here)
router.post('/reset-password',
  [
    body('reset_token').notEmpty().withMessage('reset_token is required'),
    body('newPassword')
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
      .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
      .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
      .matches(/[0-9]/).withMessage('Password must contain at least one number')
      .matches(/[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>\/?]/).withMessage('Password must contain at least one special character')
  ],
  authController.resetPassword
);

// ── Registration ──────────────────────────────────────────────────────────────

// ── Registration — Step 1: validate + send OTP ───────────────────────────────
const freeUserController = require('../controllers/freeUserController');
router.post('/register-free',
  [
    body('name').notEmpty().withMessage('Business name is required'),
    body('subdomain').notEmpty().withMessage('Subdomain is required'),
    body('subdomain').matches(/^[a-z0-9-]+$/).withMessage('Subdomain can only contain lowercase letters, numbers, and hyphens'),
    body('adminEmail').isEmail().withMessage('Valid email is required'),
    body('adminPassword')
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
      .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
      .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
      .matches(/[0-9]/).withMessage('Password must contain at least one number')
      .matches(/[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>\/?]/).withMessage('Password must contain at least one special character'),
    body('business_type')
      .optional()
      .isIn(['individual', 'company', 'partnership'])
      .withMessage('business_type must be: individual, company, or partnership'),
    body('business_category')
      .optional()
      .isString().withMessage('business_category must be a string')
      .isLength({ max: 100 }).withMessage('business_category must be 100 characters or fewer'),
    body('country').optional().isString()
  ],
  freeUserController.registerFreeUser
);

// ── Registration — Step 2: verify signup OTP → create account → return tokens ─
// Different from forgot-password OTP: this one creates the account.
router.post('/verify-signup-otp',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').notEmpty().withMessage('OTP is required'),
    body('hash').notEmpty().withMessage('Hash is required'),
    body('registration_token').notEmpty().withMessage('registration_token is required')
  ],
  freeUserController.completeSignup
);

// Register enterprise tenant (requires license key)
router.post('/register',
  [
    body('name').notEmpty().withMessage('Tenant name is required'),
    body('subdomain').notEmpty().withMessage('Subdomain is required'),
    body('subdomain').matches(/^[a-z0-9-]+$/).withMessage('Subdomain can only contain lowercase letters, numbers, and hyphens'),
    body('adminEmail').isEmail().withMessage('Valid email is required'),
    body('adminPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('license_key').notEmpty().withMessage('License key is required')
  ],
  authController.register
);

// Login
router.post('/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required')
  ],
  authController.login
);

// Refresh token
router.post('/refresh', authController.refreshToken);

// Logout — invalidates refresh token
router.post('/logout', authController.logout);

// ==================== PROTECTED ROUTES ====================
// Biometric preference (requires auth)
router.get('/biometric', authenticate, authController.getBiometricStatus);
router.put('/biometric', authenticate, authController.setBiometricStatus);

// Get current user
router.get('/me', authenticate, authController.getCurrentUser);

// Get tenant profile
router.get('/profile', authenticate, authController.getTenantProfile);

// Update tenant profile (name, subdomain, phone, address, website)
router.put('/profile',
  authenticate,
  [
    body('name').optional().notEmpty().withMessage('Name cannot be empty'),
    body('subdomain').optional().matches(/^[a-z0-9-]+$/).withMessage('Subdomain can only contain lowercase letters, numbers, and hyphens'),
    body('phone').optional().isString(),
    body('address').optional().isString(),
    body('website').optional().isURL().withMessage('Invalid website URL')
  ],
  authController.updateTenantProfile
);

// Upload/Update logo
router.post('/logo', authenticate, logoUpload.single('logo'), authController.uploadLogo);

// Delete logo
router.delete('/logo', authenticate, authController.deleteLogo);

// Update password
router.put('/password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
  ],
  authController.updatePassword
);

// Update email
router.put('/email',
  authenticate,
  [
    body('newEmail').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required')
  ],
  authController.updateEmail
);

// Device token for push notifications
router.put('/device-token', authenticate, authController.registerDeviceToken);
router.delete('/device-token', authenticate, authController.removeDeviceToken);

// Disable or permanently delete account
router.delete('/account',
  authenticate,
  [
    body('password').notEmpty().withMessage('Password is required'),
    body('action').isIn(['disable', 'delete']).withMessage('action must be disable or delete')
  ],
  authController.deleteAccount
);

// Upgrade free user to enterprise (requires license key)
router.post('/upgrade',
  authenticate,
  [
    body('license_key').notEmpty().withMessage('License key is required for upgrade')
  ],
  authController.upgradeToEnterprise
);

// ==================== BANK DETAILS ====================

// Get bank transfer details
router.get('/bank-details', authenticate, authController.getBankDetails);

// Create or update bank transfer details
router.put('/bank-details',
  authenticate,
  [
    body('bank_account_name').optional().isString().withMessage('Account name must be a string'),
    body('bank_name').optional().isString().withMessage('Bank name must be a string'),
    body('bank_account_number').optional().isString().withMessage('Account number must be a string'),
    body('bank_code').optional().isString().withMessage('Bank code must be a string'),
    body('payment_instructions').optional().isString().withMessage('Payment instructions must be a string')
  ],
  authController.upsertBankDetails
);

// Clear all bank transfer details
router.delete('/bank-details', authenticate, authController.deleteBankDetails);

// ==================== PAYMENT METHOD (AI AGENT) ====================

// Get current payment method used by AI sales agent
router.get('/payment-method', authenticate, authController.getPaymentMethod);

// Set which payment method the AI sales agent should use
router.put('/payment-method',
  authenticate,
  [
    body('payment_instruction_type')
      .notEmpty().withMessage('payment_instruction_type is required')
      .isIn(['paystack', 'bank_transfer', 'paypal']).withMessage('Must be paystack, bank_transfer, or paypal'),
    body('paypal_email').optional().isEmail().withMessage('Valid PayPal email required')
  ],
  authController.updatePaymentMethod
);

module.exports = router;

