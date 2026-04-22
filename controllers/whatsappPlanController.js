const axios = require('axios');
const crypto = require('crypto');
const { WhatsAppPlan, WhatsAppSubscription, getTenantById } = require('../config/tenant');
const { mainSequelize } = require('../config/database');
const { getPlatformSettingValue } = require('./platformSettingsController');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the active WhatsApp subscription for a tenant, including plan details.
 */
async function getActiveSubscription(tenantId) {
  return WhatsAppSubscription.findOne({
    where: { tenant_id: tenantId },
    include: [{ model: WhatsAppPlan, as: 'Plan' }]
  });
}

/**
 * Generate a unique Paystack transaction reference for WhatsApp plan payments.
 */
function generateRef(tenantId, planSlug) {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `wa-plan-${planSlug}-${tenantId}-${ts}-${rand}`;
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/whatsapp-plans
 * List all active WhatsApp AI Sales Agent plans (public — no auth required).
 */
async function getPlans(req, res) {
  try {
    const plans = await WhatsAppPlan.findAll({
      where: { is_active: true },
      order: [['sort_order', 'ASC']],
      attributes: [
        'id', 'name', 'slug', 'price_kobo', 'max_customers',
        'max_whatsapp_numbers', 'follow_up_limit', 'features',
        'best_for', 'is_custom', 'sort_order'
      ]
    });

    const formatted = plans.map(p => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      price_ngn: p.price_kobo != null ? p.price_kobo / 100 : null,
      price_display: p.price_kobo != null
        ? `₦${(p.price_kobo / 100).toLocaleString('en-NG')}/month`
        : 'Custom pricing',
      max_customers: p.max_customers,
      max_whatsapp_numbers: p.max_whatsapp_numbers,
      follow_up_limit: p.follow_up_limit,
      features: p.features || [],
      best_for: p.best_for,
      is_custom: Boolean(p.is_custom)
    }));

    return res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('getPlans error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch plans' });
  }
}

/**
 * GET /api/v1/whatsapp-plans/my-subscription
 * Return the tenant's current WhatsApp AI subscription (authenticated).
 */
async function getMySubscription(req, res) {
  try {
    const tenantId = req.tenantId;
    const sub = await getActiveSubscription(tenantId);

    if (!sub) {
      return res.json({
        success: true,
        data: null,
        message: 'No active WhatsApp AI subscription found'
      });
    }

    const plan = sub.Plan;
    const now = new Date();
    const isExpired = sub.current_period_end && new Date(sub.current_period_end) < now;
    const status = isExpired && sub.status === 'active' ? 'expired' : sub.status;

    return res.json({
      success: true,
      data: {
        id: sub.id,
        status,
        plan: plan ? {
          id: plan.id,
          name: plan.name,
          slug: plan.slug,
          price_ngn: plan.price_kobo != null ? plan.price_kobo / 100 : null,
          max_customers: plan.max_customers,
          max_whatsapp_numbers: plan.max_whatsapp_numbers,
          follow_up_limit: plan.follow_up_limit,
          features: plan.features || [],
          is_custom: Boolean(plan.is_custom)
        } : null,
        current_period_start: sub.current_period_start,
        current_period_end: sub.current_period_end,
        follow_ups_used: sub.follow_ups_used,
        follow_up_limit: plan?.follow_up_limit ?? null,
        follow_ups_remaining: plan?.follow_up_limit != null
          ? Math.max(0, plan.follow_up_limit - sub.follow_ups_used)
          : null,
        cancelled_at: sub.cancelled_at,
        created_at: sub.created_at
      }
    });
  } catch (err) {
    console.error('getMySubscription error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch subscription' });
  }
}

/**
 * POST /api/v1/whatsapp-plans/subscribe
 * Initiate a Paystack payment to subscribe to a WhatsApp AI plan.
 *
 * Body: { plan_id, email, callback_url? }
 *
 * For Enterprise (is_custom = true) returns a contact prompt instead of a payment URL.
 */
async function subscribeToPlan(req, res) {
  try {
    const tenantId = req.tenantId;
    const { plan_id, email, callback_url } = req.body;

    if (!plan_id) {
      return res.status(400).json({ success: false, message: 'plan_id is required' });
    }
    if (!email) {
      return res.status(400).json({ success: false, message: 'email is required' });
    }

    const plan = await WhatsAppPlan.findOne({
      where: { id: plan_id, is_active: true }
    });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    // Enterprise — no self-serve payment
    if (plan.is_custom) {
      return res.json({
        success: true,
        is_custom: true,
        message: 'Enterprise plan requires a custom quote. Please contact sales@mycroshop.com or WhatsApp us to get started.',
        contact_email: 'sales@mycroshop.com'
      });
    }

    const secretKey = await getPlatformSettingValue('paystack_secret_key');
    if (!secretKey) {
      return res.status(500).json({
        success: false,
        message: 'Payment is not configured yet. Please contact support.'
      });
    }

    const reference = generateRef(tenantId, plan.slug);
    const callbackUrl = callback_url || process.env.WHATSAPP_PLAN_CALLBACK_URL || `${process.env.BASE_URL || 'https://backend.mycroshop.com'}/api/v1/whatsapp-plans/payment-callback`;

    // Upsert a pending subscription record so we can track on webhook
    let sub = await WhatsAppSubscription.findOne({ where: { tenant_id: tenantId } });
    if (sub) {
      await sub.update({
        plan_id: plan.id,
        status: 'pending',
        paystack_reference: reference,
        updated_at: new Date()
      });
    } else {
      sub = await WhatsAppSubscription.create({
        tenant_id: tenantId,
        plan_id: plan.id,
        status: 'pending',
        paystack_reference: reference
      });
    }

    // Initialize Paystack transaction
    const paystackRes = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: plan.price_kobo,
        currency: 'NGN',
        reference,
        callback_url: callbackUrl,
        metadata: {
          custom_fields: [
            { display_name: 'Plan', variable_name: 'plan_name', value: plan.name },
            { display_name: 'Tenant ID', variable_name: 'tenant_id', value: String(tenantId) }
          ],
          tenant_id: tenantId,
          plan_id: plan.id,
          plan_slug: plan.slug,
          payment_type: 'whatsapp_plan'
        }
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const { authorization_url, access_code } = paystackRes.data.data;

    return res.json({
      success: true,
      data: {
        reference,
        authorization_url,
        access_code,
        plan: {
          id: plan.id,
          name: plan.name,
          slug: plan.slug,
          price_ngn: plan.price_kobo / 100
        }
      }
    });
  } catch (err) {
    const detail = err.response?.data || err.message || String(err);
    console.error('subscribeToPlan error:', detail);
    return res.status(500).json({
      success: false,
      message: err.response?.data?.message || 'Failed to initiate payment. Please try again.',
      ...(process.env.NODE_ENV !== 'production' && { debug: detail })
    });
  }
}

/**
 * POST /api/v1/whatsapp-plans/cancel
 * Cancel the tenant's WhatsApp AI subscription (authenticated).
 * The subscription remains active until the end of the current billing period.
 */
async function cancelSubscription(req, res) {
  try {
    const tenantId = req.tenantId;
    const sub = await WhatsAppSubscription.findOne({ where: { tenant_id: tenantId } });

    if (!sub || sub.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'No active subscription to cancel' });
    }

    await sub.update({
      status: 'cancelled',
      cancelled_at: new Date(),
      updated_at: new Date()
    });

    return res.json({
      success: true,
      message: `Subscription cancelled. You can continue using the WhatsApp AI until ${sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString('en-NG') : 'the end of your billing period'}.`
    });
  } catch (err) {
    console.error('cancelSubscription error:', err);
    return res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
  }
}

/**
 * POST /api/v1/whatsapp-plans/webhook
 * Paystack webhook for WhatsApp plan payments.
 * Validates the Paystack signature and activates the subscription on success.
 *
 * NOTE: This route must receive the raw request body (no JSON parsing middleware).
 */
async function handleWebhook(req, res) {
  try {
    const secretKey = await getPlatformSettingValue('paystack_secret_key');
    if (!secretKey) {
      return res.status(500).send('Webhook configuration error');
    }

    // Verify Paystack signature
    const hash = crypto
      .createHmac('sha512', secretKey)
      .update(req.rawBody || JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.warn('WhatsApp plan webhook: invalid signature');
      return res.status(400).send('Invalid signature');
    }

    // Acknowledge immediately (Paystack expects 200 fast)
    res.sendStatus(200);

    const event = req.body;
    if (event.event !== 'charge.success') return;

    const data = event.data || {};
    const metadata = data.metadata || {};

    // Only handle whatsapp_plan payments
    if (metadata.payment_type !== 'whatsapp_plan') return;

    const tenantId = parseInt(metadata.tenant_id, 10);
    const planId = parseInt(metadata.plan_id, 10);
    const reference = data.reference;

    if (!tenantId || !planId || !reference) {
      console.warn('WhatsApp plan webhook: missing metadata', metadata);
      return;
    }

    // Find subscription by reference or tenant_id
    let sub = await WhatsAppSubscription.findOne({
      where: { paystack_reference: reference }
    });
    if (!sub) {
      sub = await WhatsAppSubscription.findOne({ where: { tenant_id: tenantId } });
    }

    const plan = await WhatsAppPlan.findByPk(planId);
    if (!plan) {
      console.warn('WhatsApp plan webhook: plan not found', planId);
      return;
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 30); // 30-day billing cycle

    if (sub) {
      await sub.update({
        plan_id: planId,
        status: 'active',
        paystack_reference: reference,
        paystack_customer_code: data.customer?.customer_code || sub.paystack_customer_code,
        current_period_start: now,
        current_period_end: periodEnd,
        follow_ups_used: 0, // Reset on new payment
        follow_up_reset_at: now,
        cancelled_at: null,
        updated_at: now
      });
    } else {
      await WhatsAppSubscription.create({
        tenant_id: tenantId,
        plan_id: planId,
        status: 'active',
        paystack_reference: reference,
        paystack_customer_code: data.customer?.customer_code || null,
        current_period_start: now,
        current_period_end: periodEnd,
        follow_ups_used: 0,
        follow_up_reset_at: now
      });
    }

    console.log(`✅ WhatsApp plan activated: tenant ${tenantId} → ${plan.name} (ref: ${reference})`);
  } catch (err) {
    console.error('WhatsApp plan webhook error:', err);
    // Already sent 200 above; just log
  }
}

/**
 * GET /api/v1/whatsapp-plans/payment-callback
 * Paystack redirects here after payment. Redirects the user to the dashboard.
 */
async function paymentCallback(req, res) {
  const { reference, trxref } = req.query;
  const ref = reference || trxref || '';

  // Find subscription for this reference to determine status
  let status = 'unknown';
  try {
    if (ref) {
      const sub = await WhatsAppSubscription.findOne({ where: { paystack_reference: ref } });
      if (sub) status = sub.status;
    }
  } catch (e) {
    // ignore
  }

  const frontendUrl = process.env.FRONTEND_URL || 'https://app.mycroshop.com';
  return res.redirect(`${frontendUrl}/dashboard/whatsapp-ai?payment=${status}&ref=${encodeURIComponent(ref)}`);
}

// ─── Follow-up Usage Tracking ─────────────────────────────────────────────────

/**
 * Check whether a tenant's WhatsApp AI subscription allows another follow-up message,
 * and if so increment the counter.
 *
 * Returns:
 *   { allowed: true }                        — OK to send
 *   { allowed: false, reason: string }       — limit reached or no subscription
 *
 * Called by the AI agent before sending any outbound follow-up (outside 24h window).
 */
async function checkAndIncrementFollowUpUsage(tenantId) {
  try {
    const sub = await WhatsAppSubscription.findOne({
      where: { tenant_id: tenantId },
      include: [{ model: WhatsAppPlan, as: 'Plan' }]
    });

    if (!sub) {
      return { allowed: false, reason: 'no_subscription' };
    }

    const now = new Date();

    // Check subscription is active and not expired
    if (sub.status !== 'active') {
      return { allowed: false, reason: `subscription_${sub.status}` };
    }
    if (sub.current_period_end && new Date(sub.current_period_end) < now) {
      // Auto-expire
      await sub.update({ status: 'expired', updated_at: now });
      return { allowed: false, reason: 'subscription_expired' };
    }

    const plan = sub.Plan;
    const limit = plan?.follow_up_limit ?? null;

    // NULL limit = unlimited (Enterprise)
    if (limit === null) {
      await sub.update({ follow_ups_used: (sub.follow_ups_used || 0) + 1, updated_at: now });
      return { allowed: true };
    }

    if (sub.follow_ups_used >= limit) {
      return {
        allowed: false,
        reason: 'follow_up_limit_reached',
        limit,
        used: sub.follow_ups_used
      };
    }

    // Increment counter
    await WhatsAppSubscription.update(
      { follow_ups_used: sub.follow_ups_used + 1, updated_at: now },
      { where: { id: sub.id } }
    );

    return { allowed: true, used: sub.follow_ups_used + 1, limit };
  } catch (err) {
    console.error('checkAndIncrementFollowUpUsage error:', err);
    // Fail open — don't block the AI if the DB check fails
    return { allowed: true };
  }
}

// ─── AI Agent HTTP endpoints ──────────────────────────────────────────────────

/**
 * GET /api/v1/whatsapp-plans/agent/status?tenant_id=42
 * Called by the AI agent on startup or before deciding which features to enable.
 * Returns subscription status and plan limits — no auth required (internal use).
 */
async function getAgentSubscriptionStatus(req, res) {
  try {
    const tenantId = parseInt(req.query.tenant_id, 10);
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenant_id query param is required' });
    }

    const sub = await WhatsAppSubscription.findOne({
      where: { tenant_id: tenantId },
      include: [{ model: WhatsAppPlan, as: 'Plan' }]
    });

    if (!sub) {
      return res.json({
        success: true,
        data: {
          has_subscription: false,
          status: 'none',
          plan_slug: null,
          follow_up_allowed: false,
          follow_ups_used: 0,
          follow_up_limit: 0,
          follow_ups_remaining: 0,
          max_customers: 0,
          max_whatsapp_numbers: 0
        }
      });
    }

    const now = new Date();
    const isExpired = sub.current_period_end && new Date(sub.current_period_end) < now;
    const effectiveStatus = isExpired && sub.status === 'active' ? 'expired' : sub.status;
    const plan = sub.Plan;
    const limit = plan?.follow_up_limit ?? null;
    const used = sub.follow_ups_used || 0;

    return res.json({
      success: true,
      data: {
        has_subscription: true,
        status: effectiveStatus,
        is_active: effectiveStatus === 'active',
        plan_slug: plan?.slug || null,
        plan_name: plan?.name || null,
        current_period_end: sub.current_period_end,
        follow_up_allowed: effectiveStatus === 'active' && (limit === null || used < limit),
        follow_ups_used: used,
        follow_up_limit: limit,
        follow_ups_remaining: limit !== null ? Math.max(0, limit - used) : null,
        max_customers: plan?.max_customers ?? null,
        max_whatsapp_numbers: plan?.max_whatsapp_numbers ?? 1
      }
    });
  } catch (err) {
    console.error('getAgentSubscriptionStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch subscription status' });
  }
}

/**
 * POST /api/v1/whatsapp-plans/agent/use-followup
 * Called by the AI agent BEFORE sending any follow-up message outside the 24h window.
 * Atomically checks the plan limit and increments the counter if allowed.
 *
 * Body: { tenant_id: 42 }
 * No auth required — internal service call only.
 */
async function useFollowUp(req, res) {
  try {
    const tenantId = parseInt(req.body.tenant_id, 10);
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenant_id is required' });
    }

    const result = await checkAndIncrementFollowUpUsage(tenantId);

    if (result.allowed) {
      return res.json({
        success: true,
        allowed: true,
        follow_ups_used: result.used ?? null,
        follow_up_limit: result.limit ?? null
      });
    }

    const messages = {
      no_subscription:          'Tenant has no WhatsApp AI subscription.',
      subscription_pending:     'Subscription payment is still pending.',
      subscription_cancelled:   'Subscription has been cancelled.',
      subscription_expired:     'Subscription has expired. Please renew to continue sending follow-ups.',
      follow_up_limit_reached:  `Follow-up limit reached (${result.used}/${result.limit}). Upgrade the plan to send more.`
    };

    return res.status(403).json({
      success: false,
      allowed: false,
      reason: result.reason,
      message: messages[result.reason] || 'Follow-up not allowed.',
      follow_ups_used: result.used ?? null,
      follow_up_limit: result.limit ?? null
    });
  } catch (err) {
    console.error('useFollowUp error:', err);
    // Fail open — don't block AI if DB is having issues
    return res.json({ success: true, allowed: true, fail_open: true });
  }
}

module.exports = {
  getPlans,
  getMySubscription,
  subscribeToPlan,
  cancelSubscription,
  handleWebhook,
  paymentCallback,
  getAgentSubscriptionStatus,
  useFollowUp,
  checkAndIncrementFollowUpUsage
};
