const { Sequelize } = require('sequelize');
const moment = require('moment');
const { calculateTax, getTaxInfo } = require('../services/taxCalculator');
const { getTenantById } = require('../config/tenant');
const { extractColorsFromLogo, generateColorPalette } = require('../services/colorExtractionService');
const { generateTemplateOptions } = require('../services/invoiceTemplateGenerator');
const invoiceHtmlTemplates = require('../services/invoiceHtmlTemplates');
const { generateInvoicePdfAndPreview } = require('../services/invoicePdfService');

/**
 * Generate unique invoice number
 */
function generateInvoiceNumber() {
  const prefix = 'INV';
  const timestamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Get all invoices (store-specific or all stores)
 */
async function getAllInvoices(req, res) {
  try {
    const { page = 1, limit = 50, status, customer_id, store_id, start_date, end_date, all_stores } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    
    // Filter by store if store_id provided, unless all_stores is true
    if (store_id && all_stores !== 'true') {
      where.store_id = store_id;
    }
    
    if (status) {
      where.status = status;
    }
    if (customer_id) {
      where.customer_id = customer_id;
    }
    if (start_date || end_date) {
      where.issue_date = {};
      if (start_date) where.issue_date[Sequelize.Op.gte] = start_date;
      if (end_date) where.issue_date[Sequelize.Op.lte] = end_date;
    }

    const { count, rows } = await req.db.models.Invoice.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type']
        },
        {
          model: req.db.models.Customer,
          required: false,
          attributes: ['id', 'name', 'email', 'phone', 'address', 'city', 'state', 'country']
        },
        {
          model: req.db.models.InvoiceItem,
          include: [
            {
              model: req.db.models.Product,
              required: false,
              attributes: ['id', 'name', 'sku', 'description', 'price', 'category']
            }
          ]
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        invoices: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting invoices:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get invoices'
    });
  }
}

/**
 * Helper function to generate AI templates for an invoice
 * Can be called from createInvoice or generateAiTemplatesForInvoice
 */
async function generateTemplatesForInvoice(invoice, tenantId, req) {
  try {
    console.log('\n🔍 generateTemplatesForInvoice called with:');
    console.log('  - Invoice ID:', invoice?.id);
    console.log('  - Invoice type:', typeof invoice);
    console.log('  - Has InvoiceItems:', !!(invoice && invoice.InvoiceItems));
    console.log('  - InvoiceItems type:', typeof invoice?.InvoiceItems);
    console.log('  - InvoiceItems is array:', Array.isArray(invoice?.InvoiceItems));
    console.log('  - InvoiceItems count:', invoice?.InvoiceItems?.length || 0);
    console.log('  - Invoice keys:', invoice ? Object.keys(invoice).filter(k => !k.startsWith('_')).slice(0, 15) : 'none');
    
    let tenant = null;
    try {
      tenant = await getTenantById(tenantId);
    } catch (error) {
      console.warn('Could not fetch tenant for AI templates:', error);
    }

    // Safely extract store and customer - they might be null if foreign keys are null
    const store = (invoice && invoice.Store) ? invoice.Store : {};
    const customer = (invoice && invoice.Customer) ? invoice.Customer : {};
    
    // CRITICAL: Extract items - handle both camelCase and snake_case, and both Sequelize and plain objects
    let items = [];
    if (invoice && invoice.InvoiceItems) {
      items = Array.isArray(invoice.InvoiceItems) ? invoice.InvoiceItems : [];
    } else if (invoice && invoice.invoice_items) {
      items = Array.isArray(invoice.invoice_items) ? invoice.invoice_items : [];
    } else if (invoice && invoice.items) {
      items = Array.isArray(invoice.items) ? invoice.items : [];
    }
    
    console.log('  - Extracted items count:', items.length);
    if (items.length === 0) {
      console.warn('  ⚠️ WARNING: No items found in invoice object!');
      console.warn('  Invoice.InvoiceItems:', invoice?.InvoiceItems);
      console.warn('  Invoice.invoice_items:', invoice?.invoice_items);
      console.warn('  Invoice.items:', invoice?.items);
    }

    const invoiceDataForAi = {
      business_name: (store && store.name) || (tenant && tenant.name) || 'Business Name',
      business_email: (store && store.email) || null,
      business_phone: (store && store.phone) || null,
      customer_name: (customer && customer.name) || 'Customer',
      items_count: Array.isArray(items) ? items.length : 0,
      total_amount: (invoice && invoice.total) || (invoice && invoice.subtotal) || 0,
      currency: 'NGN',
      industry: (tenant && tenant.business_category) || 'general'
    };

    // Default brand colors (fallback)
    const defaultBrandColors = {
      primary: '#0F172A',
      secondary: '#64748B',
      accent: '#4F46E5',
      text: '#0F172A',
      background: '#F9FAFB',
      border: '#E5E7EB',
      table_header: '#111827',
      table_row_alt: '#F3F4F6'
    };

    // Try to extract colors from tenant logo
    let brandColors = defaultBrandColors;
    let logoUrl = null;

    // Check tenant logo first
    if (tenant && tenant.logo_url) {
      logoUrl = tenant.logo_url;
    } else {
      // Fallback: Check for OnlineStore logo if available
      try {
        const OnlineStore = req.db.models.OnlineStore;
        if (OnlineStore) {
          const onlineStore = await OnlineStore.findOne({
            where: { tenant_id: tenantId },
            attributes: ['profile_logo_url']
          });
          if (onlineStore && onlineStore.profile_logo_url) {
            logoUrl = onlineStore.profile_logo_url;
          }
        }
      } catch (error) {
        console.warn('Could not fetch OnlineStore logo:', error);
      }
    }

    // Extract colors from logo if available
    // Logo URL might be relative (/uploads/logos/...) so we need to convert it to absolute URL or read the file
    if (logoUrl) {
      try {
        console.log(`Extracting brand colors from logo: ${logoUrl}`);
        
        // Convert relative URL to absolute URL or read file as buffer for color extraction
        let logoForColorExtraction = logoUrl;
        const fs = require('fs');
        const path = require('path');
        
        // If logoUrl is relative, try to read the file and convert to absolute URL
        if (logoUrl.startsWith('/uploads/') || logoUrl.startsWith('uploads/')) {
          const logoFilename = logoUrl.split('/').pop();
          const logoFilePath = path.join(__dirname, '..', 'uploads', 'logos', logoFilename);
          
          if (fs.existsSync(logoFilePath)) {
            // Read file as buffer for color extraction (Gemini can use buffer)
            logoForColorExtraction = fs.readFileSync(logoFilePath);
            console.log(`✅ Read logo file for color extraction: ${logoFilePath} (${fs.statSync(logoFilePath).size} bytes)`);
          } else {
            // Fallback: construct absolute URL
            const baseUrl = process.env.BASE_URL || process.env.API_URL || process.env.BACKEND_URL || 'http://backend.mycroshop.com';
            logoForColorExtraction = logoUrl.startsWith('http') ? logoUrl : `${baseUrl}${logoUrl}`;
            console.log(`⚠️ Logo file not found, using absolute URL for color extraction: ${logoForColorExtraction}`);
          }
        }
        
        const extractedColors = await extractColorsFromLogo(logoForColorExtraction);
        
        // Generate full color palette from extracted colors
        const fullPalette = await generateColorPalette(extractedColors);
        
        brandColors = {
          primary: fullPalette.primary || defaultBrandColors.primary,
          secondary: fullPalette.secondary || defaultBrandColors.secondary,
          accent: fullPalette.accent || defaultBrandColors.accent,
          text: fullPalette.text || defaultBrandColors.text,
          background: fullPalette.background || defaultBrandColors.background,
          border: fullPalette.border || defaultBrandColors.border,
          table_header: fullPalette.table_header || defaultBrandColors.table_header,
          table_row_alt: fullPalette.table_row_alt || defaultBrandColors.table_row_alt
        };
        
        console.log('✅ Successfully extracted brand colors from logo:', brandColors);
      } catch (error) {
        console.warn('⚠️ Failed to extract colors from logo, using defaults:', error.message);
        // Continue with default colors
      }
    } else {
      console.log('ℹ️ No logo found, using default brand colors');
    }

    // Generate templates using AI (or defaults if AI fails)
    console.log('Calling AI template generator with data:', {
      business_name: invoiceDataForAi.business_name,
      items_count: invoiceDataForAi.items_count,
      total_amount: invoiceDataForAi.total_amount,
      hasApiKey: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '')
    });
    
    const templates = await generateTemplateOptions(invoiceDataForAi, brandColors);
    
    console.log(`Received ${templates.length} templates from AI generator`);

    // Attach logo URL to invoice object for rendering
    // Safely convert invoice to JSON - handle null associations
    let invoiceJson = null;
    try {
      if (!invoice) {
        throw new Error('Invoice is null or undefined');
      }

      // Use Sequelize's toJSON method if available
      if (typeof invoice.toJSON === 'function') {
        invoiceJson = invoice.toJSON();
      } else {
        // Fallback: use invoice as-is if it's already a plain object
        invoiceJson = invoice;
      }
      
      // Ensure null associations are handled properly (Sequelize sets them to null when foreign key is null)
      if (invoiceJson.Customer === null || invoiceJson.Customer === undefined) {
        invoiceJson.Customer = null;
      }
      if (invoiceJson.Store === null || invoiceJson.Store === undefined) {
        invoiceJson.Store = null;
      }
      if (!Array.isArray(invoiceJson.InvoiceItems)) {
        invoiceJson.InvoiceItems = invoiceJson.InvoiceItems ? [invoiceJson.InvoiceItems] : [];
      }
    } catch (jsonError) {
      console.error('Error converting invoice to JSON in generateTemplatesForInvoice:', jsonError);
      console.error('Invoice object type:', typeof invoice);
      console.error('Invoice has toJSON:', typeof invoice?.toJSON);
      // Create a minimal safe invoice object
      invoiceJson = {
        id: invoice?.id || null,
        invoice_number: invoice?.invoice_number || null,
        customer_id: invoice?.customer_id || null,
        total: invoice?.total || 0,
        subtotal: invoice?.subtotal || 0,
        Customer: null,
        Store: null,
        InvoiceItems: []
      };
    }

    // Convert logo URL to absolute URL or base64 data URI for Puppeteer
    let logoDataUri = null;
    if (logoUrl) {
      try {
        const fs = require('fs');
        const path = require('path');
        
        // Extract filename from logo URL (e.g., /uploads/logos/logo.jpg -> logo.jpg)
        const logoFilename = logoUrl.split('/').pop();
        const logoFilePath = path.join(__dirname, '..', 'uploads', 'logos', logoFilename);
        
        // Check if file exists and read it as base64
        if (fs.existsSync(logoFilePath)) {
          const logoBuffer = fs.readFileSync(logoFilePath);
          const logoMimeType = logoUrl.endsWith('.png') ? 'image/png' :
                              logoUrl.endsWith('.jpg') || logoUrl.endsWith('.jpeg') ? 'image/jpeg' :
                              logoUrl.endsWith('.gif') ? 'image/gif' :
                              logoUrl.endsWith('.webp') ? 'image/webp' : 'image/png';
          
          logoDataUri = `data:${logoMimeType};base64,${logoBuffer.toString('base64')}`;
          console.log(`✅ Converted logo to base64 data URI (${logoBuffer.length} bytes)`);
        } else {
          // Fallback: try to construct absolute URL if file doesn't exist locally
          const baseUrl = process.env.BASE_URL || process.env.API_URL || 'http://backend.mycroshop.com';
          logoDataUri = logoUrl.startsWith('http') ? logoUrl : `${baseUrl}${logoUrl}`;
          console.log(`⚠️ Logo file not found at ${logoFilePath}, using absolute URL: ${logoDataUri}`);
        }
      } catch (logoError) {
        console.warn('Failed to convert logo to base64, using absolute URL:', logoError.message);
        // Fallback to absolute URL
        const baseUrl = process.env.BASE_URL || process.env.API_URL || 'http://backend.mycroshop.com';
        logoDataUri = logoUrl.startsWith('http') ? logoUrl : `${baseUrl}${logoUrl}`;
      }
    }

    const invoiceWithLogo = {
      ...invoiceJson,
      logoUrl: logoDataUri || logoUrl || null
    };

    console.log(`\n📄 Starting template rendering for ${templates.length} templates...`);
    const results = [];
    // Determine if this is a free plan user (needed for saving templates with tenant_id)
    const isFreePlan = tenant && tenant.subscription_plan === 'free';

    for (let i = 0; i < templates.length; i++) {
      const template = templates[i];
      console.log(`\n  Processing template ${i + 1}/${templates.length}: ${template.id || template.name || 'Unknown'}`);
      
      try {
        console.log(`    - Rendering HTML for template ${template.id}...`);
        // Use HTML template library instead of JSON recipe renderer
        const html = invoiceHtmlTemplates.getInvoiceTemplate(template.id, {
          invoice: invoiceWithLogo,
          customer: customer || {},
          store: store || {},
          items: items,
          logoUrl: logoDataUri || logoUrl || null,
          colors: brandColors
        });
        
        console.log(`    - HTML rendered (${html.length} chars). Generating PDF and preview...`);
        
        let pdfPath = null;
        let previewPath = null;
        let pdfUrl = null;
        let previewUrl = null;
        
        try {
          const result = await generateInvoicePdfAndPreview({
            html,
            invoiceId: invoice.id,
            templateId: template.id
          });
          
          pdfPath = result.pdfPath;
          previewPath = result.previewPath;
          
          console.log(`    - PDF generated: ${pdfPath}`);
          console.log(`    - Preview generated: ${previewPath}`);
          
          // Normalize file path to URL path
          // pdfPath/previewPath are absolute paths from generateInvoicePdfAndPreview:
          //   Windows: C:\Users\...\uploads\invoices\pdfs\file.pdf
          //   Linux: /home/user/.../uploads/invoices/pdfs/file.pdf
          // We need: /uploads/invoices/pdfs/file.pdf (relative to server root)
          // This will be accessible at: http://backend.mycroshop.com/uploads/invoices/pdfs/file.pdf
          const normalizePath = (localPath, fileType) => {
            if (!localPath) {
              console.warn(`normalizePath received empty path for ${fileType}`);
              return null;
            }
            
            // Convert to forward slashes for consistency (handle Windows paths)
            let normalized = String(localPath).replace(/\\/g, '/');
            console.log(`    - Normalizing ${fileType} path: ${localPath}`);
            console.log(`    - Normalized (forward slashes): ${normalized}`);
            
            // Method 1: Find '/uploads' in the path (most common case)
            const uploadsIndex = normalized.indexOf('/uploads');
            if (uploadsIndex !== -1) {
              const relativePath = normalized.substring(uploadsIndex);
              console.log(`    - ✅ Extracted path using '/uploads' method: ${relativePath}`);
              return relativePath;
            }
            
            // Method 2: Find 'uploads' (case-insensitive, works for Windows paths like C:\...\uploads\...)
            const normalizedLower = normalized.toLowerCase();
            const uploadsIndex2 = normalizedLower.indexOf('uploads');
            if (uploadsIndex2 !== -1) {
              // Extract from 'uploads' onwards
              const afterUploads = normalized.substring(uploadsIndex2);
              // Ensure it starts with '/uploads'
              const relativePath = afterUploads.startsWith('/') ? afterUploads : '/uploads' + afterUploads.substring(7);
              console.log(`    - ✅ Extracted path using 'uploads' method: ${relativePath}`);
              return relativePath;
            }
            
            // Method 3: Extract filename from path (last part after last slash)
            // Files are always named: invoice-{id}-{templateId}-{timestamp}.pdf or .png
            const pathParts = normalized.split('/').filter(p => p && p !== '.' && p !== '..'); // Remove empty, ., ..
            const filename = pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;
            
            if (filename) {
              // Construct URL based on file extension - this always works as fallback
              if (filename.endsWith('.pdf')) {
                const constructedPath = `/uploads/invoices/pdfs/${filename}`;
                console.log(`    - ✅ Method 3: Constructed PDF path from filename: ${constructedPath}`);
                return constructedPath;
              } else if (filename.match(/\.(png|jpg|jpeg)$/i)) {
                const constructedPath = `/uploads/invoices/previews/${filename}`;
                console.log(`    - ✅ Method 3: Constructed preview path from filename: ${constructedPath}`);
                return constructedPath;
              }
            }
            
            // Last resort: if we can't extract filename, log error
            console.error(`    ❌ Could not normalize ${fileType} path: ${localPath}`);
            console.error(`       Normalized: ${normalized}`);
            console.error(`       Filename extracted: ${filename || 'none'}`);
            console.error(`       Path parts: ${pathParts.join(' > ')}`);
            return null;
          };

          previewUrl = normalizePath(previewPath, 'preview');
          pdfUrl = normalizePath(pdfPath, 'PDF');
          
          console.log(`    - Preview URL result: ${previewUrl}`);
          console.log(`    - PDF URL result: ${pdfUrl}`);
          
          // Validate URLs were generated - if not, construct them from paths
          if (!previewUrl && previewPath) {
            // Fallback: extract filename and construct URL
            const previewFilename = previewPath.split(/[/\\]/).pop();
            previewUrl = `/uploads/invoices/previews/${previewFilename}`;
            console.log(`    - ⚠️ Preview URL was null, constructed fallback: ${previewUrl}`);
          }
          
          if (!pdfUrl && pdfPath) {
            // Fallback: extract filename and construct URL
            const pdfFilename = pdfPath.split(/[/\\]/).pop();
            pdfUrl = `/uploads/invoices/pdfs/${pdfFilename}`;
            console.log(`    - ⚠️ PDF URL was null, constructed fallback: ${pdfUrl}`);
          }
          
          // Final validation - if still null, throw error
          if (!previewUrl || !pdfUrl) {
            throw new Error(`Failed to generate URLs after all attempts - previewUrl: ${previewUrl}, pdfUrl: ${pdfUrl}, previewPath: ${previewPath}, pdfPath: ${pdfPath}`);
          }
          
          console.log(`    - ✅ Final Preview URL: ${previewUrl}`);
          console.log(`    - ✅ Final PDF URL: ${pdfUrl}`);
        } catch (pdfError) {
          console.error(`    ❌ Error generating PDF/preview for template ${template.id}:`, pdfError.message);
          console.error(`    PDF Error details:`, {
            message: pdfError.message,
            stack: pdfError.stack?.split('\n').slice(0, 5).join('\n'),
            pdfPath: pdfPath,
            previewPath: previewPath
          });
          // Re-throw to be caught by outer catch block
          throw pdfError;
        }

        // Save template to invoice_templates table using raw SQL
        // Note: We use raw SQL because there's no InvoiceTemplate Sequelize model
        try {
          const { QueryTypes } = require('sequelize');
          const templateDataJson = JSON.stringify(template);
          const templateName = template.name || template.id || `Template ${template.id}`;
          
          // Build query based on whether we're on free plan (needs tenant_id) or enterprise
          if (isFreePlan && tenantId) {
            await req.db.query(`
              INSERT INTO invoice_templates (
                tenant_id, invoice_id, template_id, template_name, template_data, preview_url, pdf_url, is_selected, created_at
              ) VALUES (
                :tenant_id, :invoice_id, :template_id, :template_name, :template_data, :preview_url, :pdf_url, :is_selected, NOW()
              )
              ON DUPLICATE KEY UPDATE
                template_data = :template_data_update,
                preview_url = :preview_url_update,
                pdf_url = :pdf_url_update
            `, {
              replacements: {
                tenant_id: tenantId,
                invoice_id: invoice.id,
                template_id: template.id,
                template_name: templateName,
                template_data: templateDataJson,
                preview_url: previewUrl,
                pdf_url: pdfUrl,
                is_selected: 0, // false
                template_data_update: templateDataJson,
                preview_url_update: previewUrl,
                pdf_url_update: pdfUrl
              },
              type: QueryTypes.INSERT
            });
          } else {
            // Enterprise users (no tenant_id)
            await req.db.query(`
              INSERT INTO invoice_templates (
                invoice_id, template_id, template_name, template_data, preview_url, pdf_url, is_selected, created_at
              ) VALUES (
                :invoice_id, :template_id, :template_name, :template_data, :preview_url, :pdf_url, :is_selected, NOW()
              )
              ON DUPLICATE KEY UPDATE
                template_data = :template_data_update,
                preview_url = :preview_url_update,
                pdf_url = :pdf_url_update
            `, {
              replacements: {
                invoice_id: invoice.id,
                template_id: template.id,
                template_name: templateName,
                template_data: templateDataJson,
                preview_url: previewUrl,
                pdf_url: pdfUrl,
                is_selected: 0, // false
                template_data_update: templateDataJson,
                preview_url_update: previewUrl,
                pdf_url_update: pdfUrl
              },
              type: QueryTypes.INSERT
            });
          }
          
          console.log(`    - Saved template ${template.id} to database`);
        } catch (saveError) {
          console.error(`    - Failed to save template ${template.id} to database:`, saveError.message);
          // Continue even if saving fails - templates are still returned to user
        }

        // Validate URLs are not null before adding to results
        if (!previewUrl || !pdfUrl) {
          console.error(`    ❌ Template ${template.id} has null URLs!`);
          console.error(`       previewUrl: ${previewUrl}`);
          console.error(`       pdfUrl: ${pdfUrl}`);
          console.error(`       previewPath: ${previewPath}`);
          console.error(`       pdfPath: ${pdfPath}`);
          throw new Error(`Failed to generate valid URLs for template ${template.id}`);
        }
        
        results.push({
          template,
          preview_url: previewUrl,
          pdf_url: pdfUrl
        });
        console.log(`    ✅ Template ${template.id} completed successfully with URLs:`);
        console.log(`       Preview URL: ${previewUrl}`);
        console.log(`       PDF URL: ${pdfUrl}`);
      } catch (templateError) {
        console.error(`    ❌ Error processing template ${template.id}:`, templateError.message);
        console.error(`    Template error details:`, {
          message: templateError.message,
          stack: templateError.stack?.split('\n').slice(0, 5).join('\n'),
          templateId: template.id,
          templateName: template.name
        });
        // RE-THROW error with full context - invoice should NOT be created if any template fails
        // Include original error details for debugging
        const enhancedError = new Error(`Failed to generate preview/PDF for template ${template.id}: ${templateError.message}`);
        enhancedError.originalError = templateError;
        enhancedError.templateId = template.id;
        enhancedError.stack = templateError.stack;
        throw enhancedError;
      }
    }

    console.log(`\n📊 Template rendering complete: ${results.length}/${templates.length} templates successfully processed`);
    
    // CRITICAL: All templates MUST have valid previews/PDFs
    // If we reach here, all templates in the loop succeeded (errors are re-thrown)
    // But we still validate that results match templates exactly
    if (results.length !== templates.length) {
      const errorMsg = `Preview/PDF generation incomplete: ${results.length} successful out of ${templates.length} templates`;
      console.error(`❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    // Validate that all results have valid URLs (should never happen if we reach here, but double-check)
    const invalidResults = results.filter(r => !r.preview_url || !r.pdf_url);
    if (invalidResults.length > 0) {
      const errorMsg = `Invalid previews generated: ${invalidResults.length} templates have null URLs`;
      console.error(`❌ ${errorMsg}`);
      console.error('Invalid results:', invalidResults.map(r => ({
        template_id: r.template.id,
        preview_url: r.preview_url,
        pdf_url: r.pdf_url
      })));
      throw new Error(errorMsg);
    }

    console.log(`✅ All ${results.length} templates have valid previews and PDFs`);

    return {
      templates: templates.map(t => ({
        ...t,
        generated_at: t.generated_at || new Date().toISOString()
      })),
      previews: results.map((r) => ({
        template_id: r.template.id,
        preview_url: r.preview_url,
        pdf_url: r.pdf_url
      }))
    };
  } catch (error) {
    console.error('\n❌ CRITICAL ERROR in generateTemplatesForInvoice:', error);
    console.error('Error message:', error.message);
    console.error('Error type:', error.name);
    console.error('Error stack:', error.stack?.split('\n').slice(0, 10).join('\n'));
    console.error('Invoice data:', {
      invoiceId: invoice?.id,
      hasItems: !!(invoice?.InvoiceItems && invoice.InvoiceItems.length > 0),
      itemsCount: invoice?.InvoiceItems?.length || 0
    });
    
    // Re-throw error with full details - invoice should NOT be created if templates/previews fail
    // Include the actual error message and stack for debugging
    const detailedError = new Error(`Template/preview generation failed: ${error.message}`);
    detailedError.originalError = error;
    detailedError.stack = error.stack;
    detailedError.details = {
      errorMessage: error.message,
      errorType: error.name,
      errorStack: error.stack?.split('\n').slice(0, 10).join('\n'),
      invoiceId: invoice?.id,
      invoiceItemsCount: invoice?.InvoiceItems?.length || 0
    };
    throw detailedError;
  }
}

/**
 * Generate AI-powered invoice templates, render previews and PDFs.
 * Backend-heavy Option 1:
 *  - AI returns JSON "recipes" (tokens + block variants)
 *  - Backend renders HTML, PDF, and preview images
 *  - Frontend receives template metadata + file URLs
 */
async function generateAiTemplatesForInvoice(req, res) {
  try {
    const invoice = await req.db.models.Invoice.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state', 'email', 'phone']
        },
        {
          model: req.db.models.Customer,
          required: false,
          attributes: ['id', 'name', 'email', 'phone', 'address', 'city', 'state', 'country']
        },
        {
          model: req.db.models.InvoiceItem
        }
      ]
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    const tenantId = req.user.tenantId;
    const templateData = await generateTemplatesForInvoice(invoice, tenantId, req);

    res.json({
      success: true,
      data: {
        invoice_id: invoice.id,
        ...templateData
      }
    });
  } catch (error) {
    console.error('Error generating AI invoice templates:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate AI invoice templates'
    });
  }
}

/**
 * Get invoice by ID
 */
async function getInvoiceById(req, res) {
  try {
    const invoice = await req.db.models.Invoice.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type', 'address', 'city', 'state']
        },
        {
          model: req.db.models.Customer,
          required: false,
          attributes: ['id', 'name', 'email', 'phone', 'address', 'city', 'state', 'country']
        },
        {
          model: req.db.models.InvoiceItem,
          include: [
            {
              model: req.db.models.Product,
              required: false,
              // Explicitly specify attributes - exclude store_id which doesn't exist in products table
              attributes: ['id', 'name', 'sku', 'description', 'price', 'category', 'image_url']
            }
          ]
        }
      ]
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    res.json({
      success: true,
      data: { invoice }
    });
  } catch (error) {
    console.error('Error getting invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get invoice'
    });
  }
}

/**
 * Create invoice (store-specific)
 */
async function createInvoice(req, res) {
  // Validate database and models are available
  if (!req.db) {
    return res.status(500).json({
      success: false,
      message: 'Database connection not available'
    });
  }

  if (!req.db.models) {
    return res.status(500).json({
      success: false,
      message: 'Database models not initialized'
    });
  }

  if (!req.db.models.Invoice) {
    return res.status(500).json({
      success: false,
      message: 'Invoice model not found. Please ensure models are properly initialized.'
    });
  }

  const transaction = await req.db.transaction();
  
  try {
    const {
      store_id,
      customer_id, // This is optional - can be null, undefined, or a valid integer
      issue_date,
      due_date,
      items,
      tax_rate = 0,
      discount_amount = 0,
      notes
    } = req.body;

    // Validate required fields
    if (!issue_date) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'issue_date is required'
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'At least one item is required'
      });
    }

    // Validate customer_id only if it's explicitly provided (not null/undefined/empty)
    // customer_id is optional, so null/undefined is valid
    let validCustomerId = null;
    if (customer_id !== undefined && customer_id !== null && customer_id !== '') {
      const parsedCustomerId = parseInt(customer_id);
      if (isNaN(parsedCustomerId) || parsedCustomerId < 1) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'customer_id must be a positive integer if provided',
          error_details: `Received customer_id: ${customer_id} (type: ${typeof customer_id})`
        });
      }

      // Verify customer exists if customer_id is provided
      try {
        const customer = await req.db.models.Customer.findByPk(parsedCustomerId);
        if (!customer) {
          await transaction.rollback();
          return res.status(404).json({
            success: false,
            message: `Customer with ID ${parsedCustomerId} not found`
          });
        }
        validCustomerId = parsedCustomerId;
      } catch (customerError) {
        await transaction.rollback();
        console.error('Error validating customer:', customerError);
        return res.status(500).json({
          success: false,
          message: 'Error validating customer',
          error: customerError.message,
          error_details: process.env.NODE_ENV === 'development' ? {
            stack: customerError.stack?.split('\n').slice(0, 5).join('\n'),
            customer_id: parsedCustomerId
          } : undefined
        });
      }
    }

    // Get tenant to check subscription plan
    const tenantId = req.user.tenantId;
    let tenant = null;
    try {
      tenant = await getTenantById(tenantId);
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // For free users, store_id is optional (they don't have physical stores)
    // For enterprise users, store_id is required
    if (tenant && tenant.subscription_plan === 'enterprise') {
      if (!store_id) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'store_id is required for enterprise users'
        });
      }

      // Verify store exists (only for enterprise users)
      const store = await req.db.models.Store.findByPk(store_id);
      if (!store) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Store not found'
        });
      }
    } else {
      // Free users: store_id is optional, set to null if not provided
      // They can create invoices without physical stores
      if (store_id) {
        // If store_id is provided, verify it exists (optional for free users)
        const store = await req.db.models.Store.findByPk(store_id);
        if (!store) {
          await transaction.rollback();
          return res.status(404).json({
            success: false,
            message: 'Store not found'
          });
        }
      }
    }

    // Calculate totals
    let subtotal = 0;
    const invoiceItems = [];

    for (const item of items) {
      const { 
        product_id, 
        bundle_id,
        item_name, 
        description, 
        quantity, 
        unit_price,
        original_price,
        discount_percentage = 0,
        discount_amount = 0
      } = item;
      
      // For free users: product_id should not be provided (basic invoicing only, no inventory connection)
      // For enterprise users: product_id is optional (can select from inventory or manual entry)
      if (tenant && tenant.subscription_plan === 'free' && product_id) {
        await transaction.rollback();
        return res.status(403).json({
          success: false,
          message: 'Free users cannot create invoices with inventory products. Please use manual item entry (item_name, unit_price) only.',
          upgrade_required: true,
          current_plan: 'free',
          required_plan: 'enterprise'
        });
      }

      // If product_id is provided, get product info (but use provided unit_price - flexible pricing)
      let product = null;
      if (product_id) {
        product = await req.db.models.Product.findByPk(product_id);
      }

      // If bundle_id is provided, get bundle info
      let bundle = null;
      if (bundle_id) {
        try {
          bundle = await req.db.models.ProductBundle.findByPk(bundle_id, {
            include: [
              {
                model: req.db.models.ProductBundleItem,
                include: [{ 
                  model: req.db.models.Product,
                  required: false,
                  attributes: ['id', 'name', 'sku', 'description', 'price', 'category']
                }]
              }
            ]
          });
        } catch (error) {
          console.warn('Bundle not found, treating as regular item:', error);
        }
      }

      // Calculate item total with discounts
      const basePrice = unit_price || (bundle ? bundle.bundle_price : 0);
      const originalPrice = original_price || basePrice;
      const itemSubtotal = quantity * basePrice;
      const calculatedDiscount = discount_amount || (itemSubtotal * (discount_percentage / 100));
      const itemTotal = itemSubtotal - calculatedDiscount;
      subtotal += itemTotal;

      invoiceItems.push({
        product_id: product_id || null,
        item_name: bundle ? bundle.name : (product ? product.name : item_name),
        description: description || (bundle ? bundle.description : (product ? product.description : null)),
        quantity,
        unit_price: basePrice,
        original_price: originalPrice,
        discount_percentage,
        discount_amount: calculatedDiscount,
        total: itemTotal,
        is_bundled: !!bundle_id,
        bundle_id: bundle_id || null,
        bundle_name: bundle ? bundle.name : null
      });
    }

    // Tenant already fetched above, reuse it
    let taxBreakdown = null;
    let calculatedTax = 0;
    let taxCalculationMethod = 'automatic';

    // Calculate taxes automatically if tenant country is set, otherwise use manual tax_rate
    if (tenant && tenant.country && tax_rate === 0) {
      // Automatic tax calculation based on country
      taxBreakdown = calculateTax({
        country: tenant.country,
        subtotal: subtotal,
        businessType: tenant.business_type || 'company',
        annualTurnover: tenant.annual_turnover ? parseFloat(tenant.annual_turnover) : null,
        totalFixedAssets: tenant.total_fixed_assets ? parseFloat(tenant.total_fixed_assets) : null
      });

      calculatedTax = taxBreakdown.total_tax;
      taxCalculationMethod = 'automatic';
    } else if (tax_rate > 0) {
      // Manual tax calculation
      calculatedTax = subtotal * (tax_rate / 100);
      taxCalculationMethod = 'manual';
      taxBreakdown = {
        vat: 0,
        development_levy: 0,
        total_tax: calculatedTax,
        tax_details: {
          message: 'Manual tax calculation',
          tax_rate: `${tax_rate}%`
        }
      };
    } else {
      // No tax
      calculatedTax = 0;
      taxCalculationMethod = 'manual';
      taxBreakdown = {
        vat: 0,
        development_levy: 0,
        total_tax: 0,
        tax_details: {
          message: 'No tax applied'
        }
      };
    }

    const total = subtotal + calculatedTax - discount_amount;

    // Create invoice
    const isFreePlan = tenant && tenant.subscription_plan === 'free';
    // Get currency and currency_symbol from request body
    const currency = req.body.currency || 'NGN';
    const currency_symbol = req.body.currency_symbol || (currency === 'USD' ? '$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'NGN' ? '₦' : '₦');
    
    const invoice = await req.db.models.Invoice.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      invoice_number: generateInvoiceNumber(),
      store_id: store_id || null, // null for free users without physical stores
      customer_id: validCustomerId, // Use validated customer_id (null if not provided)
      issue_date,
      due_date: due_date || null,
      currency: currency,
      currency_symbol: currency_symbol,
      subtotal,
      tax_amount: calculatedTax,
      vat_amount: taxBreakdown.vat || 0,
      development_levy_amount: taxBreakdown.development_levy || 0,
      other_tax_amount: taxBreakdown.other_tax || 0,
      tax_breakdown: taxBreakdown,
      discount_amount,
      total,
      tax_calculation_method: taxCalculationMethod,
      tax_rate: tax_rate || 0,
      status: 'draft',
      notes: notes || null
    }, { transaction });

    // Create invoice items
    const createdInvoiceItems = [];
    for (const item of invoiceItems) {
      const createdItem = await req.db.models.InvoiceItem.create({
        tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
        invoice_id: invoice.id,
        ...item
      }, { transaction });
      createdInvoiceItems.push(createdItem);
    }

    // CRITICAL: Generate templates BEFORE committing transaction
    // If template generation fails, rollback and return error (template generation is REQUIRED)
    console.log('Starting template generation (REQUIRED - invoice will not be created if this fails)...');
    
    // Prepare invoice data for template generation (using invoice we just created)
    // Convert to plain object with items for template generation
    let completeInvoiceForTemplates = null;
    try {
      // Fetch invoice with relations (within transaction) for template generation
      const invoiceWithRelations = await req.db.models.Invoice.findByPk(invoice.id, {
      include: [
        {
          model: req.db.models.Store,
            required: false,
            attributes: ['id', 'name', 'store_type', 'address', 'city', 'state', 'email', 'phone']
          },
          {
            model: req.db.models.Customer,
            required: false,
            // Explicitly specify attributes - only include columns that exist in the database table
            // Exclude zip_code and notes as they may not exist in all database schemas
            attributes: ['id', 'name', 'email', 'phone', 'address', 'city', 'state', 'country']
          }
        ],
        transaction // Use the same transaction
      });

      // Get invoice items (within transaction)
      // For free users, product_id is always null (manual items only), so Product include will be null anyway
      // Specify explicit Product attributes to avoid selecting non-existent columns like store_id
      const itemsForTemplates = await req.db.models.InvoiceItem.findAll({
        where: {
          invoice_id: invoice.id,
          ...(isFreePlan ? { tenant_id: tenantId } : {})
        },
          include: [
            {
            model: req.db.models.Product,
            required: false,
            // Explicitly specify attributes - exclude store_id which doesn't exist in products table
            attributes: ['id', 'name', 'sku', 'description', 'price', 'category', 'image_url']
          }
        ],
        order: [['id', 'ASC']],
        transaction // Use the same transaction
      });

      // Convert to plain object
      if (invoiceWithRelations) {
        completeInvoiceForTemplates = invoiceWithRelations.toJSON ? invoiceWithRelations.toJSON() : invoiceWithRelations;
      } else {
        completeInvoiceForTemplates = invoice.toJSON ? invoice.toJSON() : invoice;
      }
      
      // Add InvoiceItems to the invoice object
      completeInvoiceForTemplates.InvoiceItems = itemsForTemplates.map(item => {
        const plainItem = item.toJSON ? item.toJSON() : item;
        if (plainItem.Product && typeof plainItem.Product.toJSON === 'function') {
          plainItem.Product = plainItem.Product.toJSON();
        }
        return plainItem;
      });
      
      console.log(`✅ Prepared invoice data for template generation: ${completeInvoiceForTemplates.InvoiceItems.length} items`);
    } catch (fetchError) {
      console.error('Error preparing invoice data for template generation:', fetchError);
      await transaction.rollback();
      return res.status(500).json({
        success: false,
        message: 'Failed to prepare invoice data for template generation',
        error: fetchError.message
      });
    }

    // CRITICAL: Validate invoice has items before generating templates
    if (!completeInvoiceForTemplates || !completeInvoiceForTemplates.InvoiceItems || completeInvoiceForTemplates.InvoiceItems.length === 0) {
      await transaction.rollback();
      console.error('❌ Template generation failed: Invoice has no items');
      return res.status(400).json({
        success: false,
        message: 'Cannot create invoice: Invoice must have at least one item to generate templates',
        error: 'No items provided'
      });
    }
    
    // Generate templates (REQUIRED - invoice will not be created if this fails)
    let templateData = null;
    try {
      console.log(`Generating templates for invoice ${invoice.id} with ${completeInvoiceForTemplates.InvoiceItems.length} items...`);
      
      // Set timeout for template generation (30 seconds)
      const templatePromise = generateTemplatesForInvoice(completeInvoiceForTemplates, tenantId, req);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => {
          reject(new Error('Template generation timeout after 30 seconds'));
        }, 30000)
      );
      
      templateData = await Promise.race([templatePromise, timeoutPromise]);
      
      // Validate that templates were generated
      if (!templateData || !templateData.templates || !Array.isArray(templateData.templates) || templateData.templates.length === 0) {
        await transaction.rollback();
        console.error('❌ Template generation failed: No templates generated');
        return res.status(500).json({
          success: false,
          message: 'Failed to create invoice: Template generation returned no templates',
          error: 'Template generation failed - no templates returned',
          debug: {
            templateData: templateData,
            invoiceItemsCount: completeInvoiceForTemplates.InvoiceItems?.length || 0,
            hasApiKey: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '')
          }
        });
      }
      
      // CRITICAL: Validate that ALL templates have valid preview and PDF URLs
      // Invoice should NOT be created if preview/PDF generation failed
      if (!templateData.previews || !Array.isArray(templateData.previews) || templateData.previews.length === 0) {
        await transaction.rollback();
        console.error('❌ Preview/PDF generation failed: No previews generated');
        console.error('Template data received:', {
          hasTemplates: !!(templateData.templates && templateData.templates.length > 0),
          templatesCount: templateData.templates?.length || 0,
          hasPreviews: !!(templateData.previews && templateData.previews.length > 0),
          previewsCount: templateData.previews?.length || 0,
          hasError: !!templateData._error,
          errorMessage: templateData._error,
          isFallback: templateData._fallback
        });
        
        // If there's an error message in templateData, use it (fallback scenario)
        const actualError = templateData._error || 'Preview/PDF generation failed - all templates failed. This usually indicates a Puppeteer/PDF generation issue. Check server logs for details.';
        
        return res.status(500).json({
          success: false,
          message: 'Failed to create invoice: Preview/PDF generation failed - no previews generated',
          error: actualError,
          errorType: 'PreviewGenerationFailed',
          debug: {
            templatesCount: templateData.templates?.length || 0,
            previewsCount: templateData.previews?.length || 0,
            invoiceId: invoice.id,
            timestamp: new Date().toISOString(),
            isFallback: templateData._fallback || false,
            originalError: templateData._error || 'Unknown error - check server logs',
            fallbackError: templateData._fallbackError || undefined,
            note: templateData._note || undefined,
            possibleCauses: [
              'Puppeteer/Chrome not installed or misconfigured',
              'Missing system dependencies for PDF generation',
              'File system permission issues',
              'Insufficient memory/resources',
              'Path normalization failed'
            ]
          }
        });
      }
      
      // Validate that previews count matches templates count
      if (templateData.previews.length !== templateData.templates.length) {
        await transaction.rollback();
        console.error(`❌ Preview/PDF generation incomplete: ${templateData.previews.length} previews generated for ${templateData.templates.length} templates`);
        return res.status(500).json({
          success: false,
          message: 'Failed to create invoice: Preview/PDF generation incomplete',
          error: `Expected ${templateData.templates.length} previews but got ${templateData.previews.length}`,
          debug: {
            templatesCount: templateData.templates.length,
            previewsCount: templateData.previews.length,
            invoiceId: invoice.id,
            timestamp: new Date().toISOString()
          }
        });
      }
      
      // Validate that ALL previews have valid (non-null) preview_url and pdf_url
      const invalidPreviews = templateData.previews.filter(p => !p.preview_url || !p.pdf_url);
      if (invalidPreviews.length > 0) {
        await transaction.rollback();
        console.error(`❌ Preview/PDF generation failed: ${invalidPreviews.length} previews have null URLs`);
        console.error('Invalid previews:', invalidPreviews.map(p => ({
          template_id: p.template_id,
          preview_url: p.preview_url,
          pdf_url: p.pdf_url
        })));
        return res.status(500).json({
          success: false,
          message: 'Failed to create invoice: Preview/PDF generation failed - some previews have invalid URLs',
          error: `${invalidPreviews.length} out of ${templateData.previews.length} previews have null URLs`,
          debug: {
            templatesCount: templateData.templates.length,
            previewsCount: templateData.previews.length,
            invalidPreviewsCount: invalidPreviews.length,
            invalidTemplateIds: invalidPreviews.map(p => p.template_id),
            invoiceId: invoice.id,
            timestamp: new Date().toISOString()
          }
        });
      }
      
      console.log(`✅ Template generation successful: ${templateData.templates.length} templates generated`);
      console.log(`✅ Preview/PDF generation successful: ${templateData.previews.length} previews with valid URLs generated`);
      
    } catch (templateError) {
      await transaction.rollback();
      console.error('❌ Template generation failed - rolling back transaction:', templateError);
      console.error('Error details:', {
        message: templateError.message,
        name: templateError.name,
        stack: templateError.stack?.split('\n').slice(0, 10).join('\n'),
        originalError: templateError.originalError?.message,
        templateId: templateError.templateId,
        details: templateError.details
      });
      
      // Extract the actual error message - could be nested through multiple layers
      let actualError = templateError.message;
      let actualStack = templateError.stack;
      let rootError = templateError;
      
      // Unwrap nested errors to get to the root cause
      while (rootError.originalError) {
        rootError = rootError.originalError;
        actualError = rootError.message || actualError;
        actualStack = rootError.stack || actualStack;
      }
      
      // Build comprehensive error details for debugging
      const errorDetails = {
        errorMessage: actualError,
        errorType: rootError.name || templateError.name,
        errorStack: actualStack?.split('\n').slice(0, 20).join('\n'),
        templateId: templateError.templateId,
        invoiceId: invoice.id,
        invoiceItemsCount: completeInvoiceForTemplates?.InvoiceItems?.length || 0,
        hasApiKey: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== ''),
        timestamp: new Date().toISOString()
      };
      
      // If templateError has additional details, merge them
      if (templateError.details) {
        Object.assign(errorDetails, templateError.details);
      }
      
      // Include installation instructions if Chrome not found
      if (actualError.includes('Could not find Chrome') || actualError.includes('Chrome not found')) {
        errorDetails.installationInstructions = {
          quickFix: 'Run on server: npx puppeteer browsers install chrome',
          option1: 'Install Chrome via Puppeteer: cd /home/legithairng/public_html/backend.mycroshop.com && npx puppeteer browsers install chrome',
          option2: 'Install system Chromium (Debian/Ubuntu): sudo apt-get update && sudo apt-get install -y chromium-browser',
          option3: 'Install system Chromium (CentOS/RHEL): sudo yum install -y chromium',
          option4: 'Set custom path in .env file: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium',
          documentation: 'See PUPPETEER_CHROME_INSTALLATION.md for detailed instructions'
        };
        errorDetails.installationCommand = 'npx puppeteer browsers install chrome';
      }
      
      // Include original error details if available (from PDF service)
      if (rootError.installationCommand) {
        errorDetails.installationCommand = rootError.installationCommand;
      }
      if (rootError.installationInstructions) {
        errorDetails.installationInstructions = rootError.installationInstructions;
      }
      
      return res.status(500).json({
        success: false,
        message: 'Failed to create invoice: Template/preview generation failed',
        error: actualError,
        errorType: rootError.name || templateError.name,
        debug: errorDetails
      });
    }
    
    // Only commit transaction if template AND preview/PDF generation succeeded
    await transaction.commit();
    console.log(`✅ Invoice created successfully with ${createdInvoiceItems.length} invoice items, ${templateData.templates.length} templates, and ${templateData.previews.length} previews/PDFs`);

    // Fetch complete invoice with relations after transaction commit (for response)
    let completeInvoice = null;
    try {
      completeInvoice = await req.db.models.Invoice.findByPk(invoice.id, {
        include: [
          {
            model: req.db.models.Store,
            required: false,
            attributes: ['id', 'name', 'store_type', 'address', 'city', 'state', 'email', 'phone']
          },
          {
            model: req.db.models.Customer,
            required: false,
            // Explicitly specify attributes - only include columns that exist in the database table
            // Exclude zip_code and notes as they may not exist in all database schemas
            attributes: ['id', 'name', 'email', 'phone', 'address', 'city', 'state', 'country']
          }
        ]
      });

      // Fetch InvoiceItems separately (for free users, need tenant_id filter)
      const items = await req.db.models.InvoiceItem.findAll({
        where: {
          invoice_id: invoice.id,
          ...(isFreePlan ? { tenant_id: tenantId } : {})
        },
        include: [
          {
            model: req.db.models.Product,
            required: false,
            // Explicitly specify attributes - exclude store_id which doesn't exist in products table
            attributes: ['id', 'name', 'sku', 'description', 'price', 'category', 'image_url']
          }
        ],
        order: [['id', 'ASC']]
      });

      // Convert to plain object
      if (completeInvoice) {
        completeInvoice = completeInvoice.toJSON ? completeInvoice.toJSON() : completeInvoice;
      } else {
        completeInvoice = invoice.toJSON ? invoice.toJSON() : invoice;
      }
      
      // Add InvoiceItems
      completeInvoice.InvoiceItems = items.map(item => {
        const plainItem = item.toJSON ? item.toJSON() : item;
        if (plainItem.Product && typeof plainItem.Product.toJSON === 'function') {
          plainItem.Product = plainItem.Product.toJSON();
        }
        return plainItem;
      });
      
      console.log(`✅ Loaded complete invoice for response: ${completeInvoice.InvoiceItems.length} items`);
    } catch (fetchError) {
      console.error('Error fetching complete invoice for response:', fetchError);
      // Use invoice data we already have
      completeInvoice = invoice.toJSON ? invoice.toJSON() : invoice;
      completeInvoice.InvoiceItems = createdInvoiceItems.map(item => item.toJSON ? item.toJSON() : item);
      console.log(`Using created invoice data for response: ${completeInvoice.InvoiceItems.length} items`);
    }

    // Ensure we always send a complete response
    // Safely serialize invoice - handle null associations
    let safeInvoice = null;
    try {
      if (completeInvoice) {
        // Convert Sequelize instance to plain object and handle null associations
        safeInvoice = completeInvoice.toJSON ? completeInvoice.toJSON() : completeInvoice;
        
        // Ensure Customer and Store are handled properly if null
        if (!safeInvoice.Customer) {
          safeInvoice.Customer = null;
        }
        if (!safeInvoice.Store) {
          safeInvoice.Store = null;
        }
        // Ensure InvoiceItems is an array
        if (!Array.isArray(safeInvoice.InvoiceItems)) {
          safeInvoice.InvoiceItems = safeInvoice.InvoiceItems ? [safeInvoice.InvoiceItems] : [];
        }
      } else {
        // Fallback if completeInvoice is null/undefined
        safeInvoice = {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          status: invoice.status,
          total: invoice.total,
          Customer: null,
          Store: null,
          InvoiceItems: []
        };
      }
    } catch (serializeError) {
      console.error('Error serializing invoice:', serializeError);
      // Use basic invoice data if serialization fails
      safeInvoice = {
        id: invoice.id,
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        total: invoice.total
      };
    }

    try {
    res.status(201).json({
      success: true,
      message: 'Invoice created successfully',
        data: {
          invoice: safeInvoice,
          templates: templateData.templates || [],
          previews: templateData.previews || []
        }
      });
    } catch (responseError) {
      console.error('Error sending response:', responseError);
      console.error('Response error details:', {
        message: responseError.message,
        stack: responseError.stack?.split('\n').slice(0, 5).join('\n'),
        headersSent: res.headersSent
      });
      // If response not sent yet, try to send a minimal response
      if (!res.headersSent) {
        try {
          res.status(201).json({
            success: true,
            message: 'Invoice created successfully',
            data: {
              invoice: { 
                id: invoice.id, 
                invoice_number: invoice.invoice_number,
                customer_id: invoice.customer_id 
              },
              templates: [],
              previews: []
            }
          });
        } catch (finalError) {
          console.error('Failed to send minimal response:', finalError);
          // Last resort - send plain text
          if (!res.headersSent) {
            res.status(201).type('text/plain').send(`Invoice created: ${invoice.invoice_number}`);
          }
        }
      }
    }
  } catch (error) {
    await transaction.rollback();
    console.error('Error creating invoice:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      dbAvailable: !!req.db,
      modelsAvailable: !!req.db?.models,
      invoiceModelAvailable: !!req.db?.models?.Invoice,
      availableModels: req.db?.models ? Object.keys(req.db.models) : 'none'
    });
    res.status(500).json({
      success: false,
      message: 'Failed to create invoice',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Update invoice
 */
async function updateInvoice(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const invoice = await req.db.models.Invoice.findByPk(req.params.id);
    
    if (!invoice) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Cannot update paid or cancelled invoice'
      });
    }

    const {
      customer_id,
      issue_date,
      due_date,
      items,
      tax_rate = 0,
      discount_amount = 0,
      notes
    } = req.body;

    // If items are provided, recalculate totals
    if (items) {
      // Delete existing items
      await req.db.models.InvoiceItem.destroy({
        where: { invoice_id: invoice.id }
      }, { transaction });

      // Calculate new totals
      let subtotal = 0;
      const invoiceItems = [];

      for (const item of items) {
        const { product_id, item_name, description, quantity, unit_price } = item;
        
        let product = null;
        if (product_id) {
          product = await req.db.models.Product.findByPk(product_id);
        }

        const itemTotal = quantity * unit_price;
        subtotal += itemTotal;

        invoiceItems.push({
          product_id: product_id || null,
          item_name: product ? product.name : item_name,
          description: description || (product ? product.description : null),
          quantity,
          unit_price,
          total: itemTotal
        });
      }

      const taxAmount = subtotal * (tax_rate / 100);
      const total = subtotal + taxAmount - discount_amount;

      // Update invoice
      await invoice.update({
        ...(customer_id !== undefined && { customer_id }),
        ...(issue_date !== undefined && { issue_date }),
        ...(due_date !== undefined && { due_date }),
        subtotal,
        tax_amount: taxAmount,
        discount_amount,
        total,
        ...(notes !== undefined && { notes })
      }, { transaction });

      // Create new items
      for (const item of invoiceItems) {
        await req.db.models.InvoiceItem.create({
          invoice_id: invoice.id,
          ...item
        }, { transaction });
      }
    } else {
      // Update invoice fields only
      await invoice.update({
        ...(customer_id !== undefined && { customer_id }),
        ...(issue_date !== undefined && { issue_date }),
        ...(due_date !== undefined && { due_date }),
        ...(notes !== undefined && { notes })
      }, { transaction });
    }

    await transaction.commit();

    // Fetch updated invoice
    const updatedInvoice = await req.db.models.Invoice.findByPk(invoice.id, {
      include: [
        {
          model: req.db.models.Customer,
          required: false,
          attributes: ['id', 'name', 'email', 'phone', 'address', 'city', 'state', 'country']
        },
        {
          model: req.db.models.InvoiceItem,
          include: [
            {
              model: req.db.models.Product,
              required: false,
              // Explicitly specify attributes - exclude store_id which doesn't exist in products table
              attributes: ['id', 'name', 'sku', 'description', 'price', 'category', 'image_url']
            }
          ]
        }
      ]
    });

    res.json({
      success: true,
      message: 'Invoice updated successfully',
      data: { invoice: updatedInvoice }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update invoice'
    });
  }
}

/**
 * Update invoice status
 */
async function updateInvoiceStatus(req, res) {
  try {
    const { status, payment_method, payment_date } = req.body;
    
    const validStatuses = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const invoice = await req.db.models.Invoice.findByPk(req.params.id);
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    await invoice.update({
      status,
      ...(payment_method && { payment_method }),
      ...(payment_date && { payment_date })
    });

    res.json({
      success: true,
      message: 'Invoice status updated successfully',
      data: { invoice }
    });
  } catch (error) {
    console.error('Error updating invoice status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update invoice status'
    });
  }
}

/**
 * Delete invoice
 */
async function deleteInvoice(req, res) {
  try {
    const invoice = await req.db.models.Invoice.findByPk(req.params.id);
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete paid invoice'
      });
    }

    await invoice.destroy();

    res.json({
      success: true,
      message: 'Invoice deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete invoice'
    });
  }
}

module.exports = {
  getAllInvoices,
  getInvoiceById,
  createInvoice,
  updateInvoice,
  updateInvoiceStatus,
  deleteInvoice,
  generateAiTemplatesForInvoice
};

