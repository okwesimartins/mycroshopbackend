const express = require('express');
const router = express.Router();
const {
  getPlans,
  getMySubscription,
  getConnectLink,
  subscribeToPlan,
  cancelSubscription,
  handleWebhook,
  paymentCallback,
  useFollowUp
} = require('../controllers/whatsappPlanController');
const { authenticate } = require('../middleware/auth');

// Public — list all WhatsApp AI sales agent plans
router.get('/', getPlans);

// Webhook — called by Paystack; must be before any body-parsing middleware
router.post('/webhook', handleWebhook);

// Payment callback redirect (Paystack redirects here after payment)
router.get('/payment-callback', paymentCallback);

// ── AI Agent internal endpoint (no user auth — called service-to-service) ─────
router.post('/agent/use-followup', useFollowUp);

// Authenticated routes (merchant dashboard)
router.get('/my-subscription', authenticate, getMySubscription);
router.get('/connect-link', authenticate, getConnectLink);
router.post('/subscribe', authenticate, subscribeToPlan);
router.post('/cancel', authenticate, cancelSubscription);

module.exports = router;
