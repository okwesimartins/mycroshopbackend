const namecheapService = require('../services/namecheapService');
const sslService = require('../services/sslService');
const paymentController = require('./paymentController');
const axios = require('axios');

/**
 * Get USD to NGN exchange rate
 * Uses a free API to get current exchange rate
 */
async function getUSDToNGNExchangeRate() {
  try {
    // Try to get exchange rate from environment variable first (for stability)
    const envRate = process.env.USD_TO_NGN_RATE;
    if (envRate) {
      const rate = parseFloat(envRate);
      if (!isNaN(rate) && rate > 0) {
        console.log(`📊 Using exchange rate from .env: ${rate}`);
        return rate;
      }
    }
    
    // Fallback to API (you can use any exchange rate API)
    // Using exchangerate-api.com (free tier: 1,500 requests/month)
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', {
      timeout: 5000
    });
    
    const rate = response.data.rates.NGN;
    if (!rate || isNaN(rate) || rate <= 0) {
      throw new Error('Invalid exchange rate received');
    }
    
    console.log(`📊 Fetched exchange rate from API: 1 USD = ₦${rate}`);
    return rate;
  } catch (error) {
    console.error('Error fetching exchange rate:', error.message);
    // Fallback to a default rate if API fails
    const fallbackRate = 1500; // Default: 1 USD = ₦1500
    console.warn(`⚠️  Using fallback exchange rate: ${fallbackRate}`);
    return fallbackRate;
  }
}

/**
 * Check domain availability
 * GET /api/v1/domains/check?domain=example.com
 */
async function checkDomainAvailability(req, res) {
  try {
    const { domain } = req.query;

    if (!domain) {
      return res.status(400).json({
        success: false,
        message: 'Domain parameter is required'
      });
    }

    const result = await namecheapService.checkDomainAvailability(domain);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error checking domain availability:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check domain availability',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get domain pricing
 * GET /api/v1/domains/pricing?domain=example.com&years=1
 */
async function getDomainPricing(req, res) {
  try {
    const { domain, years = 1 } = req.query;

    if (!domain) {
      return res.status(400).json({
        success: false,
        message: 'Domain parameter is required'
      });
    }

    const pricing = await namecheapService.getDomainPricing(domain, parseInt(years));

    res.json({
      success: true,
      data: pricing
    });
  } catch (error) {
    console.error('Error getting domain pricing:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get domain pricing',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Checkout - Initialize domain purchase with payment
 * POST /api/v1/domains/checkout
 * 
 * Flow: User initiates checkout → Payment processed → Domain purchased from Namecheap
 */
async function checkoutDomain(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const {
      domain,
      years = 1,
      online_store_id,
      firstName,
      lastName,
      email,
      phone,
      address1,
      address2,
      city,
      stateProvince,
      postalCode,
      country = 'US',
      phoneExt = '',
      organization = '',
      jobTitle = '',
      callback_url
    } = req.body;

    // Validate required fields
    if (!domain || !firstName || !lastName || !email || !phone || !address1 || !city || !stateProvince || !postalCode) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: domain, firstName, lastName, email, phone, address1, city, stateProvince, postalCode'
      });
    }

    // Get tenant info
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      await transaction.rollback();
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Check if domain is already purchased by this tenant
    const existingDomain = await req.db.models.Domain.findOne({
      where: {
        domain_name: domain,
        ...(req.user?.tenant?.subscription_plan === 'free' ? { tenant_id: tenantId } : {})
      },
      transaction
    });

    if (existingDomain) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Domain already purchased'
      });
    }

    // Check domain availability first
    const availability = await namecheapService.checkDomainAvailability(domain);
    if (!availability.available) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Domain is not available for purchase',
        data: availability
      });
    }

    // Get pricing from Namecheap (always returns in USD)
    const pricing = await namecheapService.getDomainPricing(domain, years);
    
    // Get tenant country to determine billing currency
    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenantId);
    const tenantCountry = tenant?.country || 'Nigeria';
    
    // Determine billing currency based on tenant country
    const isNigeria = tenantCountry.toLowerCase() === 'nigeria' || tenantCountry.toLowerCase() === 'ng';
    const billingCurrency = isNigeria ? 'NGN' : 'USD';
    
    // Convert price based on currency
    let finalPrice;
    let finalCurrency;
    let exchangeRate = null;
    const bufferAmount = isNigeria ? 2000 : 0; // ₦2000 buffer for Nigeria only
    
    if (isNigeria) {
      // For Nigeria: Convert USD to NGN + add ₦2000 buffer
      exchangeRate = await getUSDToNGNExchangeRate();
      const convertedPrice = pricing.totalPrice * exchangeRate;
      finalPrice = convertedPrice + bufferAmount;
      finalCurrency = 'NGN';
      
      console.log(`💰 Currency conversion for Nigeria: $${pricing.totalPrice} USD × ${exchangeRate} = ₦${convertedPrice} + ₦${bufferAmount} buffer = ₦${finalPrice}`);
    } else {
      // For other countries: Use USD as-is (what Namecheap returns)
      finalPrice = pricing.totalPrice;
      finalCurrency = 'USD';
      
      console.log(`💰 Using USD for ${tenantCountry}: $${finalPrice}`);
    }

    // Create pending domain record (will be activated after payment)
    const domainRecord = await req.db.models.Domain.create({
      tenant_id: req.user?.tenant?.subscription_plan === 'free' ? tenantId : null,
      domain_name: domain,
      online_store_id: online_store_id || null,
      status: 'pending', // Pending until payment is verified
      registration_date: null,
      expiration_date: null,
      auto_renew: true,
      namecheap_order_id: null,
      namecheap_transaction_id: null,
      price: pricing.totalPrice,
      currency: pricing.currency,
      years: years,
      registrant_info: {
        firstName,
        lastName,
        email,
        phone,
        address1,
        address2,
        city,
        stateProvince,
        postalCode,
        country,
        organization
      }
    }, { transaction });

    // Prepare payment metadata for domain purchase
    const paymentMetadata = {
      domain_id: domainRecord.id,
      domain_name: domain,
      years: years,
      online_store_id: online_store_id || null,
      purchase_type: 'domain',
      registrant_info: {
        firstName,
        lastName,
        email,
        phone,
        address1,
        address2,
        city,
        stateProvince,
        postalCode,
        country,
        organization
      }
    };

    // Commit domain record first (before payment initialization)
    await transaction.commit();

    // Initialize payment using MycroShop's Paystack account (from .env)
    // Domain purchases are processed by MycroShop admin, not tenant-specific gateways
    try {
      // Get MycroShop's Paystack keys from environment variables
      const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
      const paystackPublicKey = process.env.PAYSTACK_PUBLIC_KEY;
      const paystackTestMode = process.env.PAYSTACK_TEST_MODE === 'true' || process.env.NODE_ENV !== 'production';

      if (!paystackSecretKey || !paystackPublicKey) {
        // Delete domain record if Paystack not configured
        await domainRecord.destroy();
        return res.status(500).json({
          success: false,
          message: 'Payment gateway not configured. Please contact support.'
        });
      }

      // For domain purchases, MycroShop collects full amount (no platform fee split)
      // The platform fee is already included in the markup/buffer
      const platformFee = 0.00; // No additional fee - MycroShop keeps the markup
      const merchantAmount = parseFloat(finalPrice);

      // Generate transaction reference
      const crypto = require('crypto');
      const transactionReference = `DOMAIN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      // Create payment transaction record
      // Note: tenant_id is set to track which tenant purchased, but payment goes to MycroShop
      const paymentTransaction = await req.db.models.PaymentTransaction.create({
        tenant_id: req.user?.tenant?.subscription_plan === 'free' ? tenantId : null,
        transaction_reference: transactionReference,
        gateway_name: 'paystack',
        amount: parseFloat(finalPrice),
        currency: finalCurrency,
        platform_fee: platformFee,
        merchant_amount: merchantAmount,
        customer_email: email,
        customer_name: `${firstName} ${lastName}`,
        status: 'pending'
      });

      // Use MycroShop's Paystack secret key directly (from .env)
      const secretKey = paystackSecretKey;
      
      // Build final callback URL
      const defaultCallbackUrl = callback_url 
        || process.env.FRONTEND_URL 
        || process.env.BASE_URL 
        || 'https://backend.mycroshop.com';
      const finalCallbackUrl = callback_url 
        ? callback_url 
        : (defaultCallbackUrl.includes('/payment/callback') 
            ? defaultCallbackUrl 
            : `${defaultCallbackUrl}/payment/callback`);

      // Import payment functions from paymentController
      const paymentController = require('./paymentController');
      
      // Convert amount to smallest currency unit (kobo for NGN, cents for USD)
      const amountInSmallestUnit = finalCurrency === 'NGN' 
        ? parseFloat(finalPrice) * 100  // Paystack uses kobo for NGN
        : parseFloat(finalPrice) * 100; // Paystack uses cents for USD
      
      // Initialize payment with MycroShop's Paystack account
      const paymentData = await paymentController.initializePaystackPayment({
        amount: amountInSmallestUnit,
        email,
        reference: transactionReference,
        callback_url: finalCallbackUrl,
        metadata: paymentMetadata
      }, secretKey, paystackTestMode);

      // Update transaction with gateway response
      await paymentTransaction.update({
        gateway_transaction_id: paymentData.gateway_transaction_id || paymentData.reference,
        gateway_response: paymentData
      });

      paymentResponse = {
        success: true,
        data: {
          transaction_reference: transactionReference,
          authorization_url: paymentData.authorization_url,
          access_code: paymentData.access_code,
          gateway: 'paystack',
          amount: parseFloat(finalPrice),
          currency: finalCurrency,
          platform_fee: platformFee,
          merchant_amount: merchantAmount,
          original_price_usd: pricing.totalPrice,
          exchange_rate_applied: exchangeRate,
          buffer_added: bufferAmount,
          note: 'Payment processed by MycroShop. Domain will be purchased after successful payment.'
        }
      };
    } catch (paymentError) {
      // Delete domain record if payment initialization fails
      await domainRecord.destroy();
      return res.status(400).json({
        success: false,
        message: 'Failed to initialize payment',
        error: paymentError.message
      });
    }

    await transaction.commit();

    res.json({
      success: true,
      message: 'Domain checkout initialized. Please complete payment to purchase domain.',
      data: {
        domain_id: domainRecord.id,
        domain: domain,
        pricing: {
          pricePerYear: pricing.pricePerYear,
          totalPrice: pricing.totalPrice,
          currency: pricing.currency, // USD from Namecheap
          years: years,
          billingCurrency: finalCurrency,
          billingAmount: finalPrice,
          exchangeRate: exchangeRate,
          bufferAdded: bufferAmount
        },
        payment: {
          transaction_reference: paymentResponse.data.transaction_reference,
          authorization_url: paymentResponse.data.authorization_url,
          access_code: paymentResponse.data.access_code,
          amount: paymentResponse.data.amount,
          currency: paymentResponse.data.currency
        },
        note: 'After payment is successful, the domain will be automatically purchased and registered.'
      }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error initializing domain checkout:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initialize domain checkout',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Purchase/Register a domain (LEGACY - DEPRECATED)
 * POST /api/v1/domains/purchase
 * 
 * ⚠️  DEPRECATED: This endpoint is no longer recommended.
 * Use /api/v1/domains/checkout instead, which requires payment first.
 * 
 * This endpoint is kept for backward compatibility but will be removed in future versions.
 * It directly purchases from Namecheap without payment verification.
 */
async function purchaseDomain(req, res) {
  // ⚠️  DEPRECATED ENDPOINT - Redirect to checkout
  return res.status(410).json({
    success: false,
    message: 'This endpoint is deprecated. Please use POST /api/v1/domains/checkout instead.',
    deprecated: true,
    new_endpoint: '/api/v1/domains/checkout',
    reason: 'Direct domain purchase without payment verification is no longer supported. Use checkout flow to ensure payment is collected before purchasing from Namecheap.'
  });
  
  /* LEGACY CODE - KEPT FOR REFERENCE (DO NOT USE)
  
  const transaction = await req.db.transaction();
  
  try {
    const {
      domain,
      years = 1,
      online_store_id,
      firstName,
      lastName,
      email,
      phone,
      address1,
      address2,
      city,
      stateProvince,
      postalCode,
      country = 'US',
      phoneExt = '',
      organization = '',
      jobTitle = ''
    } = req.body;

    // Validate required fields
    if (!domain || !firstName || !lastName || !email || !phone || !address1 || !city || !stateProvince || !postalCode) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: domain, firstName, lastName, email, phone, address1, city, stateProvince, postalCode'
      });
    }

    // Get tenant info
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      await transaction.rollback();
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Check if domain is already purchased by this tenant
    const existingDomain = await req.db.models.Domain.findOne({
      where: {
        domain_name: domain,
        ...(req.user?.tenant?.subscription_plan === 'free' ? { tenant_id: tenantId } : {})
      },
      transaction
    });

    if (existingDomain) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Domain already purchased'
      });
    }

    // Check domain availability first
    const availability = await namecheapService.checkDomainAvailability(domain);
    if (!availability.available) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Domain is not available for purchase',
        data: availability
      });
    }

    // Get pricing
    const pricing = await namecheapService.getDomainPricing(domain, years);

    // Register domain with Namecheap
    const registrationResult = await namecheapService.registerDomain({
      domain,
      years,
      firstName,
      lastName,
      email,
      phone,
      address1,
      address2,
      city,
      stateProvince,
      postalCode,
      country,
      phoneExt,
      organization,
      jobTitle
    });

    if (!registrationResult.success || !registrationResult.registered) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Failed to register domain',
        data: registrationResult
      });
    }

    // Calculate expiration date
    const registrationDate = new Date();
    const expirationDate = new Date(registrationDate);
    expirationDate.setFullYear(expirationDate.getFullYear() + years);

    // Create domain record in database
    const domainRecord = await req.db.models.Domain.create({
      tenant_id: req.user?.tenant?.subscription_plan === 'free' ? tenantId : null,
      domain_name: domain,
      online_store_id: online_store_id || null,
      status: 'active',
      registration_date: registrationDate,
      expiration_date: expirationDate,
      auto_renew: true,
      namecheap_order_id: registrationResult.orderId,
      namecheap_transaction_id: registrationResult.transactionId,
      price: pricing.totalPrice,
      currency: pricing.currency,
      years: years,
      registrant_info: {
        firstName,
        lastName,
        email,
        phone,
        address1,
        address2,
        city,
        stateProvince,
        postalCode,
        country,
        organization
      }
    }, { transaction });

    // If online_store_id provided, update domain lookup table for fast routing
    if (online_store_id) {
      try {
        const { mainSequelize } = require('../config/database');
        const DomainLookup = mainSequelize.define('DomainLookup', {
          domain_name: require('sequelize').DataTypes.STRING(255),
          tenant_id: require('sequelize').DataTypes.INTEGER,
          online_store_id: require('sequelize').DataTypes.INTEGER,
          online_store_username: require('sequelize').DataTypes.STRING(100),
          subscription_plan: require('sequelize').DataTypes.ENUM('free', 'enterprise'),
          is_active: require('sequelize').DataTypes.BOOLEAN
        }, {
          tableName: 'domain_lookup',
          timestamps: true
        });

        const onlineStore = await req.db.models.OnlineStore.findByPk(online_store_id, { transaction });
        if (onlineStore) {
          await DomainLookup.upsert({
            domain_name: domain,
            tenant_id: tenantId,
            online_store_id: online_store_id,
            online_store_username: onlineStore.username,
            subscription_plan: req.user?.tenant?.subscription_plan || 'free',
            is_active: true
          });
        }
      } catch (lookupError) {
        console.error('Error updating domain lookup table:', lookupError);
        // Don't fail purchase if lookup update fails
      }
    }

    // If online_store_id provided, link domain to online store and auto-configure DNS
    let dnsConfigured = false;
    let sslProvisioned = false;
    
    if (online_store_id) {
      const onlineStore = await req.db.models.OnlineStore.findByPk(online_store_id, { transaction });
      if (onlineStore) {
        await onlineStore.update({
          custom_domain: domain
        }, { transaction });

        // Automatically configure DNS to point to MycroShop
        const mycroshopServerIp = process.env.MYCROSHOP_SERVER_IP || process.env.SERVER_IP;
        const mycroshopServerHost = process.env.MYCROSHOP_SERVER_HOST || process.env.SERVER_HOST;
        
        if (mycroshopServerIp || mycroshopServerHost) {
          try {
            const dnsRecords = [];
            
            // A record for root domain
            if (mycroshopServerIp) {
              dnsRecords.push({
                type: 'A',
                name: '@',
                address: mycroshopServerIp,
                ttl: '1800'
              });
            }
            
            // CNAME for www or A record
            if (mycroshopServerHost) {
              dnsRecords.push({
                type: 'CNAME',
                name: 'www',
                address: mycroshopServerHost,
                ttl: '1800'
              });
            } else if (mycroshopServerIp) {
              dnsRecords.push({
                type: 'A',
                name: 'www',
                address: mycroshopServerIp,
                ttl: '1800'
              });
            }

            if (dnsRecords.length > 0) {
              const dnsResult = await namecheapService.setDNSHostRecords(domain, dnsRecords);
              if (dnsResult.success) {
                await domainRecord.update({
                  dns_records: dnsRecords,
                  is_verified: true
                }, { transaction });
                dnsConfigured = true;
                console.log(`✅ DNS automatically configured for ${domain}`);
                
                // Provision SSL certificate after DNS is configured
                try {
                  console.log(`🔒 Initiating SSL certificate provisioning for ${domain}...`);
                  const sslResult = await sslService.provisionSSL(domain, onlineStore.username);
                  
                  if (sslResult.success) {
                    await domainRecord.update({
                      ssl_enabled: true
                    }, { transaction });
                    sslProvisioned = true;
                    console.log(`✅ SSL certificate provisioned successfully for ${domain}`);
                  } else {
                    console.warn(`⚠️  SSL provisioning failed: ${sslResult.message}`);
                  }
                } catch (sslError) {
                  console.error('Error provisioning SSL:', sslError);
                  // Don't fail purchase if SSL provisioning fails
                }
              }
            }
          } catch (dnsError) {
            console.error('Error auto-configuring DNS during purchase:', dnsError);
            // Don't fail purchase if DNS config fails
          }
        }
      }
    }

    await transaction.commit();

    // Fetch complete domain record
    const completeDomain = await req.db.models.Domain.findByPk(domainRecord.id, {
      include: [
        {
          model: req.db.models.OnlineStore,
          attributes: ['id', 'username', 'store_name', 'custom_domain']
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Domain purchased successfully',
      data: {
        domain: completeDomain,
        dns_auto_configured: dnsConfigured,
        ssl_provisioned: sslProvisioned,
        note: dnsConfigured 
          ? 'DNS has been automatically configured to point to MycroShop. SSL certificate provisioning may take a few minutes.'
          : 'Please configure DNS manually to point to your MycroShop server'
      }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error purchasing domain:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to purchase domain',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
  */
}

/**
 * Get all domains for the current tenant
 * GET /api/v1/domains
 */
async function getAllDomains(req, res) {
  try {
    const { page = 1, limit = 50, status, online_store_id } = req.query;
    const offset = (page - 1) * limit;

    const tenantId = req.user?.tenantId;
    const isFreePlan = req.user?.tenant?.subscription_plan === 'free';

    const where = {};
    if (isFreePlan && tenantId) {
      where.tenant_id = tenantId;
    }
    if (status) {
      where.status = status;
    }
    if (online_store_id) {
      where.online_store_id = online_store_id;
    }

    const { count, rows } = await req.db.models.Domain.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.OnlineStore,
          attributes: ['id', 'username', 'store_name', 'custom_domain']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        domains: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting domains:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get domains',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get domain by ID
 * GET /api/v1/domains/:id
 */
async function getDomainById(req, res) {
  try {
    const domain = await req.db.models.Domain.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.OnlineStore,
          attributes: ['id', 'username', 'store_name', 'custom_domain']
        }
      ]
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Check tenant access
    const tenantId = req.user?.tenantId;
    const isFreePlan = req.user?.tenant?.subscription_plan === 'free';
    if (isFreePlan && domain.tenant_id !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check SSL status
    let sslStatus = null;
    if (domain.ssl_enabled || domain.is_verified) {
      try {
        sslStatus = await sslService.checkSSLStatus(domain.domain_name);
      } catch (sslError) {
        console.warn('Could not check SSL status:', sslError);
      }
    }

    res.json({
      success: true,
      data: { 
        domain,
        ssl_status: sslStatus
      }
    });
  } catch (error) {
    console.error('Error getting domain:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get domain',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Link domain to online store
 * POST /api/v1/domains/:id/link
 */
async function linkDomainToStore(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const { online_store_id } = req.body;
    const domainId = req.params.id;

    if (!online_store_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'online_store_id is required'
      });
    }

    const domain = await req.db.models.Domain.findByPk(domainId, { transaction });
    if (!domain) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Check tenant access
    const tenantId = req.user?.tenantId;
    const isFreePlan = req.user?.tenant?.subscription_plan === 'free';
    if (isFreePlan && domain.tenant_id !== tenantId) {
      await transaction.rollback();
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const onlineStore = await req.db.models.OnlineStore.findByPk(online_store_id, { transaction });
    if (!onlineStore) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    // Check if another domain is already linked to this store
    if (onlineStore.custom_domain && onlineStore.custom_domain !== domain.domain_name) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `Online store already has a custom domain: ${onlineStore.custom_domain}`
      });
    }

    // Get MycroShop server IP/hostname for DNS configuration
    // This will point the domain to the MycroShop platform
    const mycroshopServerIp = process.env.MYCROSHOP_SERVER_IP || process.env.SERVER_IP;
    const mycroshopServerHost = process.env.MYCROSHOP_SERVER_HOST || process.env.SERVER_HOST;
    
    if (!mycroshopServerIp && !mycroshopServerHost) {
      console.warn('MYCROSHOP_SERVER_IP or MYCROSHOP_SERVER_HOST not configured. DNS will not be auto-configured.');
    }

    // Automatically configure DNS to point to MycroShop
    let dnsConfigured = false;
    let dnsRecords = [];
    
    if (mycroshopServerIp || mycroshopServerHost) {
      try {
        // Build DNS records to point domain to MycroShop
        // A record for root domain
        if (mycroshopServerIp) {
          dnsRecords.push({
            type: 'A',
            name: '@',
            address: mycroshopServerIp,
            ttl: '1800'
          });
        }
        
        // CNAME for www subdomain
        if (mycroshopServerHost) {
          dnsRecords.push({
            type: 'CNAME',
            name: 'www',
            address: mycroshopServerHost,
            ttl: '1800'
          });
        } else if (mycroshopServerIp) {
          // If no host, use A record for www too
          dnsRecords.push({
            type: 'A',
            name: 'www',
            address: mycroshopServerIp,
            ttl: '1800'
          });
        }

        // Configure DNS via Namecheap API
        if (dnsRecords.length > 0) {
          const dnsResult = await namecheapService.setDNSHostRecords(domain.domain_name, dnsRecords);
          dnsConfigured = dnsResult.success;
          
          if (dnsConfigured) {
            console.log(`✅ DNS automatically configured for ${domain.domain_name}`);
          }
        }
      } catch (dnsError) {
        console.error('Error auto-configuring DNS:', dnsError);
        // Don't fail the link if DNS config fails - user can configure manually later
      }
    }

    // Update domain
    await domain.update({
      online_store_id: online_store_id,
      dns_records: dnsRecords.length > 0 ? dnsRecords : domain.dns_records,
      is_verified: dnsConfigured
    }, { transaction });

    // Update online store
    await onlineStore.update({
      custom_domain: domain.domain_name
    }, { transaction });

    // Update domain lookup table in main database for fast routing
    // This allows the middleware to quickly find which tenant/store a domain belongs to
    try {
      const { mainSequelize } = require('../config/database');
      const DomainLookup = mainSequelize.define('DomainLookup', {
        domain_name: require('sequelize').DataTypes.STRING(255),
        tenant_id: require('sequelize').DataTypes.INTEGER,
        online_store_id: require('sequelize').DataTypes.INTEGER,
        online_store_username: require('sequelize').DataTypes.STRING(100),
        subscription_plan: require('sequelize').DataTypes.ENUM('free', 'enterprise'),
        is_active: require('sequelize').DataTypes.BOOLEAN
      }, {
        tableName: 'domain_lookup',
        timestamps: true
      });

      // Upsert domain lookup record
      await DomainLookup.upsert({
        domain_name: domain.domain_name,
        tenant_id: tenantId,
        online_store_id: online_store_id,
        online_store_username: onlineStore.username,
        subscription_plan: req.user?.tenant?.subscription_plan || 'free',
        is_active: true
      });
    } catch (lookupError) {
      console.error('Error updating domain lookup table:', lookupError);
      // Don't fail the link if lookup update fails
    }

    await transaction.commit();

    // Automatically provision SSL certificate after DNS is configured
    let sslProvisioned = false;
    if (dnsConfigured) {
      try {
        console.log(`🔒 Initiating SSL certificate provisioning for ${domain.domain_name}...`);
        
        // Provision SSL certificate (Let's Encrypt by default)
        const sslResult = await sslService.provisionSSL(domain.domain_name, onlineStore.username);
        
        if (sslResult.success) {
          await domain.update({
            ssl_enabled: true,
            status: 'active'
          });
          sslProvisioned = true;
          console.log(`✅ SSL certificate provisioned successfully for ${domain.domain_name}`);
        } else {
          // SSL provisioning failed but don't block domain linking
          console.warn(`⚠️  SSL provisioning failed for ${domain.domain_name}: ${sslResult.message}`);
          await domain.update({
            ssl_enabled: false,
            status: 'active'
          });
        }
      } catch (sslError) {
        console.error('Error provisioning SSL certificate:', sslError);
        // Don't fail domain linking if SSL provisioning fails
        // SSL can be provisioned manually later
        await domain.update({
          ssl_enabled: false,
          status: 'active'
        });
      }
    }

    // Fetch updated records
    const updatedDomain = await req.db.models.Domain.findByPk(domainId, {
      include: [
        {
          model: req.db.models.OnlineStore,
          attributes: ['id', 'username', 'store_name', 'custom_domain']
        }
      ]
    });

    res.json({
      success: true,
      message: 'Domain linked to online store successfully',
      data: { 
        domain: updatedDomain,
        dns_configured: dnsConfigured,
        ssl_provisioned: sslProvisioned,
        note: dnsConfigured 
          ? 'DNS has been automatically configured to point to MycroShop'
          : 'Please configure DNS manually',
        ssl_note: sslProvisioned
          ? 'SSL certificate has been automatically provisioned'
          : 'SSL certificate provisioning may take a few minutes or require manual setup'
      }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error linking domain:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to link domain',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Unlink domain from online store
 * POST /api/v1/domains/:id/unlink
 */
async function unlinkDomainFromStore(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const domainId = req.params.id;

    const domain = await req.db.models.Domain.findByPk(domainId, {
      include: [
        {
          model: req.db.models.OnlineStore
        }
      ],
      transaction
    });

    if (!domain) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Check tenant access
    const tenantId = req.user?.tenantId;
    const isFreePlan = req.user?.tenant?.subscription_plan === 'free';
    if (isFreePlan && domain.tenant_id !== tenantId) {
      await transaction.rollback();
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const onlineStoreId = domain.online_store_id;

    // Update domain
    await domain.update({
      online_store_id: null
    }, { transaction });

    // Update online store if it exists
    if (onlineStoreId && domain.OnlineStore) {
      await domain.OnlineStore.update({
        custom_domain: null
      }, { transaction });
    }

    await transaction.commit();

    res.json({
      success: true,
      message: 'Domain unlinked from online store successfully'
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error unlinking domain:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unlink domain',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get DNS records for a domain
 * GET /api/v1/domains/:id/dns
 */
async function getDNSRecords(req, res) {
  try {
    const domain = await req.db.models.Domain.findByPk(req.params.id);

    if (!domain) {
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Check tenant access
    const tenantId = req.user?.tenantId;
    const isFreePlan = req.user?.tenant?.subscription_plan === 'free';
    if (isFreePlan && domain.tenant_id !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const dnsRecords = await namecheapService.getDNSHostRecords(domain.domain_name);

    res.json({
      success: true,
      data: {
        domain: domain.domain_name,
        records: dnsRecords
      }
    });
  } catch (error) {
    console.error('Error getting DNS records:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get DNS records',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Update DNS records for a domain
 * PUT /api/v1/domains/:id/dns
 */
async function updateDNSRecords(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const { records } = req.body;
    const domainId = req.params.id;

    if (!Array.isArray(records) || records.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'records must be a non-empty array'
      });
    }

    const domain = await req.db.models.Domain.findByPk(domainId, { transaction });
    if (!domain) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Check tenant access
    const tenantId = req.user?.tenantId;
    const isFreePlan = req.user?.tenant?.subscription_plan === 'free';
    if (isFreePlan && domain.tenant_id !== tenantId) {
      await transaction.rollback();
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Update DNS records via Namecheap API
    const result = await namecheapService.setDNSHostRecords(domain.domain_name, records);

    if (!result.success) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Failed to update DNS records'
      });
    }

    // Update domain record in database
    await domain.update({
      dns_records: records
    }, { transaction });

    await transaction.commit();

    res.json({
      success: true,
      message: 'DNS records updated successfully',
      data: {
        domain: domain.domain_name,
        records
      }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating DNS records:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update DNS records',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Provision SSL certificate for a domain
 * POST /api/v1/domains/:id/ssl
 */
async function provisionSSL(req, res) {
  try {
    const domain = await req.db.models.Domain.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.OnlineStore,
          attributes: ['username']
        }
      ]
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Check tenant access
    const tenantId = req.user?.tenantId;
    const isFreePlan = req.user?.tenant?.subscription_plan === 'free';
    if (isFreePlan && domain.tenant_id !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Provision SSL certificate
    const sslResult = await sslService.provisionSSL(
      domain.domain_name, 
      domain.OnlineStore?.username || null
    );

    if (sslResult.success) {
      await domain.update({
        ssl_enabled: true
      });
    }

    res.json({
      success: sslResult.success,
      message: sslResult.message || 'SSL certificate provisioning initiated',
      data: {
        domain: domain.domain_name,
        ssl_result: sslResult
      }
    });
  } catch (error) {
    console.error('Error provisioning SSL:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to provision SSL certificate',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Check SSL status for a domain
 * GET /api/v1/domains/:id/ssl
 */
async function checkSSLStatus(req, res) {
  try {
    const domain = await req.db.models.Domain.findByPk(req.params.id);

    if (!domain) {
      return res.status(404).json({
        success: false,
        message: 'Domain not found'
      });
    }

    // Check tenant access
    const tenantId = req.user?.tenantId;
    const isFreePlan = req.user?.tenant?.subscription_plan === 'free';
    if (isFreePlan && domain.tenant_id !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const sslStatus = await sslService.checkSSLStatus(domain.domain_name);

    res.json({
      success: true,
      data: {
        domain: domain.domain_name,
        ssl_status: sslStatus
      }
    });
  } catch (error) {
    console.error('Error checking SSL status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check SSL status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Complete domain purchase after payment verification
 * This is called automatically by payment webhook after successful payment
 * @param {Object} domainData - Domain purchase data from payment metadata
 * @param {Object} models - Sequelize models
 * @param {Object} transaction - Database transaction
 */
async function completeDomainPurchase(domainData, models, transaction) {
  try {
    const {
      domain_id,
      domain_name,
      years,
      online_store_id,
      registrant_info
    } = domainData;

    // Find pending domain record
    const domainRecord = await models.Domain.findByPk(domain_id, { transaction });
    if (!domainRecord) {
      throw new Error(`Domain record not found: ${domain_id}`);
    }

    if (domainRecord.status !== 'pending') {
      console.log(`Domain ${domain_name} already processed. Status: ${domainRecord.status}`);
      return { success: true, alreadyProcessed: true, domain: domainRecord };
    }

    // Check domain availability
    const availability = await namecheapService.checkDomainAvailability(domain_name);
    if (!availability.available) {
      await domainRecord.update({
        status: 'cancelled'
      }, { transaction });
      throw new Error(`Domain ${domain_name} is no longer available`);
    }

    // Register domain with Namecheap
    const registrationResult = await namecheapService.registerDomain({
      domain: domain_name,
      years: years || 1,
      firstName: registrant_info.firstName,
      lastName: registrant_info.lastName,
      email: registrant_info.email,
      phone: registrant_info.phone,
      address1: registrant_info.address1,
      address2: registrant_info.address2,
      city: registrant_info.city,
      stateProvince: registrant_info.stateProvince,
      postalCode: registrant_info.postalCode,
      country: registrant_info.country,
      organization: registrant_info.organization || ''
    });

    if (!registrationResult.success || !registrationResult.registered) {
      await domainRecord.update({
        status: 'cancelled'
      }, { transaction });
      throw new Error(`Failed to register domain: ${registrationResult.message || 'Unknown error'}`);
    }

    // Calculate expiration date
    const registrationDate = new Date();
    const expirationDate = new Date(registrationDate);
    expirationDate.setFullYear(expirationDate.getFullYear() + (years || 1));

    // Update domain record with registration details
    await domainRecord.update({
      status: 'active',
      registration_date: registrationDate,
      expiration_date: expirationDate,
      namecheap_order_id: registrationResult.orderId,
      namecheap_transaction_id: registrationResult.transactionId,
      is_verified: true
    }, { transaction });

    // Update domain lookup table for fast routing
    if (online_store_id) {
      try {
        const { mainSequelize } = require('../config/database');
        const DomainLookup = mainSequelize.define('DomainLookup', {
          domain_name: require('sequelize').DataTypes.STRING(255),
          tenant_id: require('sequelize').DataTypes.INTEGER,
          online_store_id: require('sequelize').DataTypes.INTEGER,
          online_store_username: require('sequelize').DataTypes.STRING(100),
          subscription_plan: require('sequelize').DataTypes.ENUM('free', 'enterprise'),
          is_active: require('sequelize').DataTypes.BOOLEAN
        }, {
          tableName: 'domain_lookup',
          timestamps: true
        });

        const onlineStore = await models.OnlineStore.findByPk(online_store_id, { transaction });
        if (onlineStore) {
          // Get tenant_id from domain record
          const tenantId = domainRecord.tenant_id || (await models.Tenant?.findOne?.())?.id;
          
          await DomainLookup.upsert({
            domain_name: domain_name,
            tenant_id: tenantId,
            online_store_id: online_store_id,
            online_store_username: onlineStore.username,
            subscription_plan: domainRecord.tenant_id ? 'free' : 'enterprise',
            is_active: true
          });

          // Update online store custom_domain
          await onlineStore.update({
            custom_domain: domain_name
          }, { transaction });

          // Auto-configure DNS
          const mycroshopServerIp = process.env.MYCROSHOP_SERVER_IP || process.env.SERVER_IP;
          const mycroshopServerHost = process.env.MYCROSHOP_SERVER_HOST || process.env.SERVER_HOST;
          
          if (mycroshopServerIp || mycroshopServerHost) {
            try {
              const dnsRecords = [];
              if (mycroshopServerIp) {
                dnsRecords.push({
                  type: 'A',
                  name: '@',
                  address: mycroshopServerIp,
                  ttl: '1800'
                });
              }
              if (mycroshopServerHost) {
                dnsRecords.push({
                  type: 'CNAME',
                  name: 'www',
                  address: mycroshopServerHost,
                  ttl: '1800'
                });
              }

              if (dnsRecords.length > 0) {
                const dnsResult = await namecheapService.setDNSHostRecords(domain_name, dnsRecords);
                if (dnsResult.success) {
                  await domainRecord.update({
                    dns_records: dnsRecords
                  }, { transaction });
                  
                  // Provision SSL
                  try {
                    const sslResult = await sslService.provisionSSL(domain_name, onlineStore.username);
                    if (sslResult.success) {
                      await domainRecord.update({
                        ssl_enabled: true
                      }, { transaction });
                    }
                  } catch (sslError) {
                    console.error('SSL provisioning error:', sslError);
                  }
                }
              }
            } catch (dnsError) {
              console.error('DNS configuration error:', dnsError);
            }
          }
        }
      } catch (lookupError) {
        console.error('Error updating domain lookup:', lookupError);
      }
    }

    return { success: true, domain: domainRecord };
  } catch (error) {
    console.error('Error completing domain purchase:', error);
    throw error;
  }
}

module.exports = {
  checkDomainAvailability,
  getDomainPricing,
  checkoutDomain,
  purchaseDomain,
  completeDomainPurchase,
  getAllDomains,
  getDomainById,
  linkDomainToStore,
  unlinkDomainFromStore,
  getDNSRecords,
  updateDNSRecords,
  provisionSSL,
  checkSSLStatus
};
