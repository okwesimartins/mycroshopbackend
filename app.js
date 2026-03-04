const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const whatsappClient = require('./ai-sales-agent/lib/whatsapp');
const { mainSequelize } = require('./config/database');
const { processMessage: processAiSalesMessage } = require('./ai-sales-agent/functions/process-message');

const app = express();

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow serving images cross-origin
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || '*',
  credentials: true
}));

// Capture raw body for webhook signature verification (e.g., WhatsApp)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// Serve static files (uploads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

// WhatsApp webhook (directly from Meta to backend)
app.get('/whatsappWebhook', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      console.log('WhatsApp webhook verified (backend)');
      return res.status(200).send(challenge);
    }

    console.warn('WhatsApp webhook verification failed (backend)', {
      mode,
      tokenProvided: !!token
    });
    return res.status(403).send('Forbidden');
  } catch (error) {
    console.error('Error in WhatsApp webhook verification (backend):', error);
    return res.status(500).send('Internal server error');
  }
});

app.post('/whatsappWebhook', async (req, res) => {
  try {
    console.log('Incoming WhatsApp webhook (backend)', {
      method: req.method,
      path: req.path,
      headers: {
        'x-hub-signature-256': req.headers['x-hub-signature-256'],
        'user-agent': req.headers['user-agent']
      }
    });

    const rawPayload = req.rawBody
      ? req.rawBody.toString('utf8')
      : JSON.stringify(req.body || {});

    const skipSignatureCheck = process.env.META_SKIP_SIGNATURE_CHECK === 'true';

    if (!skipSignatureCheck) {
      const signature = req.headers['x-hub-signature-256'];
      const isValid = whatsappClient.verifyWebhookSignature(
        signature,
        rawPayload,
        process.env.META_APP_SECRET
      );

      if (!isValid) {
        console.error('Invalid WhatsApp webhook signature (backend)');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } else {
      console.warn('Skipping WhatsApp webhook signature verification on backend because META_SKIP_SIGNATURE_CHECK=true');
    }

    const payload = req.body || {};
    const messageData = whatsappClient.parseWebhook(payload);

    if (!messageData) {
      console.log('WhatsApp webhook (backend): no message data in payload');
      return res.status(200).json({ status: 'ok' });
    }

    console.log('WhatsApp message received (backend):', messageData);

    // Look up tenant for this phone number ID from main database
    const [rows] = await mainSequelize.query(
      'SELECT tenant_id FROM whatsapp_connections WHERE phone_number_id = ? LIMIT 1',
      {
        replacements: [messageData.phoneNumberId]
      }
    );

    if (!rows || rows.length === 0) {
      console.error('No WhatsApp connection found for phone number ID (backend):', messageData.phoneNumberId);
      // Return 200 so Meta does not retry
      return res.status(200).json({ status: 'ok' });
    }

    const tenantId = rows[0].tenant_id;

    // Hand off to AI sales agent pipeline (Gemini + inventory + orders).
    // This function will handle:
    // - Reading tenant info and store name
    // - Checking inventory / orders / payments
    // - Generating a natural, human-like reply
    // - Sending the WhatsApp response via the Cloud API
    processAiSalesMessage({
      tenantId,
      customerPhone: messageData.from,
      message: messageData.text,
      messageId: messageData.messageId,
      phoneNumberId: messageData.phoneNumberId
    }).catch(error => {
      console.error('Error in AI sales message processing (backend):', error);
    });

    // Immediately acknowledge to Meta; reply is sent asynchronously by the AI pipeline
    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('WhatsApp webhook handler error (backend):', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;

