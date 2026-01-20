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
    if (!tenant) {
      return res.status(400).json({
        success: false,
        message: 'Tenant information not found. Please ensure you are authenticated.'
      });
    }
    
    const isFreePlan = tenant.subscription_plan === 'free';
    const tenantId = isFreePlan ? tenant.id : null;

    // Get store for branding information (if store_id provided and user is enterprise)
    // For free users: use tenant information directly (they don't have physical stores)
    let store = {};
    let logoUrl = null;
    let companyName = tenant.name || 'Business';
    
    if (store_id && !isFreePlan) {
      // Enterprise users: try to find store
      const foundStore = await req.db.models.Store.findOne({ 
        where: { id: store_id }
      });
      if (!foundStore) {
        return res.status(404).json({
          success: false,
          message: 'Store not found'
        });
      }
      store = foundStore.toJSON ? foundStore.toJSON() : foundStore;
      logoUrl = store.logo_url || tenant.logo_url || null;
      companyName = store.name || tenant.name || 'Business';
    } else {
      // Free users OR no store_id provided: use tenant information for branding
      logoUrl = tenant.logo_url || null;
      companyName = tenant.name || 'Business';
      // Set store object to have tenant info for consistency
      store = {
        name: tenant.name,
        logo_url: tenant.logo_url,
        address: tenant.address,
        phone: tenant.phone,
        email: null, // Tenants don't have email, stores do
        city: null,
        state: null,
        country: tenant.country || 'Nigeria'
      };
    }

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
      company_name: companyName,
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
        company_name: companyName,
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
      // For standalone receipts on thermal printers, simplify:
      // - Skip company logo/name header (saves space, faster printing)
      // - Skip digital stamp (simpler receipt, faster)
      escPosCommands = await generateEscPosReceipt(receiptData, {
        includeStamp: false, // Disable stamp for simpler thermal receipts
        includeCompanyName: false, // Skip company name header for simplicity
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

/**
 * Sync receipt from offline client
 * POST /api/v1/receipts/sync
 * 
 * Allows mobile app to sync receipt data when back online after printing offline.
 * Handles duplicate prevention using receipt_number as unique identifier.
 */
async function syncReceipt(req, res) {
  try {
    const {
      receipt_number,
      receipt_data,
      esc_pos_commands_base64,
      store_id,
      offline_print_time, // Timestamp when receipt was printed offline
      ...otherFields
    } = req.body;

    // Basic validation
    if (!receipt_number) {
      return res.status(400).json({
        success: false,
        message: 'receipt_number is required'
      });
    }

    if (!receipt_data) {
      return res.status(400).json({
        success: false,
        message: 'receipt_data is required'
      });
    }

    // Get tenant info
    const tenant = req.tenant || req.user?.tenant;
    if (!tenant) {
      return res.status(400).json({
        success: false,
        message: 'Tenant information not found. Please ensure you are authenticated.'
      });
    }

    const isFreePlan = tenant.subscription_plan === 'free';
    const tenantId = isFreePlan ? tenant.id : null;

    // Check if receipt already exists (duplicate prevention)
    const existingReceiptQuery = isFreePlan && tenantId
      ? `SELECT * FROM receipts WHERE tenant_id = ? AND receipt_number = ? LIMIT 1`
      : `SELECT * FROM receipts WHERE receipt_number = ? LIMIT 1`;
    
    const existingReceiptParams = isFreePlan && tenantId 
      ? [tenantId, receipt_number] 
      : [receipt_number];

    const [existingReceipts] = await req.db.query(existingReceiptQuery, {
      replacements: existingReceiptParams
    });

    // If receipt already exists, return success (idempotent - safe to retry)
    if (existingReceipts && existingReceipts.length > 0) {
      const existing = existingReceipts[0];
      return res.json({
        success: true,
        message: 'Receipt already synced',
        data: {
          receipt: {
            id: existing.id,
            receipt_number: existing.receipt_number,
            invoice_id: existing.invoice_id,
            transaction_date: existing.transaction_date,
            transaction_time: existing.transaction_time,
            total: existing.total,
            currency: existing.currency,
            payment_method: existing.payment_method,
            customer_name: existing.customer_name,
            synced_at: existing.created_at
          },
          already_synced: true
        }
      });
    }

    // Generate ESC/POS commands if not provided (for receipts that were printed offline)
    let escPosCommandsBase64 = esc_pos_commands_base64;
    let escPosCommands = null;

    if (!escPosCommandsBase64) {
      try {
        escPosCommands = await generateEscPosReceipt(receipt_data, {
          includeStamp: false,
          includeCompanyName: false,
          stampStyle: 'rectangular',
          maxWidth: 200
        });
        escPosCommandsBase64 = escPosCommands.toString('base64');
      } catch (escPosError) {
        console.warn('Could not generate ESC/POS commands during sync:', escPosError.message);
        // Continue without ESC/POS - receipt will still be saved
      }
    } else {
      // Decode base64 to get Buffer for length calculation
      try {
        escPosCommands = Buffer.from(escPosCommandsBase64, 'base64');
      } catch (decodeError) {
        console.warn('Could not decode ESC/POS commands:', decodeError.message);
      }
    }

    // Get store information for PDF generation (if store_id provided)
    let store = {};
    if (store_id && !isFreePlan) {
      try {
        const foundStore = await req.db.models.Store.findOne({ 
          where: { id: store_id }
        });
        if (foundStore) {
          store = foundStore.toJSON ? foundStore.toJSON() : foundStore;
        }
      } catch (storeError) {
        console.warn('Could not fetch store info during sync:', storeError.message);
      }
    } else if (!store_id) {
      // Free users or no store_id: use tenant info
      store = {
        name: tenant.name,
        logo_url: tenant.logo_url,
        address: tenant.address,
        phone: tenant.phone
      };
    }

    // Generate PDF and preview (optional - might not be available offline)
    let previewUrl = null;
    let pdfUrl = null;

    try {
      // Try to generate PDF/preview from receipt_data
      // This uses the same logic as generateStandaloneReceipt
      const result = await generateInvoicePdfAndPreview({
        html: generateReceiptTemplate({
          receipt: receipt_data,
          store: store,
          items: receipt_data.items || []
        }),
        filename: `receipt-${receipt_number}`,
        type: 'receipt'
      });

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

      pdfUrl = normalizePath(result.pdfPath);
      previewUrl = normalizePath(result.previewPath);
    } catch (pdfError) {
      console.warn('Could not generate PDF/preview during sync:', pdfError.message);
      // Continue without PDF - receipt will still be saved
    }

    // Save receipt to database
    const receiptInsertQuery = isFreePlan && tenantId
      ? `INSERT INTO receipts (tenant_id, invoice_id, receipt_number, preview_url, pdf_url, esc_pos_commands, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, NOW())`
      : `INSERT INTO receipts (invoice_id, receipt_number, preview_url, pdf_url, esc_pos_commands, created_at) 
         VALUES (?, ?, ?, ?, ?, NOW())`;

    const receiptParams = isFreePlan && tenantId
      ? [tenantId, null, receipt_number, previewUrl, pdfUrl, escPosCommandsBase64]
      : [null, receipt_number, previewUrl, pdfUrl, escPosCommandsBase64];

    await req.db.query(receiptInsertQuery, {
      replacements: receiptParams
    });

    // Fetch saved receipt
    const [savedReceipts] = await req.db.query(
      isFreePlan && tenantId
        ? `SELECT * FROM receipts WHERE tenant_id = ? AND receipt_number = ? ORDER BY id DESC LIMIT 1`
        : `SELECT * FROM receipts WHERE receipt_number = ? ORDER BY id DESC LIMIT 1`,
      {
        replacements: isFreePlan && tenantId ? [tenantId, receipt_number] : [receipt_number]
      }
    );

    const savedReceipt = savedReceipts && savedReceipts.length > 0 ? savedReceipts[0] : null;

    return res.json({
      success: true,
      message: 'Receipt synced successfully',
      data: {
        receipt: {
          id: savedReceipt?.id || null,
          receipt_number: receipt_number,
          invoice_id: null,
          transaction_date: receipt_data.transaction_date,
          transaction_time: receipt_data.transaction_time,
          total: receipt_data.total,
          currency: receipt_data.currency,
          payment_method: receipt_data.payment_method,
          customer_name: receipt_data.customer_name || null,
          offline_print_time: offline_print_time || null,
          synced_at: savedReceipt?.created_at || new Date().toISOString()
        },
        preview_url: previewUrl,
        pdf_url: pdfUrl,
        esc_pos_commands: escPosCommandsBase64,
        esc_pos_commands_length: escPosCommands ? escPosCommands.length : 0
      }
    });
  } catch (error) {
    console.error('Error syncing receipt:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync receipt',
      error: error.message
    });
  }
}

module.exports = {
  generateReceiptFromInvoice,
  generateStandaloneReceipt,
  getReceiptById,
  getReceiptsByInvoice,
  syncReceipt
};
