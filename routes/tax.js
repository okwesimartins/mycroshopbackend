const express = require('express');
const router = express.Router();
const taxController = require('../controllers/taxController');
const { authenticate } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get tax information for tenant's country
router.get('/info', taxController.getTaxInformation);

// Calculate tax preview
router.get('/preview', taxController.calculateTaxPreview);

module.exports = router;

