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
    console.error('[PDF Service] Error stack:', error.stack?.split('\n').slice(0, 5).join('\n'));
    throw error;
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


