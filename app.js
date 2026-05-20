const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// ── OAuth callback for WhatsApp popup flow ────────────────────────────────────
// Registered BEFORE Helmet so no CSP header is set — inline script must run freely.
// Facebook redirects the popup here after the user authorizes.
app.get('/connect/whatsapp/callback', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Connecting WhatsApp…</title>
  <style>
    body { margin:0; display:flex; align-items:center; justify-content:center;
           min-height:100vh; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
           background:#f0f4ff; }
    .card { background:#fff; border-radius:16px; padding:36px 28px; text-align:center;
            box-shadow:0 4px 24px rgba(0,0,0,.10); max-width:340px; width:100%; }
    .icon { font-size:36px; margin-bottom:12px; }
    p { color:#475569; font-size:14px; margin:0; }
  </style>
</head>
<body>
<div class="card">
  <div class="icon" id="icon">⏳</div>
  <p id="msg">Completing WhatsApp connection…</p>
</div>
<script>
(function () {
  var p     = new URLSearchParams(window.location.search);
  var code  = p.get('code');
  var state = p.get('state') || '';
  var err   = p.get('error');

  function notify(payload) {
    try {
      if (window.opener) {
        window.opener.postMessage(JSON.stringify(payload), window.location.origin);
      }
    } catch (_) {}
    setTimeout(function () { window.close(); }, 800);
  }

  if (err || !code) {
    document.getElementById('icon').textContent = '❌';
    document.getElementById('msg').textContent  = 'Authorization was cancelled or denied.';
    notify({ type: 'WHATSAPP_OAUTH_RESULT', success: false,
             error: err || 'No authorization code received' });
    return;
  }

  fetch('/api/v1/meta-connection/whatsapp/callback'
    + '?code='  + encodeURIComponent(code)
    + '&state=' + encodeURIComponent(state))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.success) {
        document.getElementById('icon').textContent = '✅';
        document.getElementById('msg').textContent  = 'WhatsApp connected! This window will close.';
      } else {
        document.getElementById('icon').textContent = '❌';
        document.getElementById('msg').textContent  = data.message || 'Connection failed.';
      }
      notify({
        type:            'WHATSAPP_OAUTH_RESULT',
        success:         !!data.success,
        phone_number:    (data.data && data.data.phone_number)    || null,
        phone_number_id: (data.data && data.data.phone_number_id) || null,
        error:           data.success ? null : (data.message || 'Connection failed')
      });
    })
    .catch(function () {
      document.getElementById('icon').textContent = '❌';
      document.getElementById('msg').textContent  = 'Network error. Please try again.';
      notify({ type: 'WHATSAPP_OAUTH_RESULT', success: false, error: 'Network error' });
    });
}());
</script>
</body>
</html>`);
});

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow serving images cross-origin
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || '*',
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (uploads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve public pages (e.g. WhatsApp embedded signup)
app.use('/public', express.static(path.join(__dirname, 'public')));

// WhatsApp connect page — short URL alias
// Uses standard OAuth popup (no FB SDK), so CSP only needs self + inline + external logo
// removeHeader clears Helmet's default CSP first to avoid duplicate header (Apache → 500)
app.get('/connect/whatsapp', (_req, res) => {
  res.removeHeader('Content-Security-Policy');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https://mycroshop.com; " +
    "connect-src 'self'"
  );
  res.sendFile(path.join(__dirname, 'public', 'whatsapp-connect.html'));
});

// Create upload directories if they don't exist
const uploadDirs = ['uploads/logos', 'uploads/stores', 'uploads/services'];
uploadDirs.forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// Custom domain identification (for custom domains pointing to MycroShop)
// This runs FIRST - checks for custom domains (e.g., customerstore.com)
// Technology: HTTP Host Header - server uses Host header to identify which online store to serve
const { identifyStoreByCustomDomain } = require('./middleware/customDomain');
app.use(identifyStoreByCustomDomain);

// Online store subdomain identification (for username.mycroshop.com)
// This runs SECOND - checks for online store subdomains (e.g., mystore.mycroshop.com)
// Allows users to access their online store before linking a custom domain
const { identifyStoreBySubdomain } = require('./middleware/onlineStoreSubdomain');
app.use(identifyStoreBySubdomain);

// Tenant subdomain identification (for tenant admin access via subdomain)
// This runs LAST - checks for tenant subdomains (e.g., tenantname.mycroshop.com)
const { identifyTenantBySubdomain } = require('./middleware/subdomain');
app.use(identifyTenantBySubdomain);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Routes
app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/inventory', require('./routes/inventory'));
app.use('/api/v1/invoices', require('./routes/invoices'));
app.use('/api/v1/customers', require('./routes/customers'));
app.use('/api/v1/bookings', require('./routes/bookings'));
app.use('/api/v1/store', require('./routes/store')); // Legacy store routes (for backward compatibility)
app.use('/api/v1/stores', require('./routes/stores')); // Physical store management (restricted for free users)
app.use('/api/v1/stores/online', require('./routes/onlineStores')); // Online store setup wizard
app.use('/api/v1/stores', require('./routes/storeCollections')); // Store collections management
app.use('/api/v1/stores', require('./routes/onlineStoreServices')); // Online store services (matches Figma flow)
app.use('/api/v1/store-services', require('./routes/storeServices')); // Legacy store services (for backward compatibility)
app.use('/api/v1/online-store-orders', require('./routes/onlineStoreOrders')); // Online store order management
app.use('/api/v1/domains', require('./routes/domains')); // Domain purchase and management
app.use('/api/v1/tax', require('./routes/tax')); // Tax information and calculation
app.use('/api/v1/pos', require('./routes/pos')); // POS system with barcode scanning
app.use('/api/v1/staff', require('./routes/staff')); // Staff management
app.use('/api/v1/roles', require('./routes/roles')); // Role and permission management
app.use('/api/v1/suppliers', require('./routes/suppliers')); // Supplier management
app.use('/api/v1/purchase-orders', require('./routes/purchaseOrders')); // Purchase order management
app.use('/api/v1/menus', require('./routes/menus')); // Menu management (restaurants)
app.use('/api/v1/product-bundles', require('./routes/productBundles')); // Product bundle management
app.use('/api/v1/expiry', require('./routes/expiry')); // Expiry date tracking
app.use('/api/v1/features', require('./routes/features')); // Business category features
app.use('/api/v1/receipts', require('./routes/receipts')); // Receipt printing
app.use('/api/v1/licenses', require('./routes/licenses')); // License key management (admin only)
app.use('/api/v1/meta-connection', require('./routes/metaConnection')); // Meta account connection
app.use('/api/v1/attendance', require('./routes/attendance')); // Staff attendance/clock-in system
app.use('/api/v1/staff-analytics', require('./routes/staffAnalytics')); // Staff analytics and insights
app.use('/api/v1/reports', require('./routes/reports')); // Reports and analytics
app.use('/api/v1/loyalty', require('./routes/loyalty')); // Loyalty program
app.use('/api/v1/platform-admin', require('./routes/platformAdmin')); // Platform admin (Mycroshop owners)
app.use('/api/v1/payment-gateways', require('./routes/paymentGateways')); // Payment gateway configuration
app.use('/api/v1/payments', require('./routes/payments')); // Payment processing
app.use('/api/v1/whatsapp-plans', require('./routes/whatsappPlans')); // WhatsApp AI Sales Agent plans & subscriptions
// AI Agent endpoints (for BMT to AI communication)
app.use('/api/v1/ai-agent', require('./routes/aiAgent'));
// AI Image Enhancement endpoints
app.use('/api/v1/ai-image', require('./routes/aiImageEnhancement'));

// Product Image Enhancement endpoints (with presets)
app.use('/api/v1/products/image-enhancement', require('./routes/productImageEnhancement'));

// Public store routes (no authentication required - for customers)
app.use('/api/v1/public-store', require('./routes/publicStore'));

// Public checkout routes (no authentication required - for customers)
app.use('/api/v1/public-checkout', require('./routes/publicCheckout'));

// Public booking routes (no authentication required - for customers)
app.use('/api/v1/public-bookings', require('./routes/publicBookings'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

const PORT = process.env.PORT || 3000;
const { initializeMainDatabaseTables } = require('./config/database');

// Initialize main DB tables (platform_settings, whatsapp_plans, whatsapp_subscriptions, etc.)
// Safe to call on every startup — uses CREATE TABLE IF NOT EXISTS
initializeMainDatabaseTables()
  .then(() => console.log('✅ Main database tables initialized'))
  .catch(err => console.error('⚠️  Main database table initialization error:', err.message));

// Analytics notifications are triggered by Linux cron scripts, not from app.js:
//   Daily:  scripts/sendDailyAnalytics.js   (cron: 0 20 * * *)
//   Weekly: scripts/sendWeeklyAnalytics.js  (cron: 0 9 * * 0)

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;

