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
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('[PDF Service] Puppeteer browser launched');

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
    if (error.message.includes('Failed to launch the browser process')) {
      enhancedMessage = `Puppeteer failed to launch browser: ${error.message}. This usually means Chrome/Chromium is not installed or missing dependencies. On Linux, you may need to install: sudo apt-get install -y chromium-browser`;
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


