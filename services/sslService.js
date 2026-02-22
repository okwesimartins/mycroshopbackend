const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const execPromise = util.promisify(exec);

/**
 * SSL Certificate Service
 * Handles SSL certificate provisioning for custom domains
 * Supports Let's Encrypt (via certbot) and other providers
 */
class SSLService {
  constructor() {
    this.sslProvider = process.env.SSL_PROVIDER || 'letsencrypt'; // 'letsencrypt', 'cloudflare', 'namecheap'
    this.certbotEmail = process.env.CERTBOT_EMAIL || process.env.ADMIN_EMAIL;
    this.serverIp = process.env.MYCROSHOP_SERVER_IP || process.env.SERVER_IP;
    
    // Use shared webroot for all Let's Encrypt challenges (BEST PRACTICE)
    // Default to /var/www/letsencrypt (recommended) or use SSL_WEBROOT_PATH if set
    // This avoids permission issues and is the recommended approach
    this.sharedWebrootPath = process.env.SSL_WEBROOT_PATH || process.env.WEBROOT_PATH || '/var/www/letsencrypt';
    
    // Legacy: per-store webroot (not recommended due to permission issues)
    this.webrootPath = process.env.WEBROOT_PATH || '/var/www/html';
    this.usePerStoreWebroot = process.env.SSL_USE_PER_STORE_WEBROOT === 'true'; // Default: false (use shared)
    
    // Use standalone mode if SSL_USE_STANDALONE is true (doesn't require webroot)
    this.useStandalone = process.env.SSL_USE_STANDALONE === 'true';
  }

  /**
   * Provision SSL certificate for a domain
   * @param {string} domain - Domain name
   * @param {string} onlineStoreUsername - Online store username for webroot path
   * @returns {Promise<object>} SSL provisioning result
   */
  async provisionSSL(domain, onlineStoreUsername = null) {
    try {
      switch (this.sslProvider) {
        case 'letsencrypt':
          return await this.provisionLetsEncrypt(domain, onlineStoreUsername);
        case 'cloudflare':
          return await this.provisionCloudflare(domain);
        case 'namecheap':
          return await this.provisionNamecheap(domain);
        default:
          throw new Error(`Unsupported SSL provider: ${this.sslProvider}`);
      }
    } catch (error) {
      console.error('Error provisioning SSL:', error);
      throw error;
    }
  }

  /**
   * Provision SSL using Let's Encrypt (certbot)
   * This requires certbot to be installed on the server
   */
  async provisionLetsEncrypt(domain, onlineStoreUsername = null) {
    if (!this.certbotEmail) {
      throw new Error('CERTBOT_EMAIL or ADMIN_EMAIL must be set for Let\'s Encrypt SSL');
    }

    try {
      // Use standalone mode if configured (doesn't require webroot)
      if (this.useStandalone) {
        console.log(`🔒 Using standalone mode for SSL provisioning (no webroot required)`);
        const command = `certbot certonly --standalone -d ${domain} -d www.${domain} --email ${this.certbotEmail} --agree-tos --non-interactive --quiet`;
        
        console.log(`🔒 Provisioning SSL certificate for ${domain} using Let's Encrypt (standalone mode)...`);
        console.log(`   Command: ${command}`);
        
        const { stdout, stderr } = await execPromise(command);
        
        if (stderr && !stderr.includes('Congratulations') && !stderr.includes('Successfully received certificate')) {
          // Check if certificate already exists
          if (stderr.includes('already exists') || stderr.includes('Certificate not yet due for renewal')) {
            return {
              success: true,
              domain,
              provider: 'letsencrypt',
              message: 'SSL certificate already exists or is valid',
              certificatePath: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
              keyPath: `/etc/letsencrypt/live/${domain}/privkey.pem`
            };
          }
          throw new Error(`Certbot error: ${stderr}`);
        }

        return {
          success: true,
          domain,
          provider: 'letsencrypt',
          message: 'SSL certificate provisioned successfully (standalone mode)',
          certificatePath: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
          keyPath: `/etc/letsencrypt/live/${domain}/privkey.pem`,
          expiresAt: await this.getCertificateExpiry(domain)
        };
      }

      // Build certbot command using webroot method
      // BEST PRACTICE: Use shared webroot for all domains (avoids permission issues)
      // All Let's Encrypt challenges go to the same directory
      let webroot = this.usePerStoreWebroot
        ? (onlineStoreUsername 
          ? `${this.webrootPath}/${onlineStoreUsername}`  // Per-store webroot (not recommended)
          : this.webrootPath)
        : this.sharedWebrootPath;  // Shared webroot for all domains (RECOMMENDED)

      console.log(`📁 Using webroot: ${webroot}`);
      console.log(`   Mode: ${this.usePerStoreWebroot ? 'per-store (not recommended)' : 'shared (recommended)'}`);
      console.log(`   Store: ${onlineStoreUsername || 'none'}`);

      // Ensure webroot directory exists
      try {
        await fs.access(webroot);
        console.log(`✅ Webroot directory exists: ${webroot}`);
      } catch (accessError) {
        // Directory doesn't exist, try to create it
        console.log(`⚠️  Webroot directory does not exist: ${webroot}. Attempting to create...`);
        try {
          await fs.mkdir(webroot, { recursive: true });
          console.log(`✅ Created webroot directory: ${webroot}`);
          
          // Create .well-known/acme-challenge directory for Let's Encrypt verification
          const acmeChallengePath = path.join(webroot, '.well-known', 'acme-challenge');
          await fs.mkdir(acmeChallengePath, { recursive: true });
          console.log(`✅ Created acme-challenge directory: ${acmeChallengePath}`);
          
          // Create a simple index.html to ensure directory is web-accessible
          const indexPath = path.join(webroot, 'index.html');
          try {
            await fs.access(indexPath);
          } catch {
            await fs.writeFile(indexPath, '<!DOCTYPE html><html><head><title>Domain Verification</title></head><body><h1>Domain Verification</h1></body></html>');
            console.log(`✅ Created index.html in webroot`);
          }
        } catch (mkdirError) {
          console.error(`❌ Failed to create webroot directory: ${webroot}`, mkdirError);
          
          // Return detailed error with instructions instead of throwing
          // This allows the error to be properly returned in the response
          return {
            success: false,
            domain,
            provider: 'letsencrypt',
            message: `Webroot directory does not exist and could not be created: ${webroot}`,
            error: mkdirError.message,
            instructions: [
              `Create the webroot directory manually: sudo mkdir -p ${webroot}`,
              `Create acme-challenge directory: sudo mkdir -p ${webroot}/.well-known/acme-challenge`,
              `Set permissions for Apache: sudo chown -R www-data:www-data ${webroot}`,
              `Set permissions: sudo chmod -R 755 ${webroot}`,
              `Configure Apache to serve this directory (see Apache configuration below)`,
              `OR use standalone mode: Set SSL_USE_STANDALONE=true in .env (requires port 80 free)`,
              `OR use a different webroot: Set SSL_WEBROOT_PATH=/path/to/webroot in .env`
            ],
            apacheConfig: `# Add this to your Apache virtual host configuration:
Alias /.well-known/acme-challenge ${webroot}/.well-known/acme-challenge
<Directory "${webroot}/.well-known/acme-challenge">
    Options None
    AllowOverride None
    Require all granted
</Directory>`,
            webroot: webroot,
            webrootPath: this.sharedWebrootPath,
            onlineStoreUsername: onlineStoreUsername
          };
        }
      }

      const command = `certbot certonly --webroot -w ${webroot} -d ${domain} -d www.${domain} --email ${this.certbotEmail} --agree-tos --non-interactive --quiet`;

      console.log(`🔒 Provisioning SSL certificate for ${domain} using Let's Encrypt...`);
      
      const { stdout, stderr } = await execPromise(command);

      if (stderr && !stderr.includes('Congratulations')) {
        // Check if certificate already exists
        if (stderr.includes('already exists') || stderr.includes('Certificate not yet due for renewal')) {
          return {
            success: true,
            domain,
            provider: 'letsencrypt',
            message: 'SSL certificate already exists or is valid',
            certificatePath: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
            keyPath: `/etc/letsencrypt/live/${domain}/privkey.pem`
          };
        }
        throw new Error(`Certbot error: ${stderr}`);
      }

      return {
        success: true,
        domain,
        provider: 'letsencrypt',
        message: 'SSL certificate provisioned successfully',
        certificatePath: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
        keyPath: `/etc/letsencrypt/live/${domain}/privkey.pem`,
        expiresAt: await this.getCertificateExpiry(domain)
      };
    } catch (error) {
      // If certbot is not installed, return instructions
      if (error.message.includes('certbot: command not found')) {
        return {
          success: false,
          domain,
          provider: 'letsencrypt',
          message: 'Certbot is not installed. Please install certbot to provision SSL certificates.',
          instructions: [
            'Install certbot: sudo apt-get install certbot python3-certbot-nginx (or python3-certbot-apache)',
            'Or use standalone mode: certbot certonly --standalone -d ' + domain
          ]
        };
      }
      throw error;
    }
  }

  /**
   * Provision SSL using Cloudflare (if domain uses Cloudflare DNS)
   */
  async provisionCloudflare(domain) {
    // Cloudflare provides free SSL automatically for domains using their DNS
    // This would require Cloudflare API integration
    return {
      success: true,
      domain,
      provider: 'cloudflare',
      message: 'Cloudflare SSL is automatically enabled for domains using Cloudflare DNS',
      note: 'Ensure domain nameservers are set to Cloudflare'
    };
  }

  /**
   * Provision SSL using Namecheap (if available)
   */
  async provisionNamecheap(domain) {
    // Namecheap offers SSL certificates but typically requires manual purchase
    // This would require Namecheap SSL API integration
    return {
      success: false,
      domain,
      provider: 'namecheap',
      message: 'Namecheap SSL requires manual purchase through their website',
      note: 'Namecheap SSL API is not available. Please purchase SSL certificate manually.'
    };
  }

  /**
   * Get certificate expiry date
   */
  async getCertificateExpiry(domain) {
    try {
      const { stdout } = await execPromise(`openssl x509 -enddate -noout -in /etc/letsencrypt/live/${domain}/cert.pem`);
      const expiryMatch = stdout.match(/notAfter=(.+)/);
      return expiryMatch ? expiryMatch[1] : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Renew SSL certificate (for Let's Encrypt)
   */
  async renewSSL(domain) {
    try {
      const command = `certbot renew --cert-name ${domain} --quiet`;
      const { stdout, stderr } = await execPromise(command);
      
      return {
        success: true,
        domain,
        message: 'SSL certificate renewed successfully'
      };
    } catch (error) {
      throw new Error(`Failed to renew SSL certificate: ${error.message}`);
    }
  }

  /**
   * Check if SSL certificate exists and is valid
   */
  async checkSSLStatus(domain) {
    try {
      const certPath = `/etc/letsencrypt/live/${domain}/cert.pem`;
      const { stdout } = await execPromise(`openssl x509 -in ${certPath} -noout -subject -dates 2>/dev/null || echo "NOT_FOUND"`);
      
      if (stdout.includes('NOT_FOUND')) {
        return {
          exists: false,
          valid: false,
          domain
        };
      }

      const expiryMatch = stdout.match(/notAfter=(.+)/);
      const expiryDate = expiryMatch ? new Date(expiryMatch[1]) : null;
      const isValid = expiryDate && expiryDate > new Date();

      return {
        exists: true,
        valid: isValid,
        domain,
        expiresAt: expiryDate,
        daysUntilExpiry: expiryDate ? Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24)) : null
      };
    } catch (error) {
      return {
        exists: false,
        valid: false,
        domain,
        error: error.message
      };
    }
  }
}

// Export singleton instance
module.exports = new SSLService();



