const { Sequelize } = require('sequelize');
const mysql = require('mysql2/promise');

// Main database connection (for tenant management)
const mainDbConfig = {
  host: process.env.MAIN_DB_HOST || 'localhost',
  port: process.env.MAIN_DB_PORT || 3306,
  user: process.env.MAIN_DB_USER || 'root',
  password: process.env.MAIN_DB_PASSWORD,
  database: process.env.MAIN_DB_NAME || 'mycroshop_main'
};

// Create main database connection
const mainSequelize = new Sequelize(
  mainDbConfig.database,
  mainDbConfig.user,
  mainDbConfig.password,
  {
    host: mainDbConfig.host,
    port: mainDbConfig.port,
    dialect: 'mysql',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    }
  }
);

// Store active tenant connections
const tenantConnections = new Map();

// Shared database for free tier users
const SHARED_FREE_DB_NAME = process.env.SHARED_FREE_DB_NAME || 'mycroshop_free_users';

/**
 * Get shared free tier database connection
 */
async function getSharedFreeDatabase() {
  if (tenantConnections.has('shared_free')) {
    return tenantConnections.get('shared_free');
  }

  const sequelize = new Sequelize(
    SHARED_FREE_DB_NAME,
    process.env.TENANT_DB_USER || 'root',
    process.env.TENANT_DB_PASSWORD,
    {
      host: process.env.TENANT_DB_HOST || 'localhost',
      port: process.env.TENANT_DB_PORT || 3306,
      dialect: 'mysql',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      pool: {
        max: 10,
        min: 0,
        acquire: 30000,
        idle: 10000
      }
    }
  );

  try {
    await sequelize.authenticate();
    tenantConnections.set('shared_free', sequelize);
    return sequelize;
  } catch (error) {
    throw new Error(`Shared free database connection failed`);
  }
}

/**
 * Initialize shared free tier database (run once)
 */
async function initializeSharedFreeDatabase() {
  const connection = await mysql.createConnection({
    host: process.env.TENANT_DB_HOST || 'localhost',
    port: process.env.TENANT_DB_PORT || 3306,
    user: process.env.TENANT_DB_USER || 'root',
    password: process.env.TENANT_DB_PASSWORD
  });

  try {
    // Create shared database
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${SHARED_FREE_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.query(`USE \`${SHARED_FREE_DB_NAME}\``);
    
    // Run migrations (same tables as tenant databases, but with tenant_id column)
    await runTenantMigrations(connection, true); // true = is shared database
    
    await connection.end();
    return SHARED_FREE_DB_NAME;
  } catch (error) {
    await connection.end();
    console.error(`Error initializing shared free database:`, error);
    throw error;
  }
}

/**
 * Get tenant database connection
 * Creates connection if it doesn't exist
 * For free tier, returns shared database connection
 */
async function getTenantConnection(tenantId, subscriptionPlan = 'enterprise') {
  // Free tier users use shared database
  if (subscriptionPlan === 'free') {
    return await getSharedFreeDatabase();
  }

  // Enterprise users get separate database
  if (tenantConnections.has(tenantId)) {
    return tenantConnections.get(tenantId);
  }

  const dbName = `${process.env.TENANT_DB_PREFIX || 'mycroshop_tenant_'}${tenantId}`;
  
  const sequelize = new Sequelize(
    dbName,
    process.env.TENANT_DB_USER || 'root',
    process.env.TENANT_DB_PASSWORD,
    {
      host: process.env.TENANT_DB_HOST || 'localhost',
      port: process.env.TENANT_DB_PORT || 3306,
      dialect: 'mysql',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
      }
    }
  );

  // Test connection
  try {
    await sequelize.authenticate();
    tenantConnections.set(tenantId, sequelize);
    return sequelize;
  } catch (error) {
    throw new Error(`Database connection failed for tenant ${tenantId}`);
  }
}

/**
 * Create a new tenant database (enterprise only)
 */
async function createTenantDatabase(tenantId) {
  const connection = await mysql.createConnection({
    host: process.env.TENANT_DB_HOST || 'localhost',
    port: process.env.TENANT_DB_PORT || 3306,
    user: process.env.TENANT_DB_USER || 'root',
    password: process.env.TENANT_DB_PASSWORD
  });

  const dbName = `${process.env.TENANT_DB_PREFIX || 'mycroshop_tenant_'}${tenantId}`;
  
  try {
    // Create database
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    
    // Switch to the new database
    await connection.query(`USE \`${dbName}\``);
    
    // Run migrations to create tables (false = not shared database)
    await runTenantMigrations(connection, false);
    
    await connection.end();
    return dbName;
  } catch (error) {
    await connection.end();
    console.error(`Error creating tenant database:`, error);
    throw error;
  }
}

/**
 * Run migrations for tenant database
 * @param {Connection} connection - MySQL connection
 * @param {boolean} isSharedDb - If true, adds tenant_id column to tables
 */
async function runTenantMigrations(connection, isSharedDb = false) {
  // Physical Stores table (must be created before products)
  const storeTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const storeTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS stores (
      ${storeTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      store_type ENUM('retail_store', 'warehouse', 'popup_store', 'online_only') DEFAULT 'retail_store',
      address TEXT,
      city VARCHAR(100),
      state VARCHAR(100),
      country VARCHAR(100),
      postal_code VARCHAR(20),
      phone VARCHAR(50),
      email VARCHAR(255),
      manager_name VARCHAR(255),
      opening_hours JSON,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${storeTenantIndex}
      INDEX idx_is_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Products table
  const productTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const productTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS products (
      ${productTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      sku VARCHAR(100) UNIQUE,
      barcode VARCHAR(100) UNIQUE,
      price DECIMAL(10, 2) DEFAULT 0.00, -- Can be NULL for products with variations
      cost_price DECIMAL(10, 2),
      stock INT DEFAULT 0,
      low_stock_threshold INT DEFAULT 10,
      category VARCHAR(100),
      image_url VARCHAR(500),
      expiry_date DATE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${productTenantIndex}
      INDEX idx_sku (sku),
      INDEX idx_barcode (barcode),
      INDEX idx_category (category),
      INDEX idx_is_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Product Stores table (many-to-many: products ↔ stores)
  const productStoreTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const productStoreTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS product_stores (
      ${productStoreTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      store_id INT NOT NULL,
      stock INT DEFAULT 0,
      price_override DECIMAL(10, 2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${productStoreTenantIndex}
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      UNIQUE KEY unique_product_store (product_id, store_id),
      INDEX idx_product_id (product_id),
      INDEX idx_store_id (store_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Customers table
  const customerTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const customerTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS customers (
      ${customerTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(50),
      address TEXT,
      city VARCHAR(100),
      state VARCHAR(100),
      country VARCHAR(100),
      customer_type ENUM('individual', 'business') DEFAULT 'individual',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${customerTenantIndex}
      INDEX idx_email (email),
      INDEX idx_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Invoices table
  const invoiceTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const invoiceTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      ${invoiceTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_number VARCHAR(50) UNIQUE NOT NULL,
      store_id INT,
      customer_id INT,
      issue_date DATE NOT NULL,
      due_date DATE,
      subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      tax_amount DECIMAL(10, 2) DEFAULT 0.00,
      vat_amount DECIMAL(10, 2) DEFAULT 0.00,
      development_levy_amount DECIMAL(10, 2) DEFAULT 0.00,
      other_tax_amount DECIMAL(10, 2) DEFAULT 0.00,
      tax_breakdown JSON,
      tax_calculation_method VARCHAR(50),
      discount_amount DECIMAL(10, 2) DEFAULT 0.00,
      total DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      status ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled') DEFAULT 'draft',
      payment_method VARCHAR(50),
      payment_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${invoiceTenantIndex}
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
      INDEX idx_invoice_number (invoice_number),
      INDEX idx_customer_id (customer_id),
      INDEX idx_store_id (store_id),
      INDEX idx_status (status),
      INDEX idx_issue_date (issue_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Add template and PDF columns to invoices table (if they don't exist)
  try {
    await connection.query(`
      ALTER TABLE invoices 
      ADD COLUMN IF NOT EXISTS template_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS template_data JSON,
      ADD COLUMN IF NOT EXISTS pdf_url VARCHAR(500),
      ADD COLUMN IF NOT EXISTS preview_url VARCHAR(500)
    `);
  } catch (error) {
    // Columns might already exist, ignore
    console.log('Invoice template columns may already exist');
  }

  // Invoice Items table
  const invoiceItemTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const invoiceItemTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      ${invoiceItemTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      product_id INT,
      item_name VARCHAR(255) NOT NULL,
      description TEXT,
      quantity DECIMAL(10, 2) NOT NULL,
      unit_price DECIMAL(10, 2) NOT NULL,
      original_price DECIMAL(10, 2),
      discount_percentage DECIMAL(5, 2) DEFAULT 0.00,
      discount_amount DECIMAL(10, 2) DEFAULT 0.00,
      total DECIMAL(10, 2) NOT NULL,
      is_bundled BOOLEAN DEFAULT FALSE,
      bundle_id INT,
      bundle_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${invoiceItemTenantIndex}
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
      INDEX idx_invoice_id (invoice_id),
      INDEX idx_product_id (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Online Stores table (complete schema matching models)
  const onlineStoreTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const onlineStoreTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS online_stores (
      ${onlineStoreTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      store_name VARCHAR(255) NOT NULL,
      store_description TEXT,
      profile_logo_url VARCHAR(500),
      banner_image_url VARCHAR(500),
      background_image_url VARCHAR(500),
      background_color VARCHAR(7) DEFAULT '#F2EFEF',
      button_style ENUM('rounded', 'square', 'pill') DEFAULT 'rounded',
      button_color VARCHAR(7) DEFAULT '#78716C',
      button_font_color VARCHAR(7) DEFAULT '#FFFFFF',
      is_location_based BOOLEAN DEFAULT FALSE,
      show_location BOOLEAN DEFAULT TRUE,
      allow_delivery_datetime BOOLEAN DEFAULT FALSE,
      social_links JSON,
      is_published BOOLEAN DEFAULT FALSE,
      setup_completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${onlineStoreTenantIndex}
      INDEX idx_username (username),
      INDEX idx_is_published (is_published)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Online Store Locations table (links online stores to physical stores)
  const onlineStoreLocationTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const onlineStoreLocationTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS online_store_locations (
      ${onlineStoreLocationTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      online_store_id INT NOT NULL,
      store_id INT NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${onlineStoreLocationTenantIndex}
      FOREIGN KEY (online_store_id) REFERENCES online_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      UNIQUE KEY unique_online_store_location (online_store_id, store_id),
      INDEX idx_online_store_id (online_store_id),
      INDEX idx_store_id (store_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Store Products table (for publishing products to online store)
  const storeProductTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const storeProductTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS store_products (
      ${storeProductTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      is_published BOOLEAN DEFAULT FALSE,
      featured BOOLEAN DEFAULT FALSE,
      sort_order INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${storeProductTenantIndex}
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      UNIQUE KEY unique_store_product (product_id),
      INDEX idx_is_published (is_published),
      INDEX idx_featured (featured)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Store Services table (services that can be booked)
  const storeServiceTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const storeServiceTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS store_services (
      ${storeServiceTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id INT NULL,
      description TEXT,
      price DECIMAL(10, 2),
      service_image_url VARCHAR(500),
      duration_minutes INT DEFAULT 30,
      location_type ENUM('in_person', 'online', 'both') DEFAULT 'in_person',
      availability JSON,
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${storeServiceTenantIndex}
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      INDEX idx_store_id (store_id),
      INDEX idx_is_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Online Store Services table (links services to online stores)
  const onlineStoreServiceTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const onlineStoreServiceTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS online_store_services (
      ${onlineStoreServiceTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      online_store_id INT NOT NULL,
      service_id INT NOT NULL,
      is_visible BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${onlineStoreServiceTenantIndex}
      FOREIGN KEY (online_store_id) REFERENCES online_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES store_services(id) ON DELETE CASCADE,
      UNIQUE KEY unique_online_store_service (online_store_id, service_id),
      INDEX idx_online_store_id (online_store_id),
      INDEX idx_service_id (service_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Bookings table (Calendly-like service bookings)
  const bookingTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const bookingTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      ${bookingTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id INT,
      service_id INT,
      customer_id INT,
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      customer_phone VARCHAR(50),
      service_title VARCHAR(255) NOT NULL,
      description TEXT,
      scheduled_at DATETIME NOT NULL,
      duration_minutes INT DEFAULT 60,
      timezone VARCHAR(50) DEFAULT 'Africa/Lagos',
      location_type ENUM('in_person', 'online', 'both') DEFAULT 'in_person',
      meeting_link VARCHAR(500),
      staff_name VARCHAR(255),
      status ENUM('pending', 'confirmed', 'completed', 'cancelled', 'no_show') DEFAULT 'pending',
      cancellation_reason TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${bookingTenantIndex}
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      FOREIGN KEY (service_id) REFERENCES store_services(id) ON DELETE SET NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
      INDEX idx_store_id (store_id),
      INDEX idx_service_id (service_id),
      INDEX idx_customer_id (customer_id),
      INDEX idx_scheduled_at (scheduled_at),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Booking Availability table (for service availability slots)
  const bookingAvailabilityTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const bookingAvailabilityTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS booking_availability (
      ${bookingAvailabilityTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id INT NOT NULL,
      service_id INT,
      day_of_week TINYINT NOT NULL COMMENT '0=Sunday, 1=Monday, etc.',
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      is_available BOOLEAN DEFAULT TRUE,
      max_bookings_per_slot INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${bookingAvailabilityTenantIndex}
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES store_services(id) ON DELETE SET NULL,
      INDEX idx_store_id (store_id),
      INDEX idx_service_id (service_id),
      INDEX idx_day_of_week (day_of_week)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Store Collections table (for organizing products on the online storefront)
  const collectionTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const collectionTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';

  await connection.query(`
    CREATE TABLE IF NOT EXISTS store_collections (
      ${collectionTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      online_store_id INT NOT NULL,
      collection_name VARCHAR(255) NOT NULL,
      collection_type ENUM('product', 'service') NOT NULL DEFAULT 'product',
      layout_type ENUM('grid', 'list', 'carousel') DEFAULT 'grid',
      is_pinned BOOLEAN DEFAULT FALSE,
      is_visible BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${collectionTenantIndex}
      FOREIGN KEY (online_store_id) REFERENCES online_stores(id) ON DELETE CASCADE,
      INDEX idx_online_store_id (online_store_id),
      INDEX idx_sort_order (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Store Collection Products table (junction between collections, products, and physical stores)
  const collectionProductTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const collectionProductTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';

  await connection.query(`
    CREATE TABLE IF NOT EXISTS store_collection_products (
      ${collectionProductTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      collection_id INT NOT NULL,
      product_id INT NOT NULL,
      store_id INT NULL,
      is_pinned BOOLEAN DEFAULT FALSE,
      sort_order INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${collectionProductTenantIndex}
      FOREIGN KEY (collection_id) REFERENCES store_collections(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      INDEX idx_collection_id (collection_id),
      INDEX idx_product_id (product_id),
      INDEX idx_store_id (store_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Store Collection Services table (junction between collections and services)
  const collectionServiceTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const collectionServiceTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';

  await connection.query(`
    CREATE TABLE IF NOT EXISTS store_collection_services (
      ${collectionServiceTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      collection_id INT NOT NULL,
      service_id INT NOT NULL,
      store_id INT NULL,
      is_pinned BOOLEAN DEFAULT FALSE,
      sort_order INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${collectionServiceTenantIndex}
      FOREIGN KEY (collection_id) REFERENCES store_collections(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES store_services(id) ON DELETE CASCADE,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      INDEX idx_collection_id (collection_id),
      INDEX idx_service_id (service_id),
      INDEX idx_store_id (store_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Product Variations table (variation types like Color, Size, etc.)
  const productVariationTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const productVariationTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';

  await connection.query(`
    CREATE TABLE IF NOT EXISTS product_variations (
      ${productVariationTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      variation_name VARCHAR(100) NOT NULL,
      variation_type ENUM('color', 'size', 'material', 'style', 'length', 'width', 'height', 'weight', 'other') NOT NULL,
      is_required BOOLEAN DEFAULT FALSE,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${productVariationTenantIndex}
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      INDEX idx_product_id (product_id),
      INDEX idx_variation_type (variation_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Product Variation Options table (actual values like Red, Blue, Small, Large, etc.)
  const productVariationOptionTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const productVariationOptionTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';

  await connection.query(`
    CREATE TABLE IF NOT EXISTS product_variation_options (
      ${productVariationOptionTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      variation_id INT NOT NULL,
      option_value VARCHAR(255) NOT NULL,
      option_display_name VARCHAR(255),
      price_adjustment DECIMAL(10, 2) DEFAULT 0.00,
      stock INT DEFAULT 0,
      sku VARCHAR(100),
      image_url VARCHAR(500),
      is_default BOOLEAN DEFAULT FALSE,
      is_available BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${productVariationOptionTenantIndex}
      FOREIGN KEY (variation_id) REFERENCES product_variations(id) ON DELETE CASCADE,
      INDEX idx_variation_id (variation_id),
      INDEX idx_sku (sku),
      INDEX idx_is_available (is_available)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Online Store Orders table
  const orderTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const orderTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS online_store_orders (
      ${orderTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      online_store_id INT NOT NULL,
      store_id INT,
      order_number VARCHAR(50) NOT NULL,
      customer_name VARCHAR(255) NOT NULL,
      customer_email VARCHAR(255),
      customer_phone VARCHAR(50),
      customer_address TEXT,
      city VARCHAR(100),
      state VARCHAR(100),
      country VARCHAR(100),
      delivery_date DATE,
      delivery_time TIME,
      subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      tax_amount DECIMAL(10, 2) DEFAULT 0.00,
      shipping_amount DECIMAL(10, 2) DEFAULT 0.00,
      discount_amount DECIMAL(10, 2) DEFAULT 0.00,
      total DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      status ENUM('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending',
      payment_status ENUM('pending', 'paid', 'failed', 'refunded') DEFAULT 'pending',
      payment_method VARCHAR(50),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${orderTenantIndex}
      FOREIGN KEY (online_store_id) REFERENCES online_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      ${isSharedDb ? 'UNIQUE KEY unique_tenant_order_number (tenant_id, order_number),' : 'UNIQUE KEY unique_order_number (order_number),'}
      INDEX idx_order_number (order_number),
      INDEX idx_status (status),
      INDEX idx_payment_status (payment_status),
      INDEX idx_online_store_id (online_store_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Online Store Order Items table
  const orderItemTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const orderItemTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS online_store_order_items (
      ${orderItemTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      product_id INT,
      product_name VARCHAR(255) NOT NULL,
      product_sku VARCHAR(100),
      quantity DECIMAL(10, 2) NOT NULL,
      unit_price DECIMAL(10, 2) NOT NULL,
      total DECIMAL(10, 2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${orderItemTenantIndex}
      FOREIGN KEY (order_id) REFERENCES online_store_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
      INDEX idx_order_id (order_id),
      INDEX idx_product_id (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Staff table
  const staffTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const staffTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS staff (
      ${staffTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id INT,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE,
      phone VARCHAR(50),
      role_id INT,
      employee_id VARCHAR(50),
      hire_date DATE,
      salary DECIMAL(10, 2),
      status ENUM('active', 'inactive', 'suspended', 'terminated') DEFAULT 'active',
      last_login TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${staffTenantIndex}
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      INDEX idx_email (email),
      INDEX idx_role_id (role_id),
      INDEX idx_store_id (store_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Payment Gateways table
  const gatewayTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const gatewayTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS payment_gateways (
      ${gatewayTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      gateway_name ENUM('paystack', 'flutterwave', 'stripe', 'other') NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      is_default BOOLEAN DEFAULT FALSE,
      public_key VARCHAR(255) NOT NULL,
      secret_key VARCHAR(500) NOT NULL,
      webhook_secret VARCHAR(500),
      test_mode BOOLEAN DEFAULT FALSE,
      transaction_fee_percentage DECIMAL(5, 2) DEFAULT 0.00,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${gatewayTenantIndex}
      INDEX idx_gateway_name (gateway_name),
      INDEX idx_is_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Payment Transactions table
  const transactionTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const transactionTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      ${transactionTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT,
      invoice_id INT,
      transaction_reference VARCHAR(100) UNIQUE NOT NULL,
      gateway_name ENUM('paystack', 'flutterwave', 'stripe', 'other') NOT NULL,
      gateway_transaction_id VARCHAR(255),
      amount DECIMAL(10, 2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'NGN',
      platform_fee DECIMAL(10, 2) DEFAULT 0.00,
      merchant_amount DECIMAL(10, 2) NOT NULL,
      customer_email VARCHAR(255),
      customer_name VARCHAR(255),
      payment_method VARCHAR(50),
      status ENUM('pending', 'success', 'failed', 'cancelled', 'refunded') DEFAULT 'pending',
      gateway_response JSON,
      failure_reason TEXT,
      paid_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${transactionTenantIndex}
      INDEX idx_transaction_reference (transaction_reference),
      INDEX idx_gateway_transaction_id (gateway_transaction_id),
      INDEX idx_status (status),
      INDEX idx_order_id (order_id),
      INDEX idx_invoice_id (invoice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Brand Colors table (for invoice template color extraction and customization)
  const brandColorTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const brandColorTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS brand_colors (
      ${brandColorTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      logo_url VARCHAR(500),
      primary_color VARCHAR(7),
      secondary_color VARCHAR(7),
      accent_color VARCHAR(7),
      text_color VARCHAR(7),
      background_color VARCHAR(7),
      border_color VARCHAR(7),
      color_palette JSON,
      extracted_from_logo BOOLEAN DEFAULT FALSE,
      extracted_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${brandColorTenantIndex}
      UNIQUE KEY unique_tenant_brand_color (${isSharedDb ? 'tenant_id' : 'id'}),
      INDEX idx_tenant_id (${isSharedDb ? 'tenant_id' : 'id'})
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Invoice Templates table (stores generated template options for invoices)
  const invoiceTemplateTenantId = isSharedDb ? 'tenant_id INT NOT NULL,' : '';
  const invoiceTemplateTenantIndex = isSharedDb ? 'INDEX idx_tenant_id (tenant_id),' : '';
  
  await connection.query(`
    CREATE TABLE IF NOT EXISTS invoice_templates (
      ${invoiceTemplateTenantId}
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      template_id VARCHAR(100) NOT NULL,
      template_name VARCHAR(255),
      template_data JSON NOT NULL,
      preview_url VARCHAR(500),
      is_selected BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ${invoiceTemplateTenantIndex}
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      INDEX idx_invoice_id (invoice_id),
      INDEX idx_template_id (template_id),
      INDEX idx_is_selected (is_selected),
      UNIQUE KEY unique_invoice_template (invoice_id, template_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // All online store tables are now complete!
  // Note: Additional enterprise-only tables (roles, suppliers, purchase_orders, pos_transactions, etc.)
  // are not included here as free users only need online store functionality
}

/**
 * Close tenant connection
 */
function closeTenantConnection(tenantId) {
  if (tenantConnections.has(tenantId)) {
    const sequelize = tenantConnections.get(tenantId);
    sequelize.close();
    tenantConnections.delete(tenantId);
  }
}

/**
 * Migrate free user data to enterprise tenant database
 * Transfers all data from shared database to new tenant database
 */
async function migrateFreeUserToEnterprise(tenantId) {
  const connection = await mysql.createConnection({
    host: process.env.TENANT_DB_HOST || 'localhost',
    port: process.env.TENANT_DB_PORT || 3306,
    user: process.env.TENANT_DB_USER || 'root',
    password: process.env.TENANT_DB_PASSWORD
  });

  const sharedDbName = SHARED_FREE_DB_NAME;
  const newDbName = `${process.env.TENANT_DB_PREFIX || 'mycroshop_tenant_'}${tenantId}`;

  try {
    // Create new enterprise database
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${newDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.query(`USE \`${newDbName}\``);
    
    // Run migrations to create empty tables
    await runTenantMigrations(connection, false);
    
    // Migrate data from shared database (filtered by tenant_id)
    await connection.query(`USE \`${sharedDbName}\``);
    
    // Tables to migrate (in order due to foreign keys)
    const tablesToMigrate = [
      'stores',
      'products',
      'store_services',
      'customers',
      'invoices',
      'invoice_items',
      'bookings',
      'booking_availability',
      'online_stores',
      'online_store_locations',
      'store_products',
      'online_store_services',
      'store_collections',
      'store_collection_products',
      'store_collection_services',
      'online_store_orders',
      'online_store_order_items'
    ];

    // Migrate each table
    for (const table of tablesToMigrate) {
      try {
        // Get all rows for this tenant from shared DB
        const [rows] = await connection.query(
          `SELECT * FROM ${table} WHERE tenant_id = ?`,
          [tenantId]
        );

        if (rows.length > 0) {
          // Switch to new database
          await connection.query(`USE \`${newDbName}\``);
          
          // Get column names (excluding tenant_id since new DB doesn't have it)
          const [columns] = await connection.query(`DESCRIBE ${table}`);
          const columnNames = columns
            .filter(col => col.Field !== 'tenant_id')
            .map(col => col.Field);

          if (columnNames.length > 0) {
            // Insert rows (excluding tenant_id column)
            const values = rows.map(row => {
              const rowData = { ...row };
              delete rowData.tenant_id;
              return Object.values(rowData);
            });

            const placeholders = rows.map(() => `(${columnNames.map(() => '?').join(', ')})`).join(', ');
            const flatValues = values.flat();
            
            await connection.query(
              `INSERT INTO ${table} (${columnNames.join(', ')}) VALUES ${placeholders}`,
              flatValues
            );

            console.log(`Migrated ${rows.length} row(s) from ${table}`);
          }
        }
      } catch (error) {
        // Some tables might not exist or have no data, skip them
        console.warn(`Skipping ${table}: ${error.message}`);
      }
    }

    // Switch back to shared DB for cleanup
    await connection.query(`USE \`${sharedDbName}\``);
    
    await connection.end();
    
    console.log(`Migration completed for tenant ${tenantId}`);
    return newDbName;
  } catch (error) {
    await connection.end();
    console.error(`Error migrating free user to enterprise:`, error);
    throw error;
  }
}

module.exports = {
  mainSequelize,
  getTenantConnection,
  getSharedFreeDatabase,
  createTenantDatabase,
  initializeSharedFreeDatabase,
  closeTenantConnection,
  migrateFreeUserToEnterprise
};
