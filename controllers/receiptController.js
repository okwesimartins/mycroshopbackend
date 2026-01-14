/**
 * Receipt Controller
 * Handles receipt generation, PDF creation, and ESC/POS command generation
 */

const { generateReceiptTemplate } = require('../services/receiptTemplate');
const { generateEscPosReceipt } = require('../services/receiptEscPosService');
const { generateInvoicePdfAndPreview } = require('../services/invoicePdfService');
const { extractColorsFromLogo } = require('../services/colorExtractionService');

/**
 * Generate receipt from invoice
 * POST /api/v1/invoices/:id/generate-receipt
 */
async function generateReceiptFromInvoice(req, res) {
  try {
    const { id } = req.params;
    const { include_stamp = true, stamp_style = 'rectangular' } = req.body;

    // Get tenant info
    const tenant = req.tenant || req.user?.tenant;
    const isFreePlan = tenant?.subscription_plan === 'free';
    const tenantId = isFreePlan ? tenant?.id : null;

    // Find invoice
    const invoice = await req.db.models.Invoice.findOne({
      where: {
        id: id,
        ...(isFreePlan ? { tenant_id: tenantId } : {})
      },
      include: [
        {
          model: req.db.models.Store,
          required: false,
          attributes: ['id', 'name', 'address', 'city', 'state', 'country', 'phone', 'email', 'logo_url']
        },
        {
          model: req.db.models.Customer,
          required: false,
          attributes: ['id', 'name', 'email', 'phone', 'address', 'city', 'state', 'country']
        }
      ]
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    // Get invoice items
    const invoiceItems = await req.db.models.InvoiceItem.findAll({
      where: {
        invoice_id: invoice.id,
        ...(isFreePlan ? { tenant_id: tenantId } : {})
      },
      order: [['id', 'ASC']]
    });

    if (!invoiceItems || invoiceItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invoice has no items. Cannot generate receipt.'
      });
    }

    // Get store info
    const store = invoice.Store || {};
    const logoUrl = store.logo_url || null;

    // Extract colors from logo (optional, with timeout)
    let brandColors = {};
    if (logoUrl) {
      try {
        const colorPromise = extractColorsFromLogo(logoUrl);
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
        brandColors = await Promise.race([colorPromise, timeoutPromise]) || {};
      } catch (error) {
        console.warn('Could not extract colors from logo, using defaults:', error.message);
      }
    }

    // Generate receipt number
    const receiptNumber = `RCP-${invoice.invoice_number.replace('INV-', '')}`;

    // Prepare receipt data
    const receiptData = {
      receipt_number: receiptNumber,
      transaction_date: invoice.issue_date || new Date().toISOString().split('T')[0],
      transaction_time: new Date().toLocaleTimeString(),
      currency: invoice.currency || 'NGN',
      currency_symbol: invoice.currency_symbol || (invoice.currency === 'USD' ? '$' : invoice.currency === 'GBP' ? '£' : invoice.currency === 'EUR' ? '€' : invoice.currency === 'NGN' ? '₦' : '$'),
      subtotal: Number(invoice.subtotal || 0),
      tax_amount: Number(invoice.tax_amount || 0),
      discount_amount: Number(invoice.discount_amount || 0),
      total: Number(invoice.total || 0),
      payment_method: invoice.payment_method || 'Cash',
      items: invoiceItems.map(item => ({
        item_name: item.item_name,
        quantity: Number(item.quantity || 0),
        unit_price: Number(item.unit_price || item.price || 0),
        price: Number(item.unit_price || item.price || 0),
        total: Number(item.total || (Number(item.quantity || 0) * Number(item.unit_price || item.price || 0)))
      })),
      company_name: store.name || 'Business',
      primary_color: brandColors.primary || '#2563EB'
    };

    // Generate receipt HTML
    const receiptHtml = generateReceiptTemplate({
      receipt: receiptData,
      store: store,
      items: invoiceItems,
      logoUrl: logoUrl,
      colors: brandColors,
      digitalStamp: include_stamp ? {
        company_name: store.name || 'Business',
        style: stamp_style
      } : null
    });

    // Generate PDF and preview
    let pdfPath = null;
    let previewPath = null;
    let pdfUrl = null;
    let previewUrl = null;

    try {
      const result = await generateInvoicePdfAndPreview({
        html: receiptHtml,
        invoiceId: invoice.id,
        templateId: 'receipt'
      });

      pdfPath = result.pdfPath;
      previewPath = result.previewPath;

      // Normalize paths to URLs
      const normalizePath = (localPath) => {
        if (!localPath) return null;
        let normalized = String(localPath).replace(/\\/g, '/');
        const uploadsIndex = normalized.indexOf('/uploads');
        if (uploadsIndex !== -1) {
          return normalized.substring(uploadsIndex);
        }
        const filename = normalized.split('/').pop();
        if (filename.endsWith('.pdf')) {
          return `/uploads/invoices/pdfs/${filename}`;
        } else if (filename.match(/\.(png|jpg|jpeg)$/i)) {
          return `/uploads/invoices/previews/${filename}`;
        }
        return null;
      };

      pdfUrl = normalizePath(pdfPath);
      previewUrl = normalizePath(previewPath);
    } catch (pdfError) {
      console.error('Error generating PDF/preview for receipt:', pdfError);
      // Continue without PDF - ESC/POS will still work
    }

    // Generate ESC/POS commands
    let escPosCommands = null;
    let escPosCommandsBase64 = null;

    try {
      escPosCommands = await generateEscPosReceipt(receiptData, {
        includeStamp: include_stamp,
        stampStyle: stamp_style,
        maxWidth: 200
      });
      escPosCommandsBase64 = escPosCommands.toString('base64');
    } catch (escPosError) {
      console.error('Error generating ESC/POS commands:', escPosError);
      // Continue without ESC/POS - PDF/preview will still work
    }

    // Save receipt to database (if receipts table exists)
    let savedReceipt = null;
    try {
      // Check if receipts table exists
      const [tables] = await req.db.query(`
        SELECT TABLE_NAME 
        FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'receipts'
      `);

      if (tables && tables.length > 0) {
        // Save receipt
        const receiptInsertQuery = isFreePlan && tenantId
          ? `INSERT INTO receipts (tenant_id, invoice_id, receipt_number, preview_url, pdf_url, esc_pos_commands, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, NOW())`
          : `INSERT INTO receipts (invoice_id, receipt_number, preview_url, pdf_url, esc_pos_commands, created_at) 
             VALUES (?, ?, ?, ?, ?, NOW())`;

        const receiptParams = isFreePlan && tenantId
          ? [tenantId, invoice.id, receiptNumber, previewUrl, pdfUrl, escPosCommandsBase64]
          : [invoice.id, receiptNumber, previewUrl, pdfUrl, escPosCommandsBase64];

        await req.db.query(receiptInsertQuery, {
          replacements: receiptParams
        });

        // Fetch saved receipt
        const [savedReceipts] = await req.db.query(
          isFreePlan && tenantId
            ? `SELECT * FROM receipts WHERE tenant_id = ? AND invoice_id = ? ORDER BY id DESC LIMIT 1`
            : `SELECT * FROM receipts WHERE invoice_id = ? ORDER BY id DESC LIMIT 1`,
          {
            replacements: isFreePlan && tenantId ? [tenantId, invoice.id] : [invoice.id]
          }
        );

        if (savedReceipts && savedReceipts.length > 0) {
          savedReceipt = savedReceipts[0];
        }
      }
    } catch (saveError) {
      console.warn('Could not save receipt to database (table may not exist):', saveError.message);
      // Continue - receipt generation still works
    }

    // Return receipt data
    return res.json({
      success: true,
      message: 'Receipt generated successfully',
      data: {
        receipt: {
          id: savedReceipt?.id || null,
          receipt_number: receiptNumber,
          invoice_id: invoice.id,
          transaction_date: receiptData.transaction_date,
          transaction_time: receiptData.transaction_time,
          total: receiptData.total,
          currency: receiptData.currency,
          payment_method: receiptData.payment_method
        },
        preview_url: previewUrl,
        pdf_url: pdfUrl,
        esc_pos_commands: escPosCommandsBase64,
        esc_pos_commands_length: escPosCommands ? escPosCommands.length : 0,
        receipt_data: receiptData
      }
    });

  } catch (error) {
    console.error('Error generating receipt:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate receipt',
      error: error.message
    });
  }
}

/**
 * Generate standalone receipt (not tied to an invoice)
 * POST /api/v1/receipts/standalone
 *
 * Useful for walk-in customers or quick sales where no full invoice is needed.
 */
async function generateStandaloneReceipt(req, res) {
  try {
    const {
      store_id,
      items,
      currency = 'NGN',
      currency_symbol,
      payment_method = 'Cash',
      customer_name,
      customer_phone,
      customer_email,
      notes
    } = req.body;

    // Basic validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one item is required to generate a receipt'
      });
    }

    // Get tenant info
    const tenant = req.tenant || req.user?.tenant;
    const isFreePlan = tenant?.subscription_plan === 'free';
    const tenantId = isFreePlan ? tenant?.id : null;

    // Optional: find store for branding information (if store_id provided)
    let store = {};
    if (store_id) {
      const where = { id: store_id };
      if (isFreePlan && tenantId) {
        where.tenant_id = tenantId;
      }
      const foundStore = await req.db.models.Store.findOne({ where });
      if (!foundStore) {
        return res.status(404).json({
          success: false,
          message: 'Store not found'
        });
      }
      store = foundStore.toJSON ? foundStore.toJSON() : foundStore;
    }

    const logoUrl = store.logo_url || null;

    // Extract colors from logo (optional, with timeout)
    let brandColors = {};
    if (logoUrl) {
      try {
        const colorPromise = extractColorsFromLogo(logoUrl);
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
        brandColors = await Promise.race([colorPromise, timeoutPromise]) || {};
      } catch (error) {
        console.warn('Could not extract colors from logo for standalone receipt, using defaults:', error.message);
      }
    }

    // Calculate totals from items if not provided
    let subtotal = 0;
    items.forEach((item) => {
      const qty = Number(item.quantity || 0);
      const price = Number(item.unit_price || item.price || 0);
      const lineTotal = qty * price;
      subtotal += lineTotal;
    });

    const tax_amount = 0;
    const discount_amount = 0;
    const total = subtotal - discount_amount + tax_amount;

    // Generate receipt number (standalone)
    const timestamp = Date.now();
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const receiptNumber = `RCP-${timestamp}-${randomSuffix}`;

    const effectiveCurrencySymbol =
      currency_symbol ||
      (currency === 'USD'
        ? '$'
        : currency === 'GBP'
        ? '£'
        : currency === 'EUR'
        ? '€'
        : currency === 'NGN'
        ? '₦'
        : '$');

    // Prepare receipt data
    const now = new Date();
    const receiptData = {
      receipt_number: receiptNumber,
      transaction_date: now.toISOString().split('T')[0],
      transaction_time: now.toLocaleTimeString(),
      currency,
      currency_symbol: effectiveCurrencySymbol,
      subtotal,
      tax_amount,
      discount_amount,
      total,
      payment_method,
      items: items.map((item) => {
        const qty = Number(item.quantity || 0);
        const price = Number(item.unit_price || item.price || 0);
        const lineTotal = Number(item.total || qty * price);
        return {
          item_name: item.item_name || item.name || 'Item',
          quantity: qty,
          unit_price: price,
          price,
          total: lineTotal
        };
      }),
      company_name: store.name || 'Business',
      customer_name: customer_name || null,
      customer_phone: customer_phone || null,
      customer_email: customer_email || null,
      notes: notes || null,
      primary_color: brandColors.primary || '#2563EB'
    };

    // Generate receipt HTML
    const receiptHtml = generateReceiptTemplate({
      receipt: receiptData,
      store: store,
      items: items,
      logoUrl: logoUrl,
      colors: brandColors,
      digitalStamp: {
        company_name: store.name || 'Business',
        style: 'rectangular'
      }
    });

    // Generate PDF and preview
    let pdfPath = null;
    let previewPath = null;
    let pdfUrl = null;
    let previewUrl = null;

    try {
      const result = await generateInvoicePdfAndPreview({
        html: receiptHtml,
        invoiceId: null,
        templateId: 'receipt_standalone'
      });

      pdfPath = result.pdfPath;
      previewPath = result.previewPath;

      const normalizePath = (localPath) => {
        if (!localPath) return null;
        let normalized = String(localPath).replace(/\\/g, '/');
        const uploadsIndex = normalized.indexOf('/uploads');
        if (uploadsIndex !== -1) {
          return normalized.substring(uploadsIndex);
        }
        const filename = normalized.split('/').pop();
        if (filename.endsWith('.pdf')) {
          return `/uploads/invoices/pdfs/${filename}`;
        } else if (filename.match(/\.(png|jpg|jpeg)$/i)) {
          return `/uploads/invoices/previews/${filename}`;
        }
        return null;
      };

      pdfUrl = normalizePath(pdfPath);
      previewUrl = normalizePath(previewPath);
    } catch (pdfError) {
      console.error('Error generating PDF/preview for standalone receipt:', pdfError);
      // Continue without PDF - ESC/POS will still work
    }

    // Generate ESC/POS commands
    let escPosCommands = null;
    let escPosCommandsBase64 = null;

    try {
      escPosCommands = await generateEscPosReceipt(receiptData, {
        includeStamp: true,
        stampStyle: 'rectangular',
        maxWidth: 200
      });
      escPosCommandsBase64 = escPosCommands.toString('base64');
    } catch (escPosError) {
      console.error('Error generating ESC/POS commands for standalone receipt:', escPosError);
    }

    // Save receipt to database (if receipts table exists)
    let savedReceipt = null;
    try {
      const [tables] = await req.db.query(`
        SELECT TABLE_NAME 
        FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'receipts'
      `);

      if (tables && tables.length > 0) {
        const receiptInsertQuery = isFreePlan && tenantId
          ? `INSERT INTO receipts (tenant_id, invoice_id, receipt_number, preview_url, pdf_url, esc_pos_commands, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, NOW())`
          : `INSERT INTO receipts (invoice_id, receipt_number, preview_url, pdf_url, esc_pos_commands, created_at) 
             VALUES (?, ?, ?, ?, ?, NOW())`;

        const receiptParams = isFreePlan && tenantId
          ? [tenantId, null, receiptNumber, previewUrl, pdfUrl, escPosCommandsBase64]
          : [null, receiptNumber, previewUrl, pdfUrl, escPosCommandsBase64];

        await req.db.query(receiptInsertQuery, {
          replacements: receiptParams
        });

        const [savedReceipts] = await req.db.query(
          isFreePlan && tenantId
            ? `SELECT * FROM receipts WHERE tenant_id = ? AND receipt_number = ? ORDER BY id DESC LIMIT 1`
            : `SELECT * FROM receipts WHERE receipt_number = ? ORDER BY id DESC LIMIT 1`,
          {
            replacements: isFreePlan && tenantId ? [tenantId, receiptNumber] : [receiptNumber]
          }
        );

        if (savedReceipts && savedReceipts.length > 0) {
          savedReceipt = savedReceipts[0];
        }
      }
    } catch (saveError) {
      console.warn('Could not save standalone receipt to database (table may not exist):', saveError.message);
    }

    return res.json({
      success: true,
      message: 'Standalone receipt generated successfully',
      data: {
        receipt: {
          id: savedReceipt?.id || null,
          receipt_number: receiptNumber,
          invoice_id: null,
          transaction_date: receiptData.transaction_date,
          transaction_time: receiptData.transaction_time,
          total: receiptData.total,
          currency: receiptData.currency,
          payment_method: receiptData.payment_method,
          customer_name: receiptData.customer_name || null
        },
        preview_url: previewUrl,
        pdf_url: pdfUrl,
        esc_pos_commands: escPosCommandsBase64,
        esc_pos_commands_length: escPosCommands ? escPosCommands.length : 0,
        receipt_data: receiptData
      }
    });
  } catch (error) {
    console.error('Error generating standalone receipt:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate standalone receipt',
      error: error.message
    });
  }
}

/**
 * Get receipt by ID
 * GET /api/v1/receipts/:id
 */
async function getReceiptById(req, res) {
  try {
    const { id } = req.params;

    // Get tenant info
    const tenant = req.tenant || req.user?.tenant;
    const isFreePlan = tenant?.subscription_plan === 'free';
    const tenantId = isFreePlan ? tenant?.id : null;

    // Find receipt
    const receiptQuery = isFreePlan && tenantId
      ? `SELECT * FROM receipts WHERE id = ? AND tenant_id = ?`
      : `SELECT * FROM receipts WHERE id = ?`;

    const [receipts] = await req.db.query(receiptQuery, {
      replacements: isFreePlan && tenantId ? [id, tenantId] : [id]
    });

    if (!receipts || receipts.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Receipt not found'
      });
    }

    const receipt = receipts[0];

    return res.json({
      success: true,
      data: {
        receipt: {
          id: receipt.id,
          receipt_number: receipt.receipt_number,
          invoice_id: receipt.invoice_id,
          preview_url: receipt.preview_url,
          pdf_url: receipt.pdf_url,
          esc_pos_commands: receipt.esc_pos_commands,
          created_at: receipt.created_at
        }
      }
    });

  } catch (error) {
    console.error('Error fetching receipt:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch receipt',
      error: error.message
    });
  }
}

/**
 * Get all receipts for an invoice
 * GET /api/v1/invoices/:id/receipts
 */
async function getReceiptsByInvoice(req, res) {
  try {
    const { id } = req.params;

    // Get tenant info
    const tenant = req.tenant || req.user?.tenant;
    const isFreePlan = tenant?.subscription_plan === 'free';
    const tenantId = isFreePlan ? tenant?.id : null;

    // Find receipts
    const receiptQuery = isFreePlan && tenantId
      ? `SELECT * FROM receipts WHERE invoice_id = ? AND tenant_id = ? ORDER BY created_at DESC`
      : `SELECT * FROM receipts WHERE invoice_id = ? ORDER BY created_at DESC`;

    const [receipts] = await req.db.query(receiptQuery, {
      replacements: isFreePlan && tenantId ? [id, tenantId] : [id]
    });

    return res.json({
      success: true,
      data: {
        receipts: receipts.map(r => ({
          id: r.id,
          receipt_number: r.receipt_number,
          invoice_id: r.invoice_id,
          preview_url: r.preview_url,
          pdf_url: r.pdf_url,
          created_at: r.created_at
        })),
        count: receipts.length
      }
    });

  } catch (error) {
    console.error('Error fetching receipts:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch receipts',
      error: error.message
    });
  }
}

module.exports = {
  generateReceiptFromInvoice,
  generateStandaloneReceipt,
  getReceiptById,
  getReceiptsByInvoice
};
