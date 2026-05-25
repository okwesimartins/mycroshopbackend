const { mainSequelize } = require('./database');
const { v4: uuidv4 } = require('uuid');

// Initialize main database models
const Tenant = mainSequelize.define('Tenant', {
  id: {
    type: require('sequelize').DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: require('sequelize').DataTypes.STRING,
    allowNull: false
  },
  subdomain: {
    type: require('sequelize').DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  db_name: {
    type: require('sequelize').DataTypes.STRING,
    allowNull: true, // Nullable for free tier users (they use shared database)
    unique: false, // Not unique - free users share same db_name, enterprise users have unique ones
    comment: 'NULL for free tier (uses shared database), unique value for enterprise (separate database)'
  },
  logo_url: {
    type: require('sequelize').DataTypes.STRING(500),
    allowNull: true
  },
  phone: {
    type: require('sequelize').DataTypes.STRING(50),
    allowNull: true
  },
  address: {
    type: require('sequelize').DataTypes.TEXT,
    allowNull: true
  },
  website: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: true
  },
  country: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: true,
    defaultValue: 'Nigeria'
  },
  business_type: {
    type: require('sequelize').DataTypes.ENUM('individual', 'company', 'partnership'),
    allowNull: true,
    defaultValue: 'company'
  },
  business_category: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: true,
    defaultValue: 'small_business'
  },
  annual_turnover: {
    type: require('sequelize').DataTypes.DECIMAL(15, 2),
    allowNull: true,
    comment: 'Annual turnover for tax exemption calculation (Nigeria: ≤ ₦100M exempt)'
  },
  total_fixed_assets: {
    type: require('sequelize').DataTypes.DECIMAL(15, 2),
    allowNull: true,
    comment: 'Total fixed assets for tax exemption calculation (Nigeria: ≤ ₦250M exempt)'
  },
  status: {
    type: require('sequelize').DataTypes.ENUM('active', 'suspended', 'inactive'),
    defaultValue: 'active'
  },
  subscription_plan: {
    type: require('sequelize').DataTypes.ENUM('free', 'enterprise'),
    defaultValue: 'free',
    comment: 'free = free tier with transaction fees, enterprise = paid license'
  },
  transaction_fee_percentage: {
    type: require('sequelize').DataTypes.DECIMAL(5, 2),
    defaultValue: 3.00,
    comment: 'Transaction fee percentage for free tier (e.g., 3.00 = 3%)'
  },
  business_bio: {
    type: require('sequelize').DataTypes.TEXT,
    allowNull: true,
    comment: 'Business info for AI sales agent: what the business does, delivery timeline, max discount/last-price rules. If no pricing instruction, AI sticks to exact product prices.'
  },
  payment_instruction_type: {
    type: require('sequelize').DataTypes.STRING(50),
    allowNull: true,
    defaultValue: 'paystack',
    comment: 'paystack | bank_transfer | paypal — what the AI shows after order (link vs account details)'
  },
  paypal_email: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: true,
    comment: 'PayPal email for receiving payments (when payment_instruction_type is paypal)'
  },
  bank_account_name: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: true,
    comment: 'Account name for bank transfer'
  },
  bank_name: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: true,
    comment: 'Bank name for transfer'
  },
  bank_account_number: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: true,
    comment: 'Account number for bank transfer'
  },
  bank_code: {
    type: require('sequelize').DataTypes.STRING(50),
    allowNull: true,
    comment: 'Bank code (e.g. for Nigeria)'
  },
  payment_instructions: {
    type: require('sequelize').DataTypes.TEXT,
    allowNull: true,
    comment: 'Custom message shown to customer after order (e.g. "Send receipt to this number after payment")'
  },
  created_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  },
  updated_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  }
}, {
  tableName: 'Tenant',
  timestamps: false
});

const User = mainSequelize.define('User', {
  id: {
    type: require('sequelize').DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  tenant_id: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'Tenant',
      key: 'id'
    },
    comment: 'NULL for platform admins (Mycroshop owners)'
  },
  email: {
    type: require('sequelize').DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  password_hash: {
    type: require('sequelize').DataTypes.STRING,
    allowNull: false
  },
  role: {
    type: require('sequelize').DataTypes.ENUM('platform_admin', 'admin', 'manager', 'staff'),
    defaultValue: 'admin'
  },
  is_platform_admin: {
    type: require('sequelize').DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'True for Mycroshop platform owners'
  },
  biometric_enabled: {
    type: require('sequelize').DataTypes.TINYINT(1),
    defaultValue: 0,
    comment: '1 = user has enabled biometric login on their mobile device'
  },
  created_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  }
}, {
  tableName: 'users',
  timestamps: false
});

// License Key Model
const LicenseKey = mainSequelize.define('LicenseKey', {
  id: {
    type: require('sequelize').DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  license_key: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: false,
    unique: true
  },
  status: {
    type: require('sequelize').DataTypes.ENUM('active', 'used', 'expired', 'revoked'),
    defaultValue: 'active'
  },
  tenant_id: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'Tenant',
      key: 'id'
    }
  },
  purchased_by: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: true
  },
  purchased_email: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: true
  },
  expires_at: {
    type: require('sequelize').DataTypes.DATE,
    allowNull: true
  },
  used_at: {
    type: require('sequelize').DataTypes.DATE,
    allowNull: true
  },
  created_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  }
}, {
  tableName: 'license_keys',
  timestamps: false
});

// Domain Lookup Model (for fast custom domain routing)
const DomainLookup = mainSequelize.define('DomainLookup', {
  id: {
    type: require('sequelize').DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  domain_name: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: false,
    unique: true
  },
  tenant_id: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'Tenant',
      key: 'id'
    }
  },
  online_store_id: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: false
  },
  online_store_username: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: true
  },
  subscription_plan: {
    type: require('sequelize').DataTypes.ENUM('free', 'enterprise'),
    allowNull: false
  },
  is_active: {
    type: require('sequelize').DataTypes.BOOLEAN,
    defaultValue: true
  },
  created_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  },
  updated_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  }
}, {
  tableName: 'domain_lookup',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

// Initialize main database tables
async function initializeMainDatabase() {
  try {
    await mainSequelize.authenticate();
    console.log('Main database connection established.');

    // Create tables if they don't exist
    await Tenant.sync({ alter: false });
    await User.sync({ alter: false });

    // Add business_bio to Tenant if missing (for AI sales agent context)
    try {
      const [cols] = await mainSequelize.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Tenant' AND COLUMN_NAME = 'business_bio'
      `);
      if (!cols || cols.length === 0) {
        await mainSequelize.query(`ALTER TABLE Tenant ADD COLUMN business_bio TEXT NULL COMMENT 'Business info for AI: what we do, delivery, discount/last-price rules' AFTER transaction_fee_percentage`);
        console.log('Added business_bio column to Tenant table.');
      }
    } catch (e) {
      console.warn('Tenant business_bio migration:', e.message);
    }

    // Add payment/account detail columns to Tenant for AI agent (bank transfer / PayPal flow)
    const paymentColumns = [
      'payment_instruction_type', 'paypal_email', 'bank_account_name', 'bank_name',
      'bank_account_number', 'bank_code', 'payment_instructions'
    ];
    for (const col of paymentColumns) {
      try {
        const [c] = await mainSequelize.query(`
          SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Tenant' AND COLUMN_NAME = ?
        `, { replacements: [col] });
        if (!c || c.length === 0) {
          const def = col === 'payment_instruction_type' ? " DEFAULT 'paystack'" : '';
          let sqlType = 'VARCHAR(255) NULL';
          if (col === 'payment_instructions') sqlType = 'TEXT NULL';
          else if (col === 'payment_instruction_type') sqlType = "VARCHAR(50) NULL DEFAULT 'paystack'";
          else if (col === 'bank_account_number' || col === 'bank_code') sqlType = 'VARCHAR(100) NULL';
          await mainSequelize.query(`ALTER TABLE Tenant ADD COLUMN ${col} ${sqlType} AFTER business_bio`);
          console.log('Added Tenant column:', col);
        }
      } catch (e) {
        console.warn('Tenant payment column', col, e.message);
      }
    }

    // Create tenant_configs table if needed
    await mainSequelize.query(`
      CREATE TABLE IF NOT EXISTS tenant_configs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        config_key VARCHAR(100) NOT NULL,
        config_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES Tenant(id) ON DELETE CASCADE,
        UNIQUE KEY unique_tenant_config (tenant_id, config_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Create license_keys table
    await LicenseKey.sync({ alter: false });

    // Create domain_lookup table for efficient custom domain routing
    // This table maps custom domains to tenant_id and online_store_id
    // Allows fast lookup without searching all tenant databases
    await mainSequelize.query(`
      CREATE TABLE IF NOT EXISTS domain_lookup (
        id INT AUTO_INCREMENT PRIMARY KEY,
        domain_name VARCHAR(255) NOT NULL UNIQUE,
        tenant_id INT NOT NULL,
        online_store_id INT NOT NULL,
        online_store_username VARCHAR(100),
        subscription_plan ENUM('free', 'enterprise') NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_domain_name (domain_name),
        INDEX idx_tenant_id (tenant_id),
        INDEX idx_online_store_id (online_store_id),
        INDEX idx_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('Main database tables initialized.');
  } catch (error) {
    console.error('Error initializing main database:', error);
    throw error;
  }
}

/**
 * Get tenant by ID
 */
async function getTenantById(tenantId) {
  return await Tenant.findByPk(tenantId);
}

/**
 * Get tenant by subdomain
 */
async function getTenantBySubdomain(subdomain) {
  return await Tenant.findOne({ where: { subdomain } });
}

/**
 * Get all tenants (for domain lookup across all tenants)
 */
async function getAllTenants() {
  return await Tenant.findAll({
    where: { status: 'active' },
    attributes: ['id', 'name', 'subdomain', 'subscription_plan']
  });
}

/**
 * Get tenant by user email
 * Returns null for platform admins (they don't have tenants)
 */
async function getTenantByUserEmail(email) {
  const user = await User.findOne({
    where: { email },
    include: [{ 
      model: Tenant,
      as: 'Tenant',
      required: false
    }]
  });
  
  // Platform admins don't have tenants
  if (user && (user.is_platform_admin || user.role === 'platform_admin')) {
    return null;
  }
  
  // If user has tenant_id but no tenant found via include, get it directly
  if (user && user.tenant_id && !user.Tenant) {
    return await Tenant.findByPk(user.tenant_id);
  }
  
  return user ? user.Tenant : null;
}

/**
 * Generate a unique license key
 */
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars
  let key = '';
  
  // Format: XXXX-XXXX-XXXX-XXXX
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) {
      key += '-';
    }
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return key;
}

/**
 * Create a license key
 */
async function createLicenseKey(licenseData) {
  let licenseKey;
  let isUnique = false;
  
  // Ensure unique license key
  while (!isUnique) {
    licenseKey = generateLicenseKey();
    const existing = await LicenseKey.findOne({ where: { license_key: licenseKey } });
    if (!existing) {
      isUnique = true;
    }
  }
  
  const license = await LicenseKey.create({
    license_key: licenseKey,
    status: 'active',
    ...licenseData
  });
  
  return license;
}

/**
 * Validate and use license key
 */
async function validateAndUseLicenseKey(licenseKey, email) {
  const license = await LicenseKey.findOne({ 
    where: { 
      license_key: licenseKey,
      status: 'active'
    }
  });
  
  if (!license) {
    return { valid: false, message: 'Invalid license key' };
  }
  
  // Check if already used
  if (license.status === 'used') {
    return { valid: false, message: 'License key has already been used' };
  }
  
  // Check expiration
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    await license.update({ status: 'expired' });
    return { valid: false, message: 'License key has expired' };
  }
  
  // Update license with user info
  await license.update({
    status: 'used',
    used_at: new Date(),
    purchased_email: email
  });
  
  return { valid: true, license };
}

/**
 * Create a new tenant (requires valid license key)
 */
async function createTenant(tenantData) {
  const { 
    name, 
    subdomain, 
    adminEmail, 
    adminPassword, 
    license_key,
    country = 'Nigeria',
    business_type = 'company',
    business_category = 'small_business',
    annual_turnover = null,
    total_fixed_assets = null
  } = tenantData;
  
  // Validate license key
  const licenseValidation = await validateAndUseLicenseKey(license_key, adminEmail);
  if (!licenseValidation.valid) {
    throw new Error(licenseValidation.message);
  }
  
  // Generate tenant ID
  const tenantId = Date.now(); // Simple ID generation, can be improved
  
  const dbName = `${process.env.TENANT_DB_PREFIX || 'mycroshop_tenant_'}${tenantId}`;
  
  // Create tenant record in main database (enterprise tier)
  const tenant = await Tenant.create({
    name,
    subdomain,
    db_name: dbName,
    country,
    business_type,
    business_category,
    annual_turnover: annual_turnover ? parseFloat(annual_turnover) : null,
    total_fixed_assets: total_fixed_assets ? parseFloat(total_fixed_assets) : null,
    subscription_plan: 'enterprise',
    transaction_fee_percentage: 0.00, // Enterprise has no transaction fees
    status: 'active'
  });

  // Link license to tenant
  await licenseValidation.license.update({ tenant_id: tenant.id });

  // Create tenant database
  const { createTenantDatabase } = require('./database');
  await createTenantDatabase(tenantId.toString());

  // Create admin user
  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  
  await User.create({
    tenant_id: tenant.id,
    email: adminEmail,
    password_hash: passwordHash,
    role: 'admin'
  });

  return tenant;
}

// Platform-level settings (Paystack keys, Gemini key, etc.) — managed by platform admins
const PlatformSetting = mainSequelize.define('PlatformSetting', {
  id: {
    type: require('sequelize').DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  key: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: false,
    unique: true,
    comment: 'Setting identifier, e.g. paystack_secret_key'
  },
  value: {
    type: require('sequelize').DataTypes.TEXT,
    allowNull: true,
    comment: 'Setting value. Encrypted when is_secret = true.'
  },
  is_secret: {
    type: require('sequelize').DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'true = value is AES-256-CBC encrypted at rest'
  },
  label: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: true,
    comment: 'Human-readable label shown in platform admin UI'
  },
  group: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: true,
    defaultValue: 'general',
    comment: 'Logical group: paystack | gemini | general | email'
  },
  created_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  },
  updated_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  }
}, {
  tableName: 'platform_settings',
  timestamps: false
});

// WhatsApp AI Sales Agent Plans (platform-level — stored in main DB)
const WhatsAppPlan = mainSequelize.define('WhatsAppPlan', {
  id: {
    type: require('sequelize').DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: false,
    comment: 'e.g. Starter, Growth, Scale, Enterprise'
  },
  slug: {
    type: require('sequelize').DataTypes.STRING(50),
    allowNull: false,
    unique: true,
    comment: 'URL-safe identifier: starter | growth | scale | enterprise'
  },
  price_kobo: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: true,
    comment: 'Monthly price in kobo (NGN × 100). NULL for Enterprise (custom pricing).'
  },
  max_customers: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: true,
    comment: 'Max monthly active customers. NULL = unlimited.'
  },
  max_whatsapp_numbers: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: 'Number of WhatsApp numbers allowed'
  },
  follow_up_limit: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: true,
    comment: 'Max AI follow-up messages per billing period (outside 24h free window). NULL = unlimited.'
  },
  features: {
    type: require('sequelize').DataTypes.JSON,
    allowNull: true,
    comment: 'Array of feature strings shown in pricing UI'
  },
  best_for: {
    type: require('sequelize').DataTypes.STRING(255),
    allowNull: true,
    comment: 'Short description of ideal customer segment'
  },
  is_custom: {
    type: require('sequelize').DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'true for Enterprise — no self-serve payment, requires contact'
  },
  is_active: {
    type: require('sequelize').DataTypes.BOOLEAN,
    defaultValue: true
  },
  sort_order: {
    type: require('sequelize').DataTypes.INTEGER,
    defaultValue: 0
  },
  created_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  }
}, {
  tableName: 'whatsapp_plans',
  timestamps: false
});

// WhatsApp AI Subscriptions — one active subscription per tenant
const WhatsAppSubscription = mainSequelize.define('WhatsAppSubscription', {
  id: {
    type: require('sequelize').DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  tenant_id: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'Tenant', key: 'id' }
  },
  plan_id: {
    type: require('sequelize').DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'whatsapp_plans', key: 'id' }
  },
  status: {
    type: require('sequelize').DataTypes.ENUM('pending', 'active', 'cancelled', 'expired'),
    defaultValue: 'pending'
  },
  paystack_reference: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: true,
    comment: 'Paystack transaction reference for last payment'
  },
  paystack_customer_code: {
    type: require('sequelize').DataTypes.STRING(100),
    allowNull: true
  },
  current_period_start: {
    type: require('sequelize').DataTypes.DATE,
    allowNull: true
  },
  current_period_end: {
    type: require('sequelize').DataTypes.DATE,
    allowNull: true,
    comment: 'Subscription expires after this date if not renewed'
  },
  follow_ups_used: {
    type: require('sequelize').DataTypes.INTEGER,
    defaultValue: 0,
    comment: 'AI follow-up messages sent outside 24h window in current billing period'
  },
  follow_up_reset_at: {
    type: require('sequelize').DataTypes.DATE,
    allowNull: true,
    comment: 'When follow_ups_used was last reset (start of billing period)'
  },
  cancelled_at: {
    type: require('sequelize').DataTypes.DATE,
    allowNull: true
  },
  created_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  },
  updated_at: {
    type: require('sequelize').DataTypes.DATE,
    defaultValue: require('sequelize').DataTypes.NOW
  }
}, {
  tableName: 'whatsapp_subscriptions',
  timestamps: false
});

// Define relationships between models
User.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'Tenant' });
Tenant.hasMany(User, { foreignKey: 'tenant_id', as: 'Users' });
LicenseKey.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'Tenant' });
Tenant.hasMany(LicenseKey, { foreignKey: 'tenant_id', as: 'LicenseKeys' });
DomainLookup.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'Tenant' });
Tenant.hasMany(DomainLookup, { foreignKey: 'tenant_id', as: 'DomainLookups' });
WhatsAppSubscription.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'Tenant' });
Tenant.hasOne(WhatsAppSubscription, { foreignKey: 'tenant_id', as: 'WhatsAppSubscription' });
WhatsAppSubscription.belongsTo(WhatsAppPlan, { foreignKey: 'plan_id', as: 'Plan' });
WhatsAppPlan.hasMany(WhatsAppSubscription, { foreignKey: 'plan_id', as: 'Subscriptions' });

module.exports = {
  Tenant,
  User,
  LicenseKey,
  DomainLookup,
  PlatformSetting,
  WhatsAppPlan,
  WhatsAppSubscription,
  initializeMainDatabase,
  getTenantById,
  getTenantBySubdomain,
  getTenantByUserEmail,
  getAllTenants,
  createTenant,
  createLicenseKey,
  validateAndUseLicenseKey,
  generateLicenseKey
};

