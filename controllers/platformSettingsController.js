const crypto = require('crypto');
const { PlatformSetting } = require('../config/tenant');

// ─── Encryption (same algorithm as paymentGatewayController) ─────────────────

function encryptValue(plaintext) {
  const algorithm = 'aes-256-cbc';
  const key = Buffer.from(process.env.ENCRYPTION_KEY || 'default-key-32-characters-long!!', 'utf8');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptValue(encryptedText) {
  try {
    const algorithm = 'aes-256-cbc';
    const key = Buffer.from(process.env.ENCRYPTION_KEY || 'default-key-32-characters-long!!', 'utf8');
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('platformSettings decryptValue error:', err.message);
    return null;
  }
}

// ─── Internal helper (used by other controllers) ──────────────────────────────

/**
 * Get the plaintext value of a platform setting by key.
 * Falls back to the env variable of the same name (uppercased) if not set in DB.
 *
 * Usage:
 *   const secretKey = await getPlatformSettingValue('paystack_secret_key');
 */
async function getPlatformSettingValue(key) {
  try {
    const row = await PlatformSetting.findOne({ where: { key } });
    if (!row || !row.value) {
      // Fallback to env var (e.g. PAYSTACK_SECRET_KEY)
      return process.env[key.toUpperCase()] || null;
    }
    return row.is_secret ? decryptValue(row.value) : row.value;
  } catch (err) {
    console.error(`getPlatformSettingValue(${key}) error:`, err.message);
    // Always fall back to env so the app keeps running
    return process.env[key.toUpperCase()] || null;
  }
}

// ─── API handlers ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/platform-admin/settings
 * List all platform settings. Secret values are masked.
 */
async function getSettings(req, res) {
  try {
    const rows = await PlatformSetting.findAll({
      order: [['group', 'ASC'], ['key', 'ASC']],
      attributes: ['id', 'key', 'value', 'is_secret', 'label', 'group', 'created_at', 'updated_at']
    });

    const data = rows.map(r => ({
      id: r.id,
      key: r.key,
      value: r.is_secret ? (r.value ? '••••••••' : null) : r.value,
      is_secret: Boolean(r.is_secret),
      label: r.label,
      group: r.group,
      is_set: Boolean(r.value),
      created_at: r.created_at,
      updated_at: r.updated_at
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error('getSettings error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch settings' });
  }
}

/**
 * PUT /api/v1/platform-admin/settings/:key
 * Create or update a platform setting.
 *
 * Body: { value, label?, group?, is_secret? }
 *
 * Predefined keys (auto-sets is_secret and label if not provided):
 *   paystack_secret_key, paystack_public_key, paystack_webhook_secret,
 *   gemini_api_key, sendgrid_api_key
 */
async function upsertSetting(req, res) {
  try {
    const { key } = req.params;
    const { value, label, group, is_secret } = req.body;

    if (!key) {
      return res.status(400).json({ success: false, message: 'Setting key is required' });
    }
    if (value === undefined || value === null || String(value).trim() === '') {
      return res.status(400).json({ success: false, message: 'value is required' });
    }

    // Defaults for well-known keys
    const knownKeys = {
      paystack_secret_key:      { label: 'Paystack Secret Key',      group: 'paystack', is_secret: true },
      paystack_public_key:      { label: 'Paystack Public Key',       group: 'paystack', is_secret: false },
      paystack_webhook_secret:  { label: 'Paystack Webhook Secret',   group: 'paystack', is_secret: true },
      gemini_api_key:           { label: 'Gemini API Key',            group: 'gemini',   is_secret: true },
      sendgrid_api_key:         { label: 'SendGrid API Key',          group: 'email',    is_secret: true },
      frontend_url:             { label: 'Frontend Base URL',         group: 'general',  is_secret: false },
      base_url:                 { label: 'Backend Base URL',          group: 'general',  is_secret: false }
    };

    const defaults = knownKeys[key] || {};
    const finalIsSecret = is_secret !== undefined ? Boolean(is_secret) : Boolean(defaults.is_secret);
    const finalLabel    = label  || defaults.label  || key;
    const finalGroup    = group  || defaults.group  || 'general';

    const storedValue = finalIsSecret ? encryptValue(String(value)) : String(value);

    const [row, created] = await PlatformSetting.findOrCreate({
      where: { key },
      defaults: {
        key,
        value: storedValue,
        is_secret: finalIsSecret,
        label: finalLabel,
        group: finalGroup
      }
    });

    if (!created) {
      await row.update({
        value: storedValue,
        is_secret: finalIsSecret,
        label: finalLabel,
        group: finalGroup,
        updated_at: new Date()
      });
    }

    return res.json({
      success: true,
      message: created ? 'Setting created' : 'Setting updated',
      data: {
        key,
        is_secret: finalIsSecret,
        label: finalLabel,
        group: finalGroup,
        is_set: true
      }
    });
  } catch (err) {
    console.error('upsertSetting error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save setting' });
  }
}

/**
 * DELETE /api/v1/platform-admin/settings/:key
 * Remove a platform setting (value will fall back to env var).
 */
async function deleteSetting(req, res) {
  try {
    const { key } = req.params;
    const deleted = await PlatformSetting.destroy({ where: { key } });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Setting not found' });
    }
    return res.json({ success: true, message: 'Setting deleted. Will fall back to environment variable.' });
  } catch (err) {
    console.error('deleteSetting error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete setting' });
  }
}

/**
 * POST /api/v1/platform-admin/settings/test-paystack
 * Verify that the stored Paystack keys work by calling Paystack's /bank endpoint.
 */
async function testPaystackKeys(req, res) {
  try {
    const axios = require('axios');
    const secretKey = await getPlatformSettingValue('paystack_secret_key');

    if (!secretKey) {
      return res.status(400).json({
        success: false,
        message: 'paystack_secret_key is not set. Add it via PUT /api/v1/platform-admin/settings/paystack_secret_key'
      });
    }

    const response = await axios.get('https://api.paystack.co/bank?country=nigeria&perPage=1', {
      headers: { Authorization: `Bearer ${secretKey}` },
      timeout: 10000
    });

    if (response.data?.status) {
      return res.json({ success: true, message: 'Paystack secret key is valid and working.' });
    }
    return res.status(400).json({ success: false, message: 'Paystack returned unexpected response.' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    return res.status(400).json({ success: false, message: `Paystack key test failed: ${msg}` });
  }
}

module.exports = {
  getSettings,
  upsertSetting,
  deleteSetting,
  testPaystackKeys,
  getPlatformSettingValue   // exported for use by whatsappPlanController etc.
};
