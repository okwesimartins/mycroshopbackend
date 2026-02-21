const { getTenantConnection } = require('../config/database');
const { getTenantById, getAllTenants } = require('../config/tenant');
const initializeModels = require('../models');

/**
 * Middleware to identify online store by custom domain
 * 
 * HOW IT WORKS (The Technology):
 * ===============================
 * 1. All custom domains point to the SAME server IP (e.g., 192.0.2.1)
 * 2. When a user visits "customerstore.com", their browser sends HTTP request with:
 *    Host: customerstore.com
 * 3. Nginx receives request and forwards to Node.js with Host header
 * 4. This middleware reads the Host header and looks up in database:
 *    - Which tenant owns this domain?
 *    - Which online store is it linked to?
 * 5. Node.js then serves the correct online store's content
 * 
 * This is called "Virtual Hosting" or "Name-based Virtual Hosting"
 * - Same IP, different domains
 * - Server uses Host header to determine which site to serve
 */
async function identifyStoreByCustomDomain(req, res, next) {
  try {
    // Get the domain from HTTP Host header
    const host = req.headers.host || req.headers['x-forwarded-host'];
    
    if (!host) {
      return next(); // No host header, continue
    }

    // Remove port if present (e.g., "example.com:3000" -> "example.com")
    const domain = host.split(':')[0].toLowerCase();
    
    // Skip if it's the main MycroShop domain or API domain
    const mainDomain = process.env.MAIN_DOMAIN || 'mycroshop.com';
    const apiDomain = process.env.API_DOMAIN || 'api.mycroshop.com';
    const backendDomain = process.env.BACKEND_DOMAIN || 'backend.mycroshop.com';
    
    if (domain === mainDomain || 
        domain === apiDomain || 
        domain === backendDomain ||
        domain.endsWith(`.${mainDomain}`) ||
        domain.endsWith(`.${apiDomain}`)) {
      return next(); // This is MycroShop's own domain, not a custom domain
    }

    // Skip www subdomain (www.example.com -> example.com)
    const cleanDomain = domain.startsWith('www.') ? domain.substring(4) : domain;

    // Look up domain in main database's domain_lookup table (FAST)
    // This table is updated whenever a domain is linked to an online store
    // It provides O(1) lookup instead of searching all tenant databases
    
    let tenantId = null;
    let onlineStoreId = null;
    let onlineStoreUsername = null;
    let subscriptionPlan = null;
    
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

      const domainLookup = await DomainLookup.findOne({
        where: { 
          domain_name: cleanDomain,
          is_active: true
        }
      });

      if (domainLookup) {
        tenantId = domainLookup.tenant_id;
        onlineStoreId = domainLookup.online_store_id;
        onlineStoreUsername = domainLookup.online_store_username;
        subscriptionPlan = domainLookup.subscription_plan;
      }
    } catch (lookupError) {
      console.error('Error looking up domain in domain_lookup table:', lookupError);
      // Fallback to searching tenant databases if lookup table fails
    }

    // Fallback: If not found in lookup table, search tenant databases
    // This handles cases where lookup table wasn't updated
    if (!tenantId) {
      // Step 1: Search in shared free database
      try {
        const sharedFreeDb = await getTenantConnection(null, 'free');
        const sharedModels = initializeModels(sharedFreeDb);
        
        const domainRecord = await sharedModels.Domain.findOne({
          where: { domain_name: cleanDomain },
          include: [
            {
              model: sharedModels.OnlineStore,
              attributes: ['id', 'username', 'store_name', 'tenant_id'],
              required: false
            }
          ]
        });

        if (domainRecord && domainRecord.OnlineStore) {
          tenantId = domainRecord.OnlineStore.tenant_id;
          onlineStoreId = domainRecord.OnlineStore.id;
          onlineStoreUsername = domainRecord.OnlineStore.username;
          subscriptionPlan = 'free';
        }
      } catch (error) {
        console.error('Error searching shared free database for domain:', error);
      }

      // Step 2: If still not found, search enterprise databases
      if (!tenantId) {
        try {
          const tenants = await getAllTenants();
          
          for (const tenant of tenants) {
            if (tenant.subscription_plan === 'enterprise') {
              try {
                const tenantDb = await getTenantConnection(tenant.id, 'enterprise');
                const tenantModels = initializeModels(tenantDb);
                
                const enterpriseDomain = await tenantModels.Domain.findOne({
                  where: { domain_name: cleanDomain },
                  include: [
                    {
                      model: tenantModels.OnlineStore,
                      attributes: ['id', 'username', 'store_name'],
                      required: false
                    }
                  ]
                });

                if (enterpriseDomain && enterpriseDomain.OnlineStore) {
                  tenantId = tenant.id;
                  onlineStoreId = enterpriseDomain.OnlineStore.id;
                  onlineStoreUsername = enterpriseDomain.OnlineStore.username;
                  subscriptionPlan = 'enterprise';
                  break; // Found it, stop searching
                }
              } catch (tenantError) {
                // Skip this tenant if there's an error
                continue;
              }
            }
          }
        } catch (error) {
          console.error('Error searching enterprise databases for domain:', error);
        }
      }
    }

    // Step 3: If domain found, attach tenant and store info to request
    if (tenantId && onlineStoreId) {
      const tenant = await getTenantById(tenantId);
      if (tenant) {
        // Get tenant database connection
        const tenantDb = await getTenantConnection(tenantId, subscriptionPlan || tenant.subscription_plan);
        const tenantModels = initializeModels(tenantDb);
        
        // Get online store details
        const onlineStore = await tenantModels.OnlineStore.findByPk(onlineStoreId);
        
        if (onlineStore) {
          // Attach to request
          req.customDomain = cleanDomain;
          req.onlineStoreId = onlineStoreId;
          req.onlineStoreUsername = onlineStoreUsername || onlineStore.username;
          req.tenant = tenant;
          req.tenantId = tenantId;
          req.db = tenantDb;
          req.db.models = tenantModels;
          
          if (process.env.NODE_ENV === 'development') {
            console.log(`🌐 Custom domain identified: ${cleanDomain} → Online Store: ${req.onlineStoreUsername} (Tenant: ${tenantId})`);
          }
        }
      }
    } else {
      // Domain not found - might be a new domain or not yet linked
      if (process.env.NODE_ENV === 'development') {
        console.log(`⚠️  Custom domain "${cleanDomain}" not found in database`);
      }
    }
    
    next();
  } catch (error) {
    console.error('Error identifying store by custom domain:', error);
    // Don't block request - continue without custom domain identification
    next();
  }
}

module.exports = {
  identifyStoreByCustomDomain
};

