const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Tenant, getTenantBySubdomain } = require('../config/tenant');
const { getSharedFreeDatabase, initializeSharedFreeDatabase } = require('../config/database');
const { validationResult } = require('express-validator');

/**
 * Register a free user (no license key, no separate database)
 */
async function registerFreeUser(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { 
      name, 
      subdomain, 
      adminEmail, 
      adminPassword,
      country = 'Nigeria',
      business_type = 'company',
      business_category = 'small_business'
    } = req.body;

    // Check if subdomain already exists
    const existingTenant = await getTenantBySubdomain(subdomain);
    if (existingTenant) {
      return res.status(409).json({
        success: false,
        message: 'Subdomain already exists'
      });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ where: { email: adminEmail } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'Email already registered'
      });
    }

    // Generate tenant ID
    const tenantId = Date.now();

    // Create tenant record in main database (free tier, no separate DB)
    // db_name is NULL for free users - they use shared database
    const tenant = await Tenant.create({
      name,
      subdomain,
      db_name: null, // NULL for free tier - indicates shared database
      country,
      business_type,
      business_category,
      subscription_plan: 'free',
      transaction_fee_percentage: 3.00, // Default 3% transaction fee
      status: 'active'
    });

    // Ensure shared free database exists and is initialized
    try {
      await initializeSharedFreeDatabase();
    } catch (error) {
      console.error('Error initializing shared free database:', error);
      // Continue anyway - database might already exist
    }

    // Create admin user
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    
    await User.create({
      tenant_id: tenant.id,
      email: adminEmail,
      password_hash: passwordHash,
      role: 'admin'
    });

    res.status(201).json({
      success: true,
      message: 'Free account registered successfully',
      data: {
        tenantId: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        subscription_plan: 'free',
        message: 'You can upgrade to enterprise by contacting support'
      }
    });
  } catch (error) {
    console.error('Free user registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  registerFreeUser
};

