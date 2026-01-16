const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

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

// Create upload directories if they don't exist
const uploadDirs = ['uploads/logos', 'uploads/stores', 'uploads/services'];
uploadDirs.forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// Subdomain identification (for web access via subdomain)
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

