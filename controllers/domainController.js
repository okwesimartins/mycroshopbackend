const namecheapService = require('../services/namecheapService');
const sslService = require('../services/sslService');

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
 * Purchase/Register a domain
 * POST /api/v1/domains/purchase
 */
async function purchaseDomain(req, res) {
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

module.exports = {
  checkDomainAvailability,
  getDomainPricing,
  purchaseDomain,
  getAllDomains,
  getDomainById,
  linkDomainToStore,
  unlinkDomainFromStore,
  getDNSRecords,
  updateDNSRecords,
  provisionSSL,
  checkSSLStatus
};
