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

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true
    });

    await page.setViewport({ width: 1200, height: 1700, deviceScaleFactor: 2 });
    await page.screenshot({
      path: previewPath,
      fullPage: true
    });
  } finally {
    await browser.close();
  }

  return { pdfPath, previewPath };
}

module.exports = {
  generateInvoicePdfAndPreview
};


