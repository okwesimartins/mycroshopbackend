const { getTenantBySubdomain } = require('../config/tenant');

/**
 * Middleware to identify tenant by subdomain
 * Extracts subdomain from request headers (set by Nginx) or host
 * Attaches tenant info to request if found
 */
async function identifyTenantBySubdomain(req, res, next) {
  try {
    // Get subdomain from Nginx header (preferred) or host
    let subdomain = req.headers['x-subdomain'];
    
    // If not in header, extract from host
    if (!subdomain && req.headers.host) {
      const hostParts = req.headers.host.split('.');
      // If host is like "subdomain.mycroshop.com", first part is subdomain
      // If host is like "mycroshop.com", no subdomain
      if (hostParts.length > 2) {
        subdomain = hostParts[0];
      }
    }
    
    // Skip if no subdomain or reserved words
    const reservedWords = ['www', 'api', 'admin', 'app', 'mail', 'ftp', 'cpanel'];
    if (!subdomain || reservedWords.includes(subdomain.toLowerCase())) {
      return next();
    }
    
    // Get tenant by subdomain
    if (subdomain) {
      try {
        const tenant = await getTenantBySubdomain(subdomain);
        if (tenant) {
          req.tenant = tenant;
          req.tenantId = tenant.id;
          req.subdomain = subdomain;
          
          // Log for debugging (remove in production)
          if (process.env.NODE_ENV === 'development') {
            console.log(`Tenant identified by subdomain: ${subdomain} (ID: ${tenant.id})`);
          }
        } else {
          // Subdomain exists but tenant not found
          if (process.env.NODE_ENV === 'development') {
            console.log(`Subdomain "${subdomain}" not found in database`);
          }
        }
      } catch (error) {
        console.error('Error identifying tenant by subdomain:', error);
        // Continue without tenant - let other middleware handle authentication
      }
    }
    
    next();
  } catch (error) {
    console.error('Error in subdomain middleware:', error);
    // Continue - don't block request
    next();
  }
}

module.exports = {
  identifyTenantBySubdomain
};

