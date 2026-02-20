const { getTenantConnection } = require('../config/database');
const { getAllTenants } = require('../config/tenant');
const initializeModels = require('../models');

/**
 * Middleware to identify online store by subdomain (username.mycroshop.com)
 * 
 * HOW IT WORKS:
 * =============
 * 1. User creates online store with username (e.g., "mystore")
 * 2. Store is accessible via: mystore.mycroshop.com
 * 3. This middleware extracts the subdomain and looks up the online store
 * 4. If found, attaches store and tenant info to request
 * 
 * This allows users to access their online store BEFORE linking a custom domain
 */
async function identifyStoreBySubdomain(req, res, next) {
  try {
    // Skip if already identified by custom domain
    if (req.onlineStoreId || req.customDomain) {
      return next();
    }

    // Get the domain from HTTP Host header
    const host = req.headers.host || req.headers['x-forwarded-host'];
    
    if (!host) {
      return next(); // No host header, continue
    }

    // Remove port if present
    const domain = host.split(':')[0].toLowerCase();
    
    // Get main domain (e.g., "mycroshop.com")
    const mainDomain = process.env.MAIN_DOMAIN || 'mycroshop.com';
    const apiDomain = process.env.API_DOMAIN || 'api.mycroshop.com';
    const backendDomain = process.env.BACKEND_DOMAIN || 'backend.mycroshop.com';
    
    // Skip if it's the main MycroShop domain or API domain
    if (domain === mainDomain || 
        domain === apiDomain || 
        domain === backendDomain) {
      return next();
    }

    // Check if it's a subdomain of main domain (e.g., "mystore.mycroshop.com")
    let subdomain = null;
    if (domain.endsWith(`.${mainDomain}`)) {
      // Extract subdomain (e.g., "mystore" from "mystore.mycroshop.com")
      const parts = domain.split('.');
      if (parts.length >= 3) {
        subdomain = parts[0]; // First part is the subdomain
      }
    }

    // Skip reserved subdomains
    const reservedWords = ['www', 'api', 'admin', 'app', 'mail', 'ftp', 'cpanel', 'backend'];
    if (!subdomain || reservedWords.includes(subdomain.toLowerCase())) {
      return next();
    }

    // Look up online store by username (subdomain = username)
    let tenantId = null;
    let onlineStoreId = null;
    let onlineStore = null;
    let subscriptionPlan = null;

    // Step 1: Search in shared free database
    try {
      const sharedFreeDb = await getTenantConnection(null, 'free');
      const sharedModels = initializeModels(sharedFreeDb);
      
      const freeStore = await sharedModels.OnlineStore.findOne({
        where: { 
          username: subdomain,
          is_published: true // Only published stores are accessible
        },
        attributes: ['id', 'username', 'store_name', 'tenant_id', 'custom_domain']
      });

      if (freeStore) {
        // Skip if store has a custom domain (should use custom domain instead)
        if (!freeStore.custom_domain) {
          tenantId = freeStore.tenant_id;
          onlineStoreId = freeStore.id;
          onlineStore = freeStore;
          subscriptionPlan = 'free';
        }
      }
    } catch (error) {
      console.error('Error searching shared free database for online store:', error);
    }

    // Step 2: If not found, search enterprise databases
    if (!onlineStoreId) {
      try {
        const tenants = await getAllTenants();
        
        for (const tenant of tenants) {
          if (tenant.subscription_plan === 'enterprise') {
            try {
              const tenantDb = await getTenantConnection(tenant.id, 'enterprise');
              const tenantModels = initializeModels(tenantDb);
              
              const enterpriseStore = await tenantModels.OnlineStore.findOne({
                where: { 
                  username: subdomain,
                  is_published: true // Only published stores are accessible
                },
                attributes: ['id', 'username', 'store_name', 'custom_domain']
              });

              if (enterpriseStore) {
                // Skip if store has a custom domain (should use custom domain instead)
                if (!enterpriseStore.custom_domain) {
                  tenantId = tenant.id;
                  onlineStoreId = enterpriseStore.id;
                  onlineStore = enterpriseStore;
                  subscriptionPlan = 'enterprise';
                  break; // Found it, stop searching
                }
              }
            } catch (tenantError) {
              // Skip this tenant if there's an error
              continue;
            }
          }
        }
      } catch (error) {
        console.error('Error searching enterprise databases for online store:', error);
      }
    }

    // Step 3: If online store found, attach to request
    if (tenantId && onlineStoreId && onlineStore) {
      const { getTenantById } = require('../config/tenant');
      const tenant = await getTenantById(tenantId);
      
      if (tenant) {
        // Get tenant database connection
        const tenantDb = await getTenantConnection(tenantId, subscriptionPlan || tenant.subscription_plan);
        const tenantModels = initializeModels(tenantDb);
        
        // Get full online store details
        const fullStore = await tenantModels.OnlineStore.findByPk(onlineStoreId);
        
        if (fullStore) {
          // Attach to request
          req.onlineStoreSubdomain = subdomain;
          req.onlineStoreId = onlineStoreId;
          req.onlineStoreUsername = onlineStore.username;
          req.tenant = tenant;
          req.tenantId = tenantId;
          req.db = tenantDb;
          req.db.models = tenantModels;
          
          if (process.env.NODE_ENV === 'development') {
            console.log(`🏪 Online store identified by subdomain: ${subdomain}.${mainDomain} → Store: ${req.onlineStoreUsername} (Tenant: ${tenantId})`);
          }
        }
      }
    } else {
      // Subdomain not found - might be a tenant subdomain or invalid
      if (process.env.NODE_ENV === 'development') {
        console.log(`⚠️  Online store subdomain "${subdomain}" not found or not published`);
      }
    }
    
    next();
  } catch (error) {
    console.error('Error identifying store by subdomain:', error);
    // Don't block request - continue without store identification
    next();
  }
}

module.exports = {
  identifyStoreBySubdomain
};

