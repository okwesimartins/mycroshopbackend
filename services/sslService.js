const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');

const execPromise = util.promisify(exec);

class SSLService {
  constructor() {
    this.sslProvider = process.env.SSL_PROVIDER || 'letsencrypt';
    this.certbotEmail = process.env.CERTBOT_EMAIL || process.env.ADMIN_EMAIL;

    this.webrootPath = process.env.SSL_WEBROOT_PATH || '/home/legithairng/public_html';

    this.certbotBase = process.env.CERTBOT_BASE_PATH || '/home/legithairng/letsencrypt';
    this.configDir = process.env.CERTBOT_CONFIG_DIR || `${this.certbotBase}/config`;
    this.workDir = process.env.CERTBOT_WORK_DIR || `${this.certbotBase}/work`;
    this.logsDir = process.env.CERTBOT_LOGS_DIR || `${this.certbotBase}/logs`;

    this.useStandalone = process.env.SSL_USE_STANDALONE === 'true';
    this.certbotQuiet = process.env.CERTBOT_QUIET !== 'false'; // default true
  }

  async provisionSSL(domain) {
    if (this.sslProvider !== 'letsencrypt') {
      throw new Error('Only letsencrypt is supported.');
    }
    if (!this.certbotEmail) {
      throw new Error("CERTBOT_EMAIL (or ADMIN_EMAIL) must be set.");
    }
    return this.provisionLetsEncrypt(domain);
  }

  async provisionLetsEncrypt(domain) {
    // 1) Ensure certbot dirs
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.mkdir(this.workDir, { recursive: true });
    await fs.mkdir(this.logsDir, { recursive: true });

    // 2) Ensure ACME dir exists inside webroot
    const acmePath = path.join(this.webrootPath, '.well-known', 'acme-challenge');
    await fs.mkdir(acmePath, { recursive: true });

    // 3) Write test file to confirm app can write
    const testFile = path.join(acmePath, '.write-test');
    await fs.writeFile(testFile, 'ok');
    await fs.unlink(testFile);

    // 4) Build certbot command
    const quietFlag = this.certbotQuiet ? '--quiet' : '';
    const baseFlags = [
      'certbot certonly',
      this.useStandalone ? '--standalone' : `--webroot -w ${this.webrootPath}`,
      `-d ${domain}`,
      `-d www.${domain}`,
      `--email ${this.certbotEmail}`,
      '--agree-tos',
      '--non-interactive',
      quietFlag,
      `--config-dir ${this.configDir}`,
      `--work-dir ${this.workDir}`,
      `--logs-dir ${this.logsDir}`,
    ].filter(Boolean).join(' ');

    console.log('🔒 Certbot command:', baseFlags);

    try {
      const { stdout, stderr } = await execPromise(baseFlags);

      // certbot often prints normal info to stderr; only fail if obvious error keywords
      const combined = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
      if (combined.includes('error') || combined.includes('failed') || combined.includes('unauthorized')) {
        // If cert already exists, treat as success
        if (combined.includes('certificate not yet due') || combined.includes('already exists')) {
          return this._success(domain);
        }
        // Return useful diagnostics
        return this._fail(domain, `Certbot challenge failed.`, stdout, stderr);
      }

      return this._success(domain);
    } catch (err) {
      // Capture full output
      return this._fail(domain, `Certbot execution failed: ${err.message}`, err.stdout, err.stderr);
    }
  }

  _success(domain) {
    const certBasePath = this.configDir;
    return {
      success: true,
      domain,
      provider: 'letsencrypt',
      message: 'SSL certificate provisioned successfully',
      certificatePath: `${certBasePath}/live/${domain}/fullchain.pem`,
      keyPath: `${certBasePath}/live/${domain}/privkey.pem`,
      certBasePath,
    };
  }

  async _fail(domain, message, stdout, stderr) {
    // Tail certbot log for details (very helpful)
    let logTail = '';
    try {
      const logPath = path.join(this.logsDir, 'letsencrypt.log');
      const log = await fs.readFile(logPath, 'utf8');
      logTail = log.split('\n').slice(-120).join('\n');
    } catch (_) {}

    return {
      success: false,
      domain,
      provider: 'letsencrypt',
      message,
      stdout: stdout ? String(stdout) : null,
      stderr: stderr ? String(stderr) : null,
      logTail: logTail || null,
      instructions: [
        '1) Confirm DNS for domain + www points to this VPS IP.',
        '2) Confirm port 80 is reachable publicly (HTTP).',
        '3) Confirm Apache serves /.well-known/acme-challenge/ from SSL_WEBROOT_PATH.',
        `Test: echo OK > ${this.webrootPath}/.well-known/acme-challenge/test.txt`,
        `Then: curl -i http://${domain}/.well-known/acme-challenge/test.txt  (must be 200 + OK)`,
      ],
    };
  }

  async checkSSLStatus(domain) {
    try {
      const certPath = `${this.configDir}/live/${domain}/cert.pem`;
      const { stdout } = await execPromise(`openssl x509 -in ${certPath} -noout -dates`);
      return { exists: true, details: stdout };
    } catch (e) {
      return { exists: false, error: e.message };
    }
  }

  async renewSSL(domain) {
    try {
      const command = `certbot renew --cert-name ${domain} ${this.certbotQuiet ? '--quiet' : ''} --config-dir ${this.configDir} --work-dir ${this.workDir} --logs-dir ${this.logsDir}`;
      await execPromise(command);
      return { success: true, domain, message: 'Renewal attempted' };
    } catch (e) {
      return { success: false, domain, error: e.message };
    }
  }
}

module.exports = new SSLService();