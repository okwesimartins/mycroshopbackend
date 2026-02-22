const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const execPromise = util.promisify(exec);

/**
 * SSL Certificate Service
 * Handles SSL certificate provisioning for custom domains
 */
class SSLService {
  constructor() {
    this.sslProvider = process.env.SSL_PROVIDER || 'letsencrypt';
    this.certbotEmail = process.env.CERTBOT_EMAIL || process.env.ADMIN_EMAIL;
    this.serverIp = process.env.MYCROSHOP_SERVER_IP || process.env.SERVER_IP;
    
    // Webroot path for ACME challenges (defaults to cPanel public_html)
    this.webrootPath = process.env.SSL_WEBROOT_PATH || '/home/legithairng/public_html';
    
    // Certbot base directory (defaults to home directory)
    this.certbotBase = process.env.CERTBOT_BASE_PATH || '/home/legithairng/letsencrypt';
    
    // Certbot subdirectories
    this.configDir = `${this.certbotBase}/config`;
    this.workDir = `${this.certbotBase}/work`;
    this.logsDir = `${this.certbotBase}/logs`;
    
    // Use standalone mode if SSL_USE_STANDALONE is true (doesn't require webroot)
    this.useStandalone = process.env.SSL_USE_STANDALONE === 'true';
  }

  /**
   * Provision SSL certificate for a domain
   * @param {string} domain - Domain name
   * @param {string} onlineStoreUsername - Optional online store username (for logging)
   * @returns {Promise<Object>} SSL provisioning result
   */
  async provisionSSL(domain, onlineStoreUsername = null) {
    if (this.sslProvider !== 'letsencrypt') {
      throw new Error('Only letsencrypt is supported in this build.');
    }

    if (!this.certbotEmail) {
      throw new Error('CERTBOT_EMAIL or ADMIN_EMAIL must be set for Let\'s Encrypt SSL');
    }

    return this.provisionLetsEncrypt(domain, onlineStoreUsername);
  }

  /**
   * Provision SSL using Let's Encrypt (certbot)
   */
  async provisionLetsEncrypt(domain, onlineStoreUsername = null) {
    try {
      // Ensure writable certbot directories
      await fs.mkdir(this.configDir, { recursive: true });
      await fs.mkdir(this.workDir, { recursive: true });
      await fs.mkdir(this.logsDir, { recursive: true });
      console.log(`✅ Created certbot directories (base: ${this.certbotBase})`);

      // Use standalone mode if configured (doesn't require webroot)
      if (this.useStandalone) {
        console.log(`🔒 Using standalone mode for SSL provisioning (no webroot required)`);
        
        const command = `certbot certonly --standalone -d ${domain} -d www.${domain} --email ${this.certbotEmail} --agree-tos --non-interactive --quiet --config-dir ${this.configDir} --work-dir ${this.workDir} --logs-dir ${this.logsDir}`;
        
        console.log(`🔒 Provisioning SSL certificate for ${domain} using Let's Encrypt (standalone mode)...`);
        console.log(`   Command: ${command}`);
        
        const { stdout, stderr } = await execPromise(command);
        
        // Determine certificate paths
        const certBasePath = this.configDir;
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

      // Webroot mode - ensure ACME challenge folder exists and is writable
      const acmePath = path.join(this.webrootPath, '.well-known', 'acme-challenge');
      
      try {
        // Check if webroot exists
        await fs.access(this.webrootPath);
        console.log(`✅ Webroot directory exists: ${this.webrootPath}`);
        
        // Check if acme-challenge directory exists, if not create it
        try {
          await fs.access(acmePath);
          console.log(`✅ ACME challenge directory exists: ${acmePath}`);
        } catch {
          console.log(`⚠️  ACME challenge directory does not exist. Attempting to create...`);
          try {
            await fs.mkdir(acmePath, { recursive: true });
            console.log(`✅ Created ACME challenge directory: ${acmePath}`);
          } catch (acmeError) {
            throw new Error(`Cannot create ACME challenge directory: ${acmeError.message}. The webroot directory is not writable by the Node.js user.`);
          }
        }
        
        // Test write permissions by creating a test file
        const testFilePath = path.join(acmePath, '.write-test');
        try {
          await fs.writeFile(testFilePath, 'test');
          await fs.unlink(testFilePath);
          console.log(`✅ Webroot directory is writable`);
        } catch (writeError) {
          throw new Error(`Webroot directory is not writable: ${writeError.message}. The Node.js user cannot write to ${acmePath}`);
        }
        
      } catch (accessError) {
        // Directory doesn't exist or isn't writable
        if (accessError.message.includes('not writable') || accessError.message.includes('Cannot create')) {
          const username = process.env.USER || process.env.USERNAME || 'legithairng';
          
          return {
            success: false,
            domain,
            provider: 'letsencrypt',
            message: `Webroot directory is not writable: ${this.webrootPath}`,
            error: accessError.message,
            instructions: [
              `The webroot directory exists but the Node.js user (${username}) cannot write to it.`,
              `Certbot needs to write HTTP challenge files to: ${acmePath}`,
              ``,
              `✅ FIX IT (Run these exact commands):`,
              ``,
              `1. Create the challenge directory:`,
              `   sudo mkdir -p ${acmePath}`,
              ``,
              `2. Give ownership to your Node.js user:`,
              `   sudo chown -R ${username}:${username} ${this.webrootPath}`,
              ``,
              `3. Set permissions (755 for base, 775 for challenge dir):`,
              `   sudo chmod -R 755 ${this.webrootPath}`,
              `   sudo chmod -R 775 ${acmePath}`,
              ``,
              `4. Test write access:`,
              `   echo "OK" > ${acmePath}/test.txt`,
              `   curl -I http://${domain}/.well-known/acme-challenge/test.txt`,
              `   # Should return HTTP 200, not 403 or 404`,
              `   rm ${acmePath}/test.txt`,
              ``,
              `5. Configure Apache to serve the challenge directory (see apacheConfig below)`
            ],
            apacheConfig: `# Add this to your Apache configuration (e.g., /etc/apache2/conf.d/letsencrypt.conf):
Alias /.well-known/acme-challenge/ "${acmePath}/"

<Directory "${acmePath}/">
    AllowOverride None
    Options None
    Require all granted
</Directory>

# Test configuration:
# sudo apachectl configtest
# sudo systemctl restart httpd  # or: sudo systemctl restart apache2`,
            webroot: this.webrootPath,
            acmeChallengePath: acmePath,
            currentUser: username
          };
        }
        
        // Directory doesn't exist, try to create it
        console.log(`⚠️  Webroot directory does not exist: ${this.webrootPath}. Attempting to create...`);
        try {
          await fs.mkdir(this.webrootPath, { recursive: true });
          await fs.mkdir(acmePath, { recursive: true });
          console.log(`✅ Created webroot and ACME challenge directories`);
        } catch (mkdirError) {
          const username = process.env.USER || process.env.USERNAME || 'legithairng';
          
          return {
            success: false,
            domain,
            provider: 'letsencrypt',
            message: `Webroot directory does not exist and could not be created: ${this.webrootPath}`,
            error: mkdirError.message,
            instructions: [
              `✅ FIX IT (Run these exact commands):`,
              ``,
              `1. Create the directory structure:`,
              `   sudo mkdir -p ${acmePath}`,
              ``,
              `2. Give ownership to your Node.js user:`,
              `   sudo chown -R ${username}:${username} ${this.webrootPath}`,
              ``,
              `3. Set permissions:`,
              `   sudo chmod -R 755 ${this.webrootPath}`,
              `   sudo chmod -R 775 ${acmePath}`,
              ``,
              `4. Configure Apache (see apacheConfig below)`,
              ``,
              `OR use standalone mode: Set SSL_USE_STANDALONE=true in .env (requires port 80 free)`
            ],
            apacheConfig: `# Add this to your Apache configuration:
Alias /.well-known/acme-challenge/ "${acmePath}/"

<Directory "${acmePath}/">
    AllowOverride None
    Options None
    Require all granted
</Directory>`,
            webroot: this.webrootPath,
            acmeChallengePath: acmePath,
            currentUser: username
          };
        }
      }

      // Build certbot command (webroot mode)
      const command = `certbot certonly --webroot -w ${this.webrootPath} -d ${domain} -d www.${domain} --email ${this.certbotEmail} --agree-tos --non-interactive --quiet --config-dir ${this.configDir} --work-dir ${this.workDir} --logs-dir ${this.logsDir}`;

      console.log(`🔒 Provisioning SSL certificate for ${domain} using Let's Encrypt...`);
      console.log(`   Command: ${command}`);
      
      const { stdout, stderr } = await execPromise(command);

      // Determine certificate paths
      const certBasePath = this.configDir;
      const certificatePath = `${certBasePath}/live/${domain}/fullchain.pem`;
      const keyPath = `${certBasePath}/live/${domain}/privkey.pem`;

      // Check for errors in stderr (certbot outputs errors to stderr even on success)
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
        
        // Check for challenge failures - this means Let's Encrypt cannot access the challenge file via HTTP
        if (stderr.includes('Some challenges have failed') || stderr.includes('challenge failed') || stderr.includes('Failed authorization procedure')) {
          // Try to get more details from certbot logs
          let logDetails = '';
          try {
            const logPath = `${this.logsDir}/letsencrypt.log`;
            const logContent = await fs.readFile(logPath, 'utf8');
            const logLines = logContent.split('\n').slice(-50).join('\n');
            logDetails = logLines;
          } catch (logError) {
            console.warn('Could not read certbot logs:', logError.message);
          }
          
          return {
            success: false,
            domain,
            provider: 'letsencrypt',
            message: 'HTTP-01 challenge failed. Let\'s Encrypt cannot access the challenge file via HTTP.',
            error: stderr.trim(),
            stderr: stderr.trim(),
            stdout: stdout ? stdout.trim() : null,
            logDetails: logDetails,
            instructions: [
              `The HTTP-01 challenge failed. This means Let's Encrypt cannot access the challenge file via HTTP.`,
              ``,
              `🔍 DIAGNOSTIC STEPS:`,
              ``,
              `1. Verify Apache is serving the challenge directory:`,
              `   echo "OK" > ${acmePath}/test.txt`,
              `   curl -I http://${domain}/.well-known/acme-challenge/test.txt`,
              `   # Should return HTTP 200, not 403 or 404`,
              ``,
              `2. Verify DNS is pointing to this server:`,
              `   dig ${domain} +short`,
              `   # Should return your server IP: ${this.serverIp || 'YOUR_SERVER_IP'}`,
              ``,
              `3. Verify port 80 is accessible:`,
              `   curl -I http://${domain}`,
              ``,
              `4. Check certbot logs:`,
              `   cat ${this.logsDir}/letsencrypt.log | tail -50`
            ],
            apacheConfig: `# Ensure this is in your Apache configuration:
Alias /.well-known/acme-challenge/ "${acmePath}/"

<Directory "${acmePath}/">
    AllowOverride None
    Options None
    Require all granted
</Directory>`,
            webroot: this.webrootPath,
            acmeChallengePath: acmePath,
            domain: domain,
            serverIp: this.serverIp,
            certbotLogsDir: this.logsDir
          };
        }
        
        // Other certbot errors
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
          error: error.message,
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
            'The code uses writable directories (already configured)',
            `Config: ${this.configDir}`,
            `Work: ${this.workDir}`,
            `Logs: ${this.logsDir}`,
            `Ensure these directories are writable: chmod -R 755 ${this.configDir} ${this.workDir} ${this.logsDir}`
          ],
          certbotDirs: {
            configDir: this.configDir,
            workDir: this.workDir,
            logsDir: this.logsDir
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
          `Try running certbot manually: certbot certonly --webroot -w ${this.webrootPath} -d ${domain} --config-dir ${this.configDir} --work-dir ${this.workDir} --logs-dir ${this.logsDir}`
        ]
      };
    }
  }

  /**
   * Get certificate expiry date
   */
  async getCertificateExpiry(domain, certBasePath = null) {
    try {
      const basePath = certBasePath || this.configDir;
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
   * Check SSL certificate status
   */
  async checkSSLStatus(domain) {
    try {
      const certPath = `${this.configDir}/live/${domain}/cert.pem`;
      const { stdout } = await execPromise(`openssl x509 -in ${certPath} -noout -dates`);
      
      return {
        exists: true,
        details: stdout
      };
    } catch (error) {
      return { 
        exists: false,
        error: error.message
      };
    }
  }

  /**
   * Renew SSL certificate (for Let's Encrypt)
   */
  async renewSSL(domain) {
    try {
      const command = `certbot renew --cert-name ${domain} --quiet --config-dir ${this.configDir} --work-dir ${this.workDir} --logs-dir ${this.logsDir}`;
      
      const { stdout, stderr } = await execPromise(command);
      
      return {
        success: true,
        domain,
        message: 'SSL certificate renewed successfully'
      };
    } catch (error) {
      return {
        success: false,
        domain,
        error: error.message
      };
    }
  }
}

module.exports = new SSLService();
