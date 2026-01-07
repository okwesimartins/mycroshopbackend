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

// Register free user (no license key required)
const freeUserController = require('../controllers/freeUserController');
router.post('/register-free',
  [
    body('name').notEmpty().withMessage('Business name is required'),
    body('subdomain').notEmpty().withMessage('Subdomain is required'),
    body('subdomain').matches(/^[a-z0-9-]+$/).withMessage('Subdomain can only contain lowercase letters, numbers, and hyphens'),
    body('adminEmail').isEmail().withMessage('Valid email is required'),
    body('adminPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
  ],
  freeUserController.registerFreeUser
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

// ==================== PROTECTED ROUTES ====================

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

// Upgrade free user to enterprise (requires license key)
router.post('/upgrade',
  authenticate,
  [
    body('license_key').notEmpty().withMessage('License key is required for upgrade')
  ],
  authController.upgradeToEnterprise
);

module.exports = router;

