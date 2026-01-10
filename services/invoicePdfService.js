const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

/**
 * Ensure a directory exists.
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Render HTML to PDF and PNG preview for an invoice.
 *
 * @param {Object} options
 * @param {string} options.html - Full HTML to render
 * @param {number|string} options.invoiceId - Invoice ID
 * @param {string} options.templateId - Template ID (from AI)
 * @returns {Promise<{ pdfPath: string, previewPath: string }>}
 */
async function generateInvoicePdfAndPreview({ html, invoiceId, templateId }) {
  const baseUploadsDir = path.join(__dirname, '..', 'uploads', 'invoices');
  const pdfDir = path.join(baseUploadsDir, 'pdfs');
  const previewDir = path.join(baseUploadsDir, 'previews');

  ensureDir(pdfDir);
  ensureDir(previewDir);

  const safeTemplateId = String(templateId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const fileBase = `invoice-${invoiceId}-${safeTemplateId}-${Date.now()}`;
  const pdfPath = path.join(pdfDir, `${fileBase}.pdf`);
  const previewPath = path.join(previewDir, `${fileBase}.png`);

  console.log(`[PDF Service] Starting PDF/preview generation for invoice ${invoiceId}, template ${templateId}`);
  console.log(`[PDF Service] Base dir: ${baseUploadsDir}`);
  console.log(`[PDF Service] PDF path: ${pdfPath}`);
  console.log(`[PDF Service] Preview path: ${previewPath}`);

  let browser = null;
  try {
    // Configuration for Puppeteer to find Chrome/Chromium
    // On Linux servers, we need to try multiple approaches
    const launchOptions = {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-web-security'
      ],
      headless: true,
      timeout: 30000 // 30 second timeout
    };

    // Check for custom Chrome path in environment variable first
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      console.log(`[PDF Service] Using Chrome from PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    } else {
      // Try to find system Chrome/Chromium (common paths on Linux)
      // CentOS/RHEL typically installs Chromium at /usr/bin/chromium or /usr/bin/chromium-browser
      // Debian/Ubuntu typically installs at /usr/bin/chromium-browser
      const possibleChromePaths = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',           // CentOS/RHEL (yum install chromium)
        '/usr/bin/chromium-browser',   // Debian/Ubuntu (apt-get install chromium-browser)
        '/usr/local/bin/chrome',
        '/usr/local/bin/chromium',
        '/opt/google/chrome/chrome',   // Some Google Chrome installations
        '/usr/lib/chromium-browser/chromium-browser' // Alternative Debian path
      ];

      // Check if system Chrome/Chromium exists
      for (const chromePath of possibleChromePaths) {
        if (fs.existsSync(chromePath)) {
          console.log(`[PDF Service] Found system Chrome/Chromium at: ${chromePath}`);
          launchOptions.executablePath = chromePath;
          break;
        }
      }

      // If no system Chrome found, Puppeteer will try to use bundled Chrome
      // (requires: npx puppeteer browsers install chrome)
      if (!launchOptions.executablePath) {
        console.log('[PDF Service] No system Chrome/Chromium found, using Puppeteer bundled Chrome');
        console.log('[PDF Service] If this fails, run: npx puppeteer browsers install chrome');
        console.log('[PDF Service] Or install system Chromium: sudo apt-get install -y chromium-browser (Debian/Ubuntu)');
      }
    }

    browser = await puppeteer.launch(launchOptions);
    console.log('[PDF Service] Puppeteer browser launched successfully');

    const page = await browser.newPage();
    console.log('[PDF Service] New page created, setting HTML content...');
    
    await page.setContent(html, { waitUntil: 'networkidle0' });
    console.log('[PDF Service] HTML content loaded, generating PDF...');

    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true
    });
    console.log(`[PDF Service] PDF generated: ${pdfPath}`);
    console.log(`[PDF Service] PDF file exists: ${fs.existsSync(pdfPath)}`);
    console.log(`[PDF Service] PDF file size: ${fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0} bytes`);

    await page.setViewport({ width: 1200, height: 1700, deviceScaleFactor: 2 });
    console.log('[PDF Service] Viewport set, taking screenshot...');
    
    await page.screenshot({
      path: previewPath,
      fullPage: true
    });
    console.log(`[PDF Service] Preview generated: ${previewPath}`);
    console.log(`[PDF Service] Preview file exists: ${fs.existsSync(previewPath)}`);
    console.log(`[PDF Service] Preview file size: ${fs.existsSync(previewPath) ? fs.statSync(previewPath).size : 0} bytes`);

    // Verify files exist
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF file was not created at ${pdfPath}`);
    }
    if (!fs.existsSync(previewPath)) {
      throw new Error(`Preview file was not created at ${previewPath}`);
    }

    console.log('[PDF Service] ✅ PDF and preview generation completed successfully');
    return { pdfPath, previewPath };
  } catch (error) {
    console.error('[PDF Service] ❌ Error generating PDF/preview:', error.message);
    console.error('[PDF Service] Error name:', error.name);
    console.error('[PDF Service] Error stack:', error.stack?.split('\n').slice(0, 10).join('\n'));
    
    // Enhance error message with context
    let enhancedMessage = error.message;
    
    // Check for common Puppeteer errors and provide helpful messages
    if (error.message.includes('Could not find Chrome') || error.message.includes('Chrome not found')) {
      enhancedMessage = `Chrome/Chromium not found. ${error.message}\n\nSOLUTION:\n1. Install Chrome for Puppeteer: npx puppeteer browsers install chrome\n2. OR install system Chromium: sudo apt-get install -y chromium-browser (Debian/Ubuntu) or sudo yum install -y chromium (CentOS/RHEL)\n3. OR use system Chrome: The system should have Chrome installed at /usr/bin/google-chrome or /usr/bin/chromium`;
    } else if (error.message.includes('Failed to launch the browser process')) {
      enhancedMessage = `Puppeteer failed to launch browser: ${error.message}. This usually means Chrome/Chromium is not installed or missing dependencies. On Linux, you may need to install: sudo apt-get install -y chromium-browser (Debian/Ubuntu) or sudo yum install -y chromium (CentOS/RHEL)`;
    } else if (error.message.includes('Browser closed unexpectedly')) {
      enhancedMessage = `Browser closed unexpectedly: ${error.message}. This may be due to insufficient memory or permissions.`;
    } else if (error.message.includes('ENOENT') || error.message.includes('no such file')) {
      enhancedMessage = `File system error: ${error.message}. Check if directories exist and are writable. PDF dir: ${pdfDir}, Preview dir: ${previewDir}`;
    } else if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
      enhancedMessage = `Permission denied: ${error.message}. Check write permissions for directories: ${pdfDir}, ${previewDir}`;
    }
    
    // Create enhanced error with all context
    const enhancedError = new Error(enhancedMessage);
    enhancedError.originalError = error;
    enhancedError.pdfPath = pdfPath;
    enhancedError.previewPath = previewPath;
    enhancedError.pdfDir = pdfDir;
    enhancedError.previewDir = previewDir;
    enhancedError.pdfDirExists = fs.existsSync(pdfDir);
    enhancedError.previewDirExists = fs.existsSync(previewDir);
    enhancedError.stack = error.stack;
    
    // Add installation instructions for Chrome errors
    if (error.message.includes('Could not find Chrome') || error.message.includes('Chrome not found')) {
      enhancedError.installationCommand = 'npx puppeteer browsers install chrome';
      enhancedError.installationInstructions = {
        option1: 'Install Chrome via Puppeteer: npx puppeteer browsers install chrome',
        option2: 'Install system Chromium (Debian/Ubuntu): sudo apt-get install -y chromium-browser',
        option3: 'Install system Chromium (CentOS/RHEL): sudo yum install -y chromium',
        option4: 'Set custom path in .env: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium'
      };
    }
    
    throw enhancedError;
  } finally {
    if (browser) {
      await browser.close();
      console.log('[PDF Service] Browser closed');
    }
  }
}

module.exports = {
  generateInvoicePdfAndPreview
};


