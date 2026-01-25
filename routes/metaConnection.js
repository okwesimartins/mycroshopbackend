const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const metaConnectionController = require('../controllers/metaConnectionController');

// All routes require authentication
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get connection status
router.get('/status', metaConnectionController.getConnectionStatus);

// Initiate WhatsApp connection
router.get('/whatsapp/connect', metaConnectionController.initiateWhatsAppConnection);

// WhatsApp OAuth callback
router.get('/whatsapp/callback', metaConnectionController.handleWhatsAppCallback);

// Initiate Instagram connection
router.get('/instagram/connect', metaConnectionController.initiateInstagramConnection);

// Instagram OAuth callback
router.get('/instagram/callback', metaConnectionController.handleInstagramCallback);

// Disconnect WhatsApp
router.post('/whatsapp/disconnect', metaConnectionController.disconnectWhatsApp);

// Disconnect Instagram
router.post('/instagram/disconnect', metaConnectionController.disconnectInstagram);

// Test connection
router.post('/test/whatsapp', metaConnectionController.testWhatsAppConnection);
router.post('/test/instagram', metaConnectionController.testInstagramConnection);

// Manual WhatsApp connection (workaround when automatic detection fails)
router.post('/whatsapp/manual-connect', metaConnectionController.manuallyConnectWhatsApp);

// Verify OAuth token and check WABA access
router.post('/verify-oauth', metaConnectionController.verifyOAuthToken);

module.exports = router;

