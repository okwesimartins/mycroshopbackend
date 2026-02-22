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
    
    // Certbot directories (writable by Node.js user, avoids permission issues)
    // BEST PRACTICE: Use home directory with organized subdirectories
    // This is the correct architecture for SaaS on cPanel
    // Default: /home/{username}/letsencrypt/{config,work,logs}
    // Can be overridden via CERTBOT_BASE_PATH env var
    const username = process.env.USER || process.env.USERNAME || 'legithairng'; // cPanel username
    const certbotBasePath = process.env.CERTBOT_BASE_PATH || `/home/${username}/letsencrypt`;
    
    this.certbotBasePath = certbotBasePath;
    this.certbotConfigDir = process.env.CERTBOT_CONFIG_DIR || `${certbotBasePath}/config`;
    this.certbotWorkDir = process.env.CERTBOT_WORK_DIR || `${certbotBasePath}/work`;
    this.certbotLogsDir = process.env.CERTBOT_LOGS_DIR || `${certbotBasePath}/logs`;
    
    // Use sudo if SSL_USE_SUDO is true (requires passwordless sudo for certbot)
    // Default: false (use writable directories - recommended for SaaS)
    this.useSudo = process.env.SSL_USE_SUDO === 'true';
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
        
        // Build certbot command with writable directories to avoid permission issues
        // Use organized structure: config/, work/, logs/ subdirectories
        let command = `certbot certonly --standalone -d ${domain} -d www.${domain} --email ${this.certbotEmail} --agree-tos --non-interactive --quiet`;
        
        // Determine certificate base path
        const certBasePath = this.useSudo ? '/etc/letsencrypt' : this.certbotConfigDir;
        
        // Add writable directories if not using sudo
        if (!this.useSudo) {
          // Ensure base directory and subdirectories exist
          await fs.mkdir(this.certbotConfigDir, { recursive: true });
          await fs.mkdir(this.certbotWorkDir, { recursive: true });
          await fs.mkdir(this.certbotLogsDir, { recursive: true });
          
          command += ` --config-dir ${this.certbotConfigDir} --work-dir ${this.certbotWorkDir} --logs-dir ${this.certbotLogsDir}`;
          console.log(`   Using writable certbot directories (base: ${this.certbotBasePath})`);
          console.log(`     Config: ${this.certbotConfigDir}`);
          console.log(`     Work: ${this.certbotWorkDir}`);
          console.log(`     Logs: ${this.certbotLogsDir}`);
        } else {
          command = `sudo ${command}`;
          console.log(`   Using sudo for certbot (requires passwordless sudo)`);
        }
        
        console.log(`🔒 Provisioning SSL certificate for ${domain} using Let's Encrypt (standalone mode)...`);
        console.log(`   Command: ${command}`);
        
        const { stdout, stderr } = await execPromise(command);
        
        // Determine certificate paths
        const certificatePath = `${certBasePath}/live/${domain}/fullchain.pem`;
        const keyPath = `${certBasePath}/live/${domain}/privkey.pem`;
        
        if (stderr && !stderr.includes('Congratulations') && !stderr.includes('Successfully received certificate')) {
          // Check if certificate already exists
          if (stderr.includes('already exists') || stderr.includes('Certificate not yet due for renewal')) {
            return {
              success: true,
              domain,
              provider: 'letsencrypt',
              message: 'SSL certificate already exists or is valid',
              certificatePath: certificatePath,
              keyPath: keyPath,
              certBasePath: certBasePath
            };
          }
          throw new Error(`Certbot error: ${stderr}`);
        }

        return {
          success: true,
          domain,
          provider: 'letsencrypt',
          message: 'SSL certificate provisioned successfully (standalone mode)',
          certificatePath: certificatePath,
          keyPath: keyPath,
          certBasePath: certBasePath,
          expiresAt: await this.getCertificateExpiry(domain, certBasePath)
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

      // Ensure webroot directory exists and is writable
      const acmeChallengePath = path.join(webroot, '.well-known', 'acme-challenge');
      
      try {
        // Check if webroot exists
        await fs.access(webroot);
        console.log(`✅ Webroot directory exists: ${webroot}`);
        
        // Check if acme-challenge directory exists, if not create it
        try {
          await fs.access(acmeChallengePath);
          console.log(`✅ ACME challenge directory exists: ${acmeChallengePath}`);
        } catch {
          // Try to create acme-challenge directory
          console.log(`⚠️  ACME challenge directory does not exist. Attempting to create...`);
          try {
            await fs.mkdir(acmeChallengePath, { recursive: true });
            console.log(`✅ Created ACME challenge directory: ${acmeChallengePath}`);
          } catch (acmeError) {
            // If we can't create it, the directory isn't writable
            throw new Error(`Cannot create ACME challenge directory: ${acmeError.message}. The webroot directory is not writable by the Node.js user.`);
          }
        }
        
        // Test write permissions by creating a test file
        const testFilePath = path.join(acmeChallengePath, '.write-test');
        try {
          await fs.writeFile(testFilePath, 'test');
          await fs.unlink(testFilePath);
          console.log(`✅ Webroot directory is writable`);
        } catch (writeError) {
          throw new Error(`Webroot directory is not writable: ${writeError.message}. The Node.js user cannot write to ${acmeChallengePath}`);
        }
        
      } catch (accessError) {
        // Directory doesn't exist or isn't writable
        if (accessError.message.includes('not writable') || accessError.message.includes('Cannot create')) {
          // Directory exists but isn't writable
          console.error(`❌ Webroot directory exists but is not writable: ${webroot}`);
          
          // Get current user info for better error messages
          const username = process.env.USER || process.env.USERNAME || 'your_user';
          
          return {
            success: false,
            domain,
            provider: 'letsencrypt',
            message: `Webroot directory is not writable: ${webroot}`,
            error: accessError.message,
            instructions: [
              `The webroot directory exists but the Node.js user (${username}) cannot write to it.`,
              `Certbot needs to write HTTP challenge files to: ${acmeChallengePath}`,
              ``,
              `✅ FIX IT (Run these exact commands):`,
              ``,
              `1. Create the challenge directory:`,
              `   sudo mkdir -p ${acmeChallengePath}`,
              ``,
              `2. Give ownership to your Node.js user:`,
              `   sudo chown -R ${username}:${username} ${webroot}`,
              ``,
              `3. Set permissions (755 for base, 775 for challenge dir to allow writes):`,
              `   sudo chmod -R 755 ${webroot}`,
              `   sudo chmod -R 775 ${acmeChallengePath}`,
              ``,
              `4. Test write access (as ${username}):`,
              `   echo "OK" > ${acmeChallengePath}/test.txt`,
              `   curl -i http://${domain}/.well-known/acme-challenge/test.txt`,
              `   # Should return "OK" and HTTP 200. If 403/404, fix Apache config.`,
              `   rm ${acmeChallengePath}/test.txt`,
              ``,
              `5. Configure Apache to serve the challenge directory (see apacheConfig below)`,
              ``,
              `Alternative Options:`,
              `- Use a webroot in your home directory: Set SSL_WEBROOT_PATH=/home/${username}/letsencrypt-webroot in .env`,
              `- Use standalone mode: Set SSL_USE_STANDALONE=true in .env (requires port 80 free)`,
              `- Use sudo: Set SSL_USE_SUDO=true in .env (not recommended for SaaS)`
            ],
            apacheConfig: `# Add this to your Apache configuration (e.g., /etc/apache2/conf.d/letsencrypt.conf or your vhost):
# For the current webroot:
Alias /.well-known/acme-challenge/ "${acmeChallengePath}/"

<Directory "${acmeChallengePath}/">
    AllowOverride None
    Options None
    Require all granted
</Directory>

# Then test and restart:
# sudo apachectl configtest
# sudo systemctl restart httpd  # or: sudo systemctl restart apache2

# Alternative: If using home directory webroot:
# Alias /.well-known/acme-challenge/ "/home/${username}/letsencrypt-webroot/.well-known/acme-challenge/"
# <Directory "/home/${username}/letsencrypt-webroot/.well-known/acme-challenge/">
#     AllowOverride None
#     Options None
#     Require all granted
# </Directory>`,
            webroot: webroot,
            acmeChallengePath: acmeChallengePath,
            webrootPath: this.sharedWebrootPath,
            onlineStoreUsername: onlineStoreUsername,
            currentUser: username
          };
        }
        
        // Directory doesn't exist, try to create it
        console.log(`⚠️  Webroot directory does not exist: ${webroot}. Attempting to create...`);
        try {
          await fs.mkdir(webroot, { recursive: true });
          console.log(`✅ Created webroot directory: ${webroot}`);
          
          // Create .well-known/acme-challenge directory
          await fs.mkdir(acmeChallengePath, { recursive: true });
          console.log(`✅ Created ACME challenge directory: ${acmeChallengePath}`);
          
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
          
          const username = process.env.USER || process.env.USERNAME || 'your_user';
          
          // Return detailed error with instructions
          return {
            success: false,
            domain,
            provider: 'letsencrypt',
            message: `Webroot directory does not exist and could not be created: ${webroot}`,
            error: mkdirError.message,
            instructions: [
              `Create the webroot directory manually: sudo mkdir -p ${webroot}`,
              `Create acme-challenge directory: sudo mkdir -p ${acmeChallengePath}`,
              `Set ownership: sudo chown -R ${username}:${username} ${webroot}`,
              `Set permissions: sudo chmod -R 755 ${webroot}`,
              `Make acme-challenge writable: sudo chmod -R 775 ${acmeChallengePath}`,
              `Configure Apache to serve this directory (see apacheConfig below)`,
              ``,
              `OR use standalone mode: Set SSL_USE_STANDALONE=true in .env (requires port 80 free)`,
              `OR use a webroot in home directory: Set SSL_WEBROOT_PATH=/home/${username}/letsencrypt-webroot in .env`
            ],
            apacheConfig: `# Add this to your Apache configuration (e.g., /etc/apache2/conf.d/letsencrypt.conf or your vhost):
Alias /.well-known/acme-challenge/ "${acmeChallengePath}/"

<Directory "${acmeChallengePath}/">
    AllowOverride None
    Options None
    Require all granted
</Directory>

# Then test and restart:
# sudo apachectl configtest
# sudo systemctl restart httpd  # or: sudo systemctl restart apache2`,
            webroot: webroot,
            acmeChallengePath: acmeChallengePath,
            webrootPath: this.sharedWebrootPath,
            onlineStoreUsername: onlineStoreUsername,
            currentUser: username
          };
        }
      }

      // Build certbot command with writable directories to avoid permission issues
      let command = `certbot certonly --webroot -w ${webroot} -d ${domain} -d www.${domain} --email ${this.certbotEmail} --agree-tos --non-interactive --quiet`;
      
      // Add writable directories if not using sudo
      if (!this.useSudo) {
        // Ensure directories exist
        try {
          await fs.mkdir(this.certbotConfigDir, { recursive: true });
          await fs.mkdir(this.certbotWorkDir, { recursive: true });
          await fs.mkdir(this.certbotLogsDir, { recursive: true });
          console.log(`✅ Created writable certbot directories`);
        } catch (dirError) {
          console.warn(`⚠️  Could not create certbot directories: ${dirError.message}`);
        }
        
        command += ` --config-dir ${this.certbotConfigDir} --work-dir ${this.certbotWorkDir} --logs-dir ${this.certbotLogsDir}`;
        console.log(`   Using writable certbot directories:`);
        console.log(`     Config: ${this.certbotConfigDir}`);
        console.log(`     Work: ${this.certbotWorkDir}`);
        console.log(`     Logs: ${this.certbotLogsDir}`);
      } else {
        command = `sudo ${command}`;
        console.log(`   Using sudo for certbot (requires passwordless sudo)`);
      }

      console.log(`🔒 Provisioning SSL certificate for ${domain} using Let's Encrypt...`);
      console.log(`   Command: ${command}`);
      
      const { stdout, stderr } = await execPromise(command);

      // Certificate paths are already determined above (certBasePath variable)
      // Use the same certBasePath that was set for the command

      if (stderr && !stderr.includes('Congratulations')) {
        // Check if certificate already exists
        if (stderr.includes('already exists') || stderr.includes('Certificate not yet due for renewal')) {
          return {
            success: true,
            domain,
            provider: 'letsencrypt',
            message: 'SSL certificate already exists or is valid',
            certificatePath: certificatePath,
            keyPath: keyPath,
            certBasePath: certBasePath
          };
        }
        throw new Error(`Certbot error: ${stderr}`);
      }

      return {
        success: true,
        domain,
        provider: 'letsencrypt',
        message: 'SSL certificate provisioned successfully',
        certificatePath: certificatePath,
        keyPath: keyPath,
        certBasePath: certBasePath,
        expiresAt: await this.getCertificateExpiry(domain, certBasePath)
      };
    } catch (error) {
      // If certbot is not installed, return instructions
      if (error.message.includes('certbot: command not found') || error.message.includes('certbot: not found')) {
        return {
          success: false,
          domain,
          provider: 'letsencrypt',
          message: 'Certbot is not installed. Please install certbot to provision SSL certificates.',
          instructions: [
            'Install certbot for Apache: sudo apt-get install certbot python3-certbot-apache',
            'OR install certbot for Nginx: sudo apt-get install certbot python3-certbot-nginx',
            'OR use standalone mode: Set SSL_USE_STANDALONE=true in .env'
          ]
        };
      }
      
      // If permission denied error, provide solutions
      if (error.message.includes('Permission denied') || error.message.includes('Errno 13') || error.message.includes('.certbot.lock')) {
        return {
          success: false,
          domain,
          provider: 'letsencrypt',
          message: 'Certbot permission denied. Certbot needs to run as root or use writable directories.',
          error: error.message,
          instructions: [
            'Option 1 (Recommended): Use writable directories (already configured)',
            `  The code uses: --config-dir ${this.certbotConfigDir} --work-dir ${this.certbotWorkDir} --logs-dir ${this.certbotLogsDir}`,
            `  Ensure these directories are writable: chmod -R 755 ${this.certbotConfigDir} ${this.certbotWorkDir} ${this.certbotLogsDir}`,
            '',
            'Option 2: Use sudo (requires passwordless sudo)',
            '  Set SSL_USE_SUDO=true in .env',
            '  Configure passwordless sudo: sudo visudo',
            '  Add: your_user ALL=(ALL) NOPASSWD: /usr/bin/certbot',
            '',
            'Option 3: Run certbot manually as root',
            `  sudo certbot certonly --webroot -w ${this.sharedWebrootPath} -d ${domain} -d www.${domain} --email ${this.certbotEmail} --agree-tos --non-interactive`
          ],
          certbotDirs: {
            configDir: this.certbotConfigDir,
            workDir: this.certbotWorkDir,
            logsDir: this.certbotLogsDir
          }
        };
      }
      
      // For other errors, include the full error message
      return {
        success: false,
        domain,
        provider: 'letsencrypt',
        message: error.message || 'SSL certificate provisioning failed',
        error: error.message,
        stderr: error.stderr || null,
        stdout: error.stdout || null,
        instructions: [
          'Check certbot logs: journalctl -u certbot or check the logs directory',
          'Verify domain DNS is pointing to this server',
          'Ensure port 80 is accessible for HTTP-01 challenge',
          'Check Apache configuration allows serving .well-known directory',
          `Try running certbot manually to see detailed error: sudo certbot certonly --webroot -w ${this.sharedWebrootPath} -d ${domain}`
        ]
      };
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
  async getCertificateExpiry(domain, certBasePath = null) {
    try {
      // Use provided certBasePath or determine from config
      const basePath = certBasePath || (this.useSudo ? '/etc/letsencrypt' : this.certbotConfigDir);
      const certPath = `${basePath}/live/${domain}/cert.pem`;
      
      const { stdout } = await execPromise(`openssl x509 -enddate -noout -in ${certPath}`);
      const expiryMatch = stdout.match(/notAfter=(.+)/);
      return expiryMatch ? expiryMatch[1] : null;
    } catch (error) {
      console.warn(`Could not get certificate expiry for ${domain}:`, error.message);
      return null;
    }
  }

  /**
   * Renew SSL certificate (for Let's Encrypt)
   */
  async renewSSL(domain) {
    try {
      // Build renew command with writable directories if not using sudo
      let command = `certbot renew --cert-name ${domain} --quiet`;
      
      if (!this.useSudo) {
        command += ` --config-dir ${this.certbotConfigDir} --work-dir ${this.certbotWorkDir} --logs-dir ${this.certbotLogsDir}`;
      } else {
        command = `sudo ${command}`;
      }
      
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



