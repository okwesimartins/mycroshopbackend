const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const metaConnectionController = require('../controllers/metaConnectionController');

// Public route for cron job - token refresh (no authentication required)
// This endpoint can be called by cron jobs via simple HTTP request
router.post('/refresh-tokens', metaConnectionController.refreshExpiringTokensHandler);
router.get('/refresh-tokens', metaConnectionController.refreshExpiringTokensHandler);

// Public config — returns META_APP_ID and META_CONFIG_ID for FB SDK init (no auth needed)
router.get('/public-config', metaConnectionController.getPublicMetaConfig);

// WhatsApp OAuth callback — public because Facebook redirects here without a JWT.
// Tenant is identified from the state param (tenantId embedded by /whatsapp/connect).
router.get('/whatsapp/callback', metaConnectionController.handleWhatsAppCallback);

// All other routes require authentication
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get connection status
router.get('/status', metaConnectionController.getConnectionStatus);

// Initiate WhatsApp connection
router.get('/whatsapp/connect', metaConnectionController.initiateWhatsAppConnection);

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

// Complete Embedded Signup — receives { code, waba_id, phone_number_id } from FB JS SDK popup
// Tenant is identified from JWT; no state param needed
router.post('/whatsapp/embedded-signup', metaConnectionController.completeEmbeddedSignup);

// Manual WhatsApp connection (workaround when automatic detection fails)
router.post('/whatsapp/manual-connect', metaConnectionController.manuallyConnectWhatsApp);

// Verify OAuth token and check WABA access
router.post('/verify-oauth', metaConnectionController.verifyOAuthToken);

module.exports = router;

