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
 * Attach NGN pricing fields to a pricing object returned by namecheapService.
 * Always returns both the original USD values and the converted NGN values.
 */
async function attachNgnPricing(pricing) {
  const exchangeRate = await getUSDToNGNExchangeRate();
  const buffer       = parseFloat(process.env.DOMAIN_NGN_BUFFER || '2000');

  const pricePerYearNgn = Math.ceil(pricing.pricePerYear * exchangeRate + buffer);
  const totalPriceNgn   = Math.ceil(pricing.totalPrice   * exchangeRate + buffer * pricing.years);

  return {
    domain:         pricing.domain,
    tld:            pricing.tld,
    years:          pricing.years,
    // Primary display values — NGN
    pricePerYear:   pricePerYearNgn,
    totalPrice:     totalPriceNgn,
    currency:       'NGN',
    // Original USD values for reference
    pricePerYearUsd: pricing.pricePerYear,
    totalPriceUsd:   pricing.totalPrice,
    // Conversion details
    exchangeRate,
    bufferPerYear:  buffer,
    isSandbox:      pricing.isSandbox,
    note:           pricing.note || null
  };
}

/**
 * Check domain availability
 * GET /api/v1/domains/check?domain=example.com&years=1
 *
 * Returns availability + NGN pricing when the domain is available.
 */
async function checkDomainAvailability(req, res) {
  try {
    const { domain, years = 1 } = req.query;

    if (!domain) {
      return res.status(400).json({
        success: false,
        message: 'Domain parameter is required'
      });
    }

    // Surface credential errors clearly instead of a generic 500
    if (!process.env.NAMECHEAP_API_USER || !process.env.NAMECHEAP_API_KEY) {
      return res.status(503).json({
        success: false,
        message: 'Domain search is not configured yet. Please contact support.',
        error: 'namecheap_credentials_missing'
      });
    }

    const result  = await namecheapService.checkDomainAvailability(domain);

    // Fetch pricing and convert to NGN whenever domain is available
    let pricing = null;
    if (result.available) {
      try {
        const rawPricing = await namecheapService.getDomainPricing(domain, parseInt(years));
        pricing = await attachNgnPricing(rawPricing);
      } catch (pricingErr) {
        console.warn('Could not fetch pricing for available domain:', pricingErr.message);
      }
    }

    res.json({
      success: true,
      data: {
        ...result,
        pricing: pricing || null
      }
    });
  } catch (error) {
    console.error('Error checking domain availability:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check domain availability',
      error: error.message
    });
  }
}

/**
 * Get domain pricing
 * GET /api/v1/domains/pricing?domain=example.com&years=1
 *
 * Always returns both USD (from Namecheap) and NGN (converted) prices.
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

    if (!process.env.NAMECHEAP_API_USER || !process.env.NAMECHEAP_API_KEY) {
      return res.status(503).json({
        success: false,
        message: 'Domain pricing is not configured yet. Please contact support.',
        error: 'namecheap_credentials_missing'
      });
    }

    const rawPricing = await namecheapService.getDomainPricing(domain, parseInt(years));
    const pricing    = await attachNgnPricing(rawPricing);

    res.json({
      success: true,
      data: pricing
    });
  } catch (error) {
    console.error('Error getting domain pricing:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get domain pricing',
      error: error.message
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

    // Validate online_store_id if provided (must belong to this tenant)
    if (online_store_id) {
      const onlineStore = await req.db.models.OnlineStore.findOne({
        where: {
          id: online_store_id,
          tenant_id: tenantId // Ensure it belongs to this tenant
        },
        transaction
      });

      if (!onlineStore) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Online store not found or does not belong to your account'
        });
      }
    }

    // Create pending domain record (will be activated after payment)
    // ALWAYS set tenant_id from JWT token (required for both free and enterprise)
    const domainRecord = await req.db.models.Domain.create({
      tenant_id: tenantId, // Always set tenant_id from JWT token
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

    // Initialize payment using MycroShop's Paystack account (from .env)
    // Domain purchases are processed by MycroShop admin, not tenant-specific gateways
    let paymentResponse;
    try {
      // Get MycroShop's Paystack keys from environment variables
      const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
      const paystackPublicKey = process.env.PAYSTACK_PUBLIC_KEY;
      const paystackTestMode = process.env.PAYSTACK_TEST_MODE === 'true' || process.env.NODE_ENV !== 'production';

      if (!paystackSecretKey || !paystackPublicKey) {
        // Rollback transaction and delete domain record if Paystack not configured
        await transaction.rollback();
        try {
          await domainRecord.destroy();
        } catch (destroyError) {
          console.error('Error destroying domain record:', destroyError);
        }
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
      // Note: tenant_id is always set to track which tenant purchased (required by model)
      // Payment goes to MycroShop, but we track which tenant made the purchase
      const paymentTransaction = await req.db.models.PaymentTransaction.create({
        tenant_id: tenantId, // Always set tenant_id (required by model, even for enterprise users)
        transaction_reference: transactionReference,
        gateway_name: 'paystack',
        amount: parseFloat(finalPrice),
        currency: finalCurrency,
        platform_fee: platformFee,
        merchant_amount: merchantAmount,
        customer_email: email,
        customer_name: `${firstName} ${lastName}`,
        status: 'pending',
        // Store metadata directly in gateway_response for easy retrieval
        gateway_response: {
          metadata: paymentMetadata,
          data: {
            metadata: paymentMetadata
          },
          _domain_metadata: paymentMetadata // Backup location
        }
      });
      
      console.log('💾 Created payment transaction with metadata:', {
        transaction_id: paymentTransaction.id,
        reference: transactionReference,
        hasMetadata: !!paymentMetadata,
        purchaseType: paymentMetadata.purchase_type,
        domainId: paymentMetadata.domain_id
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
      let paymentData;
      try {
        paymentData = await paymentController.initializePaystackPayment({
          amount: amountInSmallestUnit,
          email,
          reference: transactionReference,
          callback_url: finalCallbackUrl,
          metadata: paymentMetadata
        }, secretKey, paystackTestMode);

        if (!paymentData || !paymentData.authorization_url) {
          throw new Error('Invalid payment data received from Paystack');
        }
      } catch (paystackError) {
        console.error('Paystack initialization error:', paystackError);
        throw new Error(`Paystack payment initialization failed: ${paystackError.message}`);
      }

      // Update transaction with gateway response
      // IMPORTANT: Merge with existing gateway_response to preserve metadata we stored during creation
      const existingGatewayResponse = paymentTransaction.gateway_response || {};
      const gatewayResponseWithMetadata = {
        ...existingGatewayResponse, // Preserve metadata we stored during creation
        ...paymentData, // Add Paystack response
        metadata: existingGatewayResponse.metadata || existingGatewayResponse._domain_metadata || paymentMetadata, // Preserve existing metadata
        data: {
          ...(existingGatewayResponse.data || {}),
          ...(paymentData.data || {}),
          metadata: existingGatewayResponse.data?.metadata || existingGatewayResponse._domain_metadata || paymentMetadata // Preserve existing metadata
        },
        _domain_metadata: existingGatewayResponse._domain_metadata || paymentMetadata // Backup location
      };
      
      console.log('💾 Updating gateway_response with Paystack data, preserving metadata:', {
        hasExistingMetadata: !!existingGatewayResponse.metadata,
        hasNewMetadata: !!paymentMetadata,
        finalMetadata: !!gatewayResponseWithMetadata.metadata,
        purchaseType: gatewayResponseWithMetadata.metadata?.purchase_type,
        domainId: gatewayResponseWithMetadata.metadata?.domain_id
      });
      
      await paymentTransaction.update({
        gateway_transaction_id: paymentData.gateway_transaction_id || paymentData.reference,
        gateway_response: gatewayResponseWithMetadata
      });
      
      // Verify metadata was stored correctly
      await paymentTransaction.reload();
      const storedMetadata = paymentTransaction.gateway_response?.metadata 
        || paymentTransaction.gateway_response?._domain_metadata
        || paymentTransaction.gateway_response?.data?.metadata;
      console.log('✅ Verified stored metadata after update:', {
        hasMetadata: !!storedMetadata,
        purchaseType: storedMetadata?.purchase_type,
        domainId: storedMetadata?.domain_id,
        metadataLocation: storedMetadata ? 'found' : 'NOT FOUND'
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
      // Rollback transaction and delete domain record if payment initialization fails
      await transaction.rollback();
      try {
        await domainRecord.destroy();
      } catch (destroyError) {
        console.error('Error destroying domain record:', destroyError);
      }
      console.error('Payment initialization error:', paymentError);
      return res.status(400).json({
        success: false,
        message: 'Failed to initialize payment',
        error: process.env.NODE_ENV === 'development' ? paymentError.message : undefined
      });
    }

    // Commit transaction after successful payment initialization
    await transaction.commit();

    // Ensure paymentResponse is defined before using it
    if (!paymentResponse || !paymentResponse.data) {
      console.error('Payment response is missing or invalid:', paymentResponse);
      return res.status(500).json({
        success: false,
        message: 'Payment initialization failed - no payment data received'
      });
    }

    // Ensure all required variables are defined
    if (typeof finalPrice === 'undefined' || typeof finalCurrency === 'undefined') {
      console.error('Currency variables not defined:', { finalPrice, finalCurrency, exchangeRate, bufferAmount });
      return res.status(500).json({
        success: false,
        message: 'Currency calculation error'
      });
    }

    try {
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
            exchangeRate: exchangeRate || null,
            bufferAdded: bufferAmount || 0
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
    } catch (responseError) {
      console.error('Error sending response:', responseError);
      // Response might have already been sent, but log the error
    }
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
          timestamps: true,
          createdAt: 'created_at',  // Map to snake_case column name
          updatedAt: 'updated_at'   // Map to snake_case column name
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
            
              // A record for www (should point to same IP as root domain)
              // For purchased domains, www should point to the server IP, not to mycroshop.com
              if (mycroshopServerIp) {
                dnsRecords.push({
                  type: 'A',
                  name: 'www',
                  address: mycroshopServerIp,
                  ttl: '1800'
                });
              } else if (mycroshopServerHost) {
                // Fallback: Use CNAME pointing to root domain itself
                dnsRecords.push({
                  type: 'CNAME',
                  name: 'www',
                  address: domain, // Point www to the root domain itself
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

    // Validate that the domain belongs to the tenant making the request
    // This ensures only the domain owner can view domain details
    const tenantId = req.user?.tenantId;
    if (domain.tenant_id !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view domains that you own.'
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

    // Validate that the domain belongs to the tenant making the request
    // This ensures only the domain owner can link it to a store
    const tenantId = req.user?.tenantId;
    if (domain.tenant_id !== tenantId) {
      await transaction.rollback();
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only link domains that you own.'
      });
    }

    // Validate that the online store exists AND belongs to this tenant
    const onlineStore = await req.db.models.OnlineStore.findOne({
      where: {
        id: online_store_id,
        tenant_id: tenantId // Ensure it belongs to this tenant
      },
      transaction
    });
    
    if (!onlineStore) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Online store not found or does not belong to your account'
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
        
        // A record for www subdomain (should point to same IP as root domain)
        // For purchased domains, www should point to the server IP, not to mycroshop.com
        if (mycroshopServerIp) {
          dnsRecords.push({
            type: 'A',
            name: 'www',
            address: mycroshopServerIp,
            ttl: '1800'
          });
        } else if (mycroshopServerHost) {
          // Fallback: Use CNAME pointing to root domain itself
          dnsRecords.push({
            type: 'CNAME',
            name: 'www',
            address: domain.domain_name, // Point www to the root domain itself
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

    // Validate that the domain belongs to the tenant making the request
    // This ensures only the domain owner can unlink it from a store
    const tenantId = req.user?.tenantId;
    if (domain.tenant_id !== tenantId) {
      await transaction.rollback();
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only unlink domains that you own.'
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

    // Validate that the domain belongs to the tenant making the request
    const tenantId = req.user?.tenantId;
    if (domain.tenant_id !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only view DNS records for domains that you own.'
      });
    }

    // Try to get DNS records from Namecheap API
    let dnsRecords = [];
    let apiError = null;
    let usingExternalDNS = false;
    let apiNote = null;
    
    try {
      const result = await namecheapService.getDNSHostRecords(domain.domain_name);
      dnsRecords = result.records || [];
      usingExternalDNS = result.usingExternalDNS || false;
      apiNote = result.note || null;
      apiError = result.error || null;
      
      console.log(`📡 DNS records from Namecheap API for ${domain.domain_name}:`, dnsRecords.length, 'records');
      
      if (usingExternalDNS) {
        console.log(`ℹ️  Domain ${domain.domain_name} is using external nameservers, not Namecheap DNS`);
      }
      
      if (apiError) {
        console.error(`⚠️  API returned error:`, apiError);
      }
    } catch (error) {
      console.error(`⚠️  Error fetching DNS records from Namecheap API:`, error.message);
      console.error(`   Error stack:`, error.stack);
      apiError = error.message || error.toString();
    }
    
    // If API returns empty or fails, use records saved in database as fallback
    const usingDatabaseRecords = dnsRecords.length === 0 && domain.dns_records && Array.isArray(domain.dns_records) && domain.dns_records.length > 0;
    if (usingDatabaseRecords) {
      console.log(`📦 Using DNS records from database as fallback (${domain.dns_records.length} records)`);
      dnsRecords = domain.dns_records;
    }

    // Build response data
    const responseData = {
      domain: domain.domain_name,
      records: dnsRecords,
      source: usingDatabaseRecords ? 'database' : 'namecheap_api',
      usingExternalDNS: usingExternalDNS
    };

    // Always include error if present
    if (apiError) {
      responseData.error = apiError;
      responseData.apiError = apiError; // Include both for compatibility
    }

    // Include note/explanation
    if (usingExternalDNS) {
      responseData.note = 'Domain is using external nameservers. DNS records are managed externally, not through Namecheap.';
    } else if (apiError) {
      responseData.note = `Namecheap API error: ${apiError}. ${usingDatabaseRecords ? 'Showing database records as fallback.' : 'No database records available.'}`;
    } else if (apiNote) {
      responseData.note = apiNote;
    } else if (dnsRecords.length === 0) {
      responseData.note = 'No DNS records found. Domain may not be fully configured yet, or there may be an issue with the API response.';
    }

    res.json({
      success: true,
      data: responseData
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

    // Validate that the domain belongs to the tenant making the request
    // This ensures only the domain owner can update DNS records
    const tenantId = req.user?.tenantId;
    if (domain.tenant_id !== tenantId) {
      await transaction.rollback();
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only update DNS records for domains that you own.'
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

    // Validate that the domain belongs to the tenant making the request
    // This ensures only the domain owner can provision SSL certificates
    const tenantId = req.user?.tenantId;
    if (domain.tenant_id !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only provision SSL certificates for domains that you own.'
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

    // Validate that the domain belongs to the tenant making the request
    // This ensures only the domain owner can check SSL status
    const tenantId = req.user?.tenantId;
    if (domain.tenant_id !== tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only check SSL status for domains that you own.'
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
    console.log(`🌐 Calling Namecheap API to register domain: ${domain_name}`);
    console.log(`📝 Registrant info:`, {
      firstName: registrant_info.firstName,
      lastName: registrant_info.lastName,
      email: registrant_info.email,
      country: registrant_info.country
    });
    
    let registrationResult;
    try {
      registrationResult = await namecheapService.registerDomain({
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
      
      console.log(`📦 Namecheap registration response:`, JSON.stringify(registrationResult, null, 2));
    } catch (namecheapError) {
      console.error(`❌ Namecheap API error:`, namecheapError);
      console.error(`   Error message:`, namecheapError.message);
      console.error(`   Error stack:`, namecheapError.stack);
      await domainRecord.update({
        status: 'cancelled'
      }, { transaction });
      throw new Error(`Namecheap API error: ${namecheapError.message}`);
    }

    if (!registrationResult) {
      await domainRecord.update({
        status: 'cancelled'
      }, { transaction });
      throw new Error('Namecheap API returned no response');
    }

    if (!registrationResult.success || !registrationResult.registered) {
      const errorMessage = registrationResult.message || 
                          `Domain registration failed. Success: ${registrationResult.success}, Registered: ${registrationResult.registered}`;
      console.error(`❌ Domain registration failed:`, errorMessage);
      console.error(`   Full response:`, JSON.stringify(registrationResult, null, 2));
      await domainRecord.update({
        status: 'cancelled'
      }, { transaction });
      throw new Error(errorMessage);
    }
    
    console.log(`✅ Namecheap registration successful:`, {
      domain: registrationResult.domain,
      orderId: registrationResult.orderId,
      transactionId: registrationResult.transactionId,
      chargedAmount: registrationResult.chargedAmount
    });

    // Check if orderId and transactionId are null (common in sandbox mode)
    if (!registrationResult.orderId || !registrationResult.transactionId) {
      console.warn(`⚠️  Namecheap returned null orderId/transactionId. This is normal in sandbox mode.`);
      console.warn(`   OrderID: ${registrationResult.orderId}, TransactionID: ${registrationResult.transactionId}`);
    }

    // Calculate expiration date
    const registrationDate = new Date();
    const expirationDate = new Date(registrationDate);
    expirationDate.setFullYear(expirationDate.getFullYear() + (years || 1));

    // Update domain record with registration details
    // Note: In sandbox mode, orderId and transactionId may be null
    await domainRecord.update({
      status: 'active',
      registration_date: registrationDate,
      expiration_date: expirationDate,
      namecheap_order_id: registrationResult.orderId || null,
      namecheap_transaction_id: registrationResult.transactionId || null,
      is_verified: true
    }, { transaction });

    // Log warning if IDs are null (sandbox mode)
    if (!registrationResult.orderId || !registrationResult.transactionId) {
      console.warn(`⚠️  Domain ${domain_name} registered but Namecheap orderId/transactionId are null (sandbox mode)`);
    }

    // Get online_store_id from domain record if not provided in domainData
    // This handles cases where online_store_id was set during checkout but not in metadata
    const finalOnlineStoreId = online_store_id || domainRecord.online_store_id;
    
    console.log(`🔍 Online store ID check:`, {
      fromDomainData: online_store_id,
      fromDomainRecord: domainRecord.online_store_id,
      finalOnlineStoreId: finalOnlineStoreId
    });

    // AUTO-CONFIGURE DNS (always configure DNS for all domains)
    console.log(`⚙️  Starting automatic DNS setup for ${domain_name}...`);
    
    const mycroshopServerIp = process.env.MYCROSHOP_SERVER_IP || process.env.SERVER_IP;
    const mycroshopServerHost = process.env.MYCROSHOP_SERVER_HOST || process.env.SERVER_HOST;
    
    if (mycroshopServerIp || mycroshopServerHost) {
      try {
        const dnsRecords = [];
        
        // A record for root domain (@)
        if (mycroshopServerIp) {
          dnsRecords.push({
            type: 'A',
            name: '@',
            address: mycroshopServerIp,
            ttl: '1800'
          });
          console.log(`📡 DNS: Added A record @ → ${mycroshopServerIp}`);
        }
        
        // A record for www subdomain (should point to same IP as root domain)
        // For purchased domains, www should point to the server IP, not to mycroshop.com
        if (mycroshopServerIp) {
          dnsRecords.push({
            type: 'A',
            name: 'www',
            address: mycroshopServerIp,
            ttl: '1800'
          });
          console.log(`📡 DNS: Added A record www → ${mycroshopServerIp}`);
        } else if (mycroshopServerHost) {
          // Fallback: If only hostname is available, use CNAME pointing to root domain
          // Note: This is less ideal - prefer using IP address
          dnsRecords.push({
            type: 'CNAME',
            name: 'www',
            address: domain_name, // Point www to the root domain itself
            ttl: '1800'
          });
          console.log(`📡 DNS: Added CNAME www → ${domain_name} (root domain)`);
        }

        if (dnsRecords.length > 0) {
          console.log(`🌐 Configuring DNS records for ${domain_name}...`);
          console.log(`📋 DNS Records to configure:`, JSON.stringify(dnsRecords, null, 2));
          
          const dnsResult = await namecheapService.setDNSHostRecords(domain_name, dnsRecords);
          
          console.log(`📦 Namecheap DNS API response:`, JSON.stringify(dnsResult, null, 2));
          
          if (dnsResult && dnsResult.success) {
            // ONLY save DNS records to database if Namecheap API succeeded
            await domainRecord.update({
              dns_records: dnsRecords
            }, { transaction });
            console.log(`✅ DNS configured successfully for ${domain_name} and saved to database`);
          } else {
            const errorMsg = dnsResult?.message || dnsResult?.error || 'Unknown error';
            console.error(`❌ DNS configuration failed for ${domain_name}:`, errorMsg);
            console.error(`   Full DNS result:`, JSON.stringify(dnsResult, null, 2));
            // DO NOT save DNS records if API failed - database should reflect actual state
            throw new Error(`DNS configuration failed: ${errorMsg}`);
          }
        } else {
          console.warn(`⚠️  No DNS records to configure. Set MYCROSHOP_SERVER_IP or MYCROSHOP_SERVER_HOST in .env`);
          console.warn(`   Current values: MYCROSHOP_SERVER_IP=${mycroshopServerIp}, MYCROSHOP_SERVER_HOST=${mycroshopServerHost}`);
          throw new Error('DNS configuration skipped: MYCROSHOP_SERVER_IP and MYCROSHOP_SERVER_HOST not set in environment variables');
        }
      } catch (dnsError) {
        console.error(`❌ DNS configuration error for ${domain_name}:`, dnsError.message);
        console.error(`   Error stack:`, dnsError.stack);
        // Re-throw error so it's returned immediately
        throw dnsError;
      }
    } else {
      const errorMsg = 'DNS auto-configuration skipped: MYCROSHOP_SERVER_IP and MYCROSHOP_SERVER_HOST not set in environment variables';
      console.error(`❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Update domain lookup table and configure SSL (only if online_store_id is provided)
    if (finalOnlineStoreId) {
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
          timestamps: true,
          createdAt: 'created_at',  // Map to snake_case column name
          updatedAt: 'updated_at'   // Map to snake_case column name
        });

        const onlineStore = await models.OnlineStore.findByPk(finalOnlineStoreId, { transaction });
        if (onlineStore) {
          // Get tenant_id from domain record (should always be set)
          const tenantId = domainRecord.tenant_id;
          
          if (!tenantId) {
            console.error(`⚠️  Domain ${domain_name} has no tenant_id! Cannot update domain_lookup.`);
          } else {
            // Get tenant to determine subscription plan
            const { getTenantById } = require('../config/tenant');
            const tenant = await getTenantById(tenantId);
            const subscriptionPlan = tenant?.subscription_plan || 'free';
            
            console.log(`📝 Upserting domain_lookup record:`, {
              domain_name: domain_name,
              tenant_id: tenantId,
              online_store_id: finalOnlineStoreId,
              online_store_username: onlineStore.username,
              subscription_plan: subscriptionPlan
            });
            
            try {
              const lookupResult = await DomainLookup.upsert({
                domain_name: domain_name,
                tenant_id: tenantId,
                online_store_id: finalOnlineStoreId,
                online_store_username: onlineStore.username,
                subscription_plan: subscriptionPlan,
                is_active: true
              }, {
                returning: true
              });
              
              console.log(`✅ Updated domain_lookup table: ${domain_name} → Store: ${onlineStore.username} (Tenant: ${tenantId})`);
              console.log(`   Upsert result:`, JSON.stringify(lookupResult, null, 2));
            } catch (lookupUpsertError) {
              console.error(`❌ Failed to upsert domain_lookup:`, lookupUpsertError);
              console.error(`   Error:`, lookupUpsertError.message);
              console.error(`   Stack:`, lookupUpsertError.stack);
              // Don't fail domain purchase if lookup update fails, but log it
              // The domain will still work, just won't be in the lookup table
            }
          }

          // Update online store custom_domain
          await onlineStore.update({
            custom_domain: domain_name
          }, { transaction });
          
          console.log(`🔗 Linked domain ${domain_name} to online store: ${onlineStore.username}`);

          // Provision SSL certificate (automatic when online_store_id is provided)
          console.log(`🔒 Provisioning SSL certificate for ${domain_name}...`);
          console.log(`   SSL Provider: ${process.env.SSL_PROVIDER || 'letsencrypt'}`);
          console.log(`   Certbot Email: ${process.env.CERTBOT_EMAIL || process.env.ADMIN_EMAIL || 'not set'}`);
          console.log(`   Shared Webroot Path: ${process.env.SSL_WEBROOT_PATH || '/var/www/letsencrypt'}`);
          console.log(`   Online Store Username: ${onlineStore.username}`);
          console.log(`   Mode: Shared webroot (recommended - all domains use same directory)`);
          
          try {
            const sslService = require('../services/sslService');
            const sslResult = await sslService.provisionSSL(domain_name, onlineStore.username);
            
            console.log(`📦 SSL Service Response:`, JSON.stringify(sslResult, null, 2));
            
            if (sslResult && sslResult.success) {
              await domainRecord.update({
                ssl_enabled: true
              }, { transaction });
              console.log(`✅ SSL certificate provisioned successfully for ${domain_name}`);
              console.log(`   Certificate Path: ${sslResult.certificatePath || 'N/A'}`);
              console.log(`   Key Path: ${sslResult.keyPath || 'N/A'}`);
            } else {
              // SSL provisioning failed - return error with full details
              const errorMsg = sslResult?.message || sslResult?.error || 'Unknown error';
              console.error(`❌ SSL provisioning failed for ${domain_name}:`, errorMsg);
              console.error(`   Full SSL result:`, JSON.stringify(sslResult, null, 2));
              
              // Create detailed error with SSL result for debugging
              const sslError = new Error(`SSL provisioning failed: ${errorMsg}`);
              sslError.sslResult = sslResult; // Attach full SSL result to error
              sslError.sslDetails = {
                provider: sslResult?.provider || process.env.SSL_PROVIDER || 'letsencrypt',
                domain: domain_name,
                onlineStoreUsername: onlineStore.username,
                certbotEmail: process.env.CERTBOT_EMAIL || process.env.ADMIN_EMAIL,
                webrootPath: sslResult?.webrootPath || process.env.SSL_WEBROOT_PATH || '/var/www/letsencrypt',
                webroot: sslResult?.webroot || 'N/A',
                instructions: sslResult?.instructions || [],
                apacheConfig: sslResult?.apacheConfig || null
              };
              
              // DO NOT mark SSL as enabled if provisioning failed
              throw sslError;
            }
          } catch (sslError) {
            console.error(`❌ SSL provisioning exception for ${domain_name}:`, sslError.message);
            console.error(`   Error stack:`, sslError.stack);
            console.error(`   SSL Error details:`, sslError.sslResult || sslError.sslDetails || 'No details');
            // Re-throw to ensure error is returned with full details
            throw sslError;
          }
        } else {
          console.error(`⚠️  Online store not found for online_store_id: ${finalOnlineStoreId}`);
          throw new Error(`Online store not found for online_store_id: ${finalOnlineStoreId}`);
        }
      } catch (lookupError) {
        console.error('Error updating domain lookup or SSL:', lookupError);
        console.error('   Error stack:', lookupError.stack);
        console.error('   Error details:', lookupError.sslResult || lookupError.sslDetails || 'No additional details');
        // Re-throw error so it's returned immediately with full details
        throw lookupError;
      }
    } else {
      console.log(`ℹ️  No online_store_id provided. Domain ${domain_name} DNS configured but not linked to store. SSL skipped.`);
    }

    // Reload domain record to get updated values
    await domainRecord.reload({ transaction });
    
    console.log(`✅ Domain purchase completed successfully:`, {
      domain_id: domainRecord.id,
      domain_name: domainRecord.domain_name,
      status: domainRecord.status,
      orderId: domainRecord.namecheap_order_id,
      transactionId: domainRecord.namecheap_transaction_id,
      registration_date: domainRecord.registration_date,
      dns_records: domainRecord.dns_records ? 'configured' : 'not configured',
      ssl_enabled: domainRecord.ssl_enabled
    });
    
    // Build detailed logs for response
    const logs = [
      `✅ Domain ${domain_name} registered successfully with Namecheap`,
      `Order ID: ${registrationResult.orderId || 'null (sandbox mode)'}`,
      `Transaction ID: ${registrationResult.transactionId || 'null (sandbox mode)'}`,
      `DNS records: ${domainRecord.dns_records ? 'configured' : 'not configured'}`,
      `SSL enabled: ${domainRecord.ssl_enabled ? 'yes' : 'no'}`,
      `Online store linked: ${domainRecord.online_store_id ? 'yes' : 'no'}`
    ];
    
    return { 
      success: true, 
      domain: domainRecord,
      orderId: registrationResult.orderId,
      transactionId: registrationResult.transactionId,
      sandboxMode: !registrationResult.orderId || !registrationResult.transactionId,
      message: 'Domain registered successfully with Namecheap',
      registrationResult: registrationResult,
      logs: logs
    };
  } catch (error) {
    console.error('Error completing domain purchase:', error);
    console.error('   Error stack:', error.stack);
    // Re-throw error so it propagates to payment verification
    // This ensures DNS/SSL errors are returned immediately and not silently ignored
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
