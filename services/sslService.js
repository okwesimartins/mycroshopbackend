const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
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
    this.webrootPath = process.env.WEBROOT_PATH || '/var/www/html';
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
      // Build certbot command
      // Using webroot method (recommended for production)
      const webroot = onlineStoreUsername 
        ? `${this.webrootPath}/${onlineStoreUsername}`
        : this.webrootPath;

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



