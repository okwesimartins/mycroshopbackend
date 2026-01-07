const express = require('express');
const router = express.Router();
const { getAvailableFeatures } = require('../middleware/businessCategory');
const { authenticate } = require('../middleware/auth');

// Get available features for current tenant
router.get('/', authenticate, getAvailableFeatures);

module.exports = router;

