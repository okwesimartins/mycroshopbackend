const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const licenseController = require('../controllers/licenseController');

// All routes require authentication
// Note: In production, you should add system admin check
// For now, any authenticated admin can manage licenses
router.use(authenticate);

// TODO: Add system admin check middleware
// This should check if user is a system admin (not tenant admin)
// For now, we'll allow any admin - you should implement proper system admin system

// Generate license key
router.post('/generate',
  [
    body('quantity').optional().isInt({ min: 1, max: 100 }).withMessage('Quantity must be between 1 and 100'),
    body('expires_at').optional().isISO8601().withMessage('Invalid expiration date'),
    body('purchased_by').optional().isString(),
    body('purchased_email').optional().isEmail()
  ],
  licenseController.generateLicenseKeys
);

// Get all license keys
router.get('/', licenseController.getAllLicenseKeys);

// Get license key by ID
router.get('/:id', licenseController.getLicenseKeyById);

// Update license key status
router.patch('/:id/status', licenseController.updateLicenseKeyStatus);

// Revoke license key
router.post('/:id/revoke', licenseController.revokeLicenseKey);

module.exports = router;

