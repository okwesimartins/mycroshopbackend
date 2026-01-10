const { Sequelize } = require('sequelize');
const moment = require('moment');
const { calculateTax, getTaxInfo } = require('../services/taxCalculator');
const { getTenantById } = require('../config/tenant');
const { extractColorsFromLogo, generateColorPalette } = require('../services/colorExtractionService');
const { generateTemplateOptions } = require('../services/invoiceTemplateGenerator');
const { renderInvoiceHtml } = require('../services/invoiceHtmlRenderer');
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
          attributes: ['id', 'name', 'email', 'phone']
        },
        {
          model: req.db.models.InvoiceItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'sku']
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
    let tenant = null;
    try {
      tenant = await getTenantById(tenantId);
    } catch (error) {
      console.warn('Could not fetch tenant for AI templates:', error);
    }

    // Safely extract store and customer - they might be null if foreign keys are null
    const store = (invoice && invoice.Store) ? invoice.Store : {};
    const customer = (invoice && invoice.Customer) ? invoice.Customer : {};
    const items = (invoice && invoice.InvoiceItems) ? invoice.InvoiceItems : [];

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
    if (logoUrl) {
      try {
        console.log(`Extracting brand colors from logo: ${logoUrl}`);
        const extractedColors = await extractColorsFromLogo(logoUrl);
        
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
        
        console.log('Successfully extracted brand colors from logo:', brandColors);
      } catch (error) {
        console.warn('Failed to extract colors from logo, using defaults:', error.message);
        // Continue with default colors
      }
    } else {
      console.log('No logo found, using default brand colors');
    }

    const templates = await generateTemplateOptions(invoiceDataForAi, brandColors);

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

    const invoiceWithLogo = {
      ...invoiceJson,
      logoUrl: logoUrl || null
    };

    const results = [];
    // Determine if this is a free plan user (needed for saving templates with tenant_id)
    const isFreePlan = tenant && tenant.subscription_plan === 'free';

    for (const template of templates) {
      const html = renderInvoiceHtml({
        invoice: invoiceWithLogo,
        template,
        brandColors
      });

      const { pdfPath, previewPath } = await generateInvoicePdfAndPreview({
        html,
        invoiceId: invoice.id,
        templateId: template.id
      });

      const normalizePath = (localPath) =>
        '/uploads' + localPath.split('/uploads').pop().replace(/\\/g, '/');

      const previewUrl = normalizePath(previewPath);
      const pdfUrl = normalizePath(pdfPath);

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
              tenant_id, invoice_id, template_id, template_name, template_data, preview_url, is_selected, created_at
            ) VALUES (
              :tenant_id, :invoice_id, :template_id, :template_name, :template_data, :preview_url, :is_selected, NOW()
            )
            ON DUPLICATE KEY UPDATE
              template_data = :template_data_update,
              preview_url = :preview_url_update
          `, {
            replacements: {
              tenant_id: tenantId,
              invoice_id: invoice.id,
              template_id: template.id,
              template_name: templateName,
              template_data: templateDataJson,
              preview_url: previewUrl,
              is_selected: 0, // false
              template_data_update: templateDataJson,
              preview_url_update: previewUrl
            },
            type: QueryTypes.INSERT
          });
        } else {
          // Enterprise users (no tenant_id)
          await req.db.query(`
            INSERT INTO invoice_templates (
              invoice_id, template_id, template_name, template_data, preview_url, is_selected, created_at
            ) VALUES (
              :invoice_id, :template_id, :template_name, :template_data, :preview_url, :is_selected, NOW()
            )
            ON DUPLICATE KEY UPDATE
              template_data = :template_data_update,
              preview_url = :preview_url_update
          `, {
            replacements: {
              invoice_id: invoice.id,
              template_id: template.id,
              template_name: templateName,
              template_data: templateDataJson,
              preview_url: previewUrl,
              is_selected: 0, // false
              template_data_update: templateDataJson,
              preview_url_update: previewUrl
            },
            type: QueryTypes.INSERT
          });
        }
        
        console.log(`Saved template ${template.id} to database for invoice ${invoice.id}`);
      } catch (saveError) {
        console.error(`Failed to save template ${template.id} to database:`, saveError.message);
        console.error('Save template error details:', {
          message: saveError.message,
          stack: saveError.stack?.split('\n').slice(0, 3).join('\n'),
          invoiceId: invoice.id,
          templateId: template.id,
          isFreePlan: isFreePlan,
          tenantId: tenantId
        });
        // Continue even if saving fails - templates are still returned to user
      }

      results.push({
        template,
        preview_url: previewUrl,
        pdf_url: pdfUrl
      });
    }

    return {
      templates: results.map((r) => r.template),
      previews: results.map((r) => ({
        template_id: r.template.id,
        preview_url: r.preview_url,
        pdf_url: r.pdf_url
      }))
    };
  } catch (error) {
    console.error('Error generating templates:', error);
    // Return empty templates on error (don't fail the whole request)
    return {
      templates: [],
      previews: []
    };
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
          model: req.db.models.Customer
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
          model: req.db.models.Customer
        },
        {
          model: req.db.models.InvoiceItem,
          include: [
            {
              model: req.db.models.Product
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
                include: [{ model: req.db.models.Product }]
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
    const invoice = await req.db.models.Invoice.create({
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      invoice_number: generateInvoiceNumber(),
      store_id: store_id || null, // null for free users without physical stores
      customer_id: validCustomerId, // Use validated customer_id (null if not provided)
      issue_date,
      due_date: due_date || null,
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

    await transaction.commit();
    console.log(`Invoice created successfully with ${createdInvoiceItems.length} invoice items`);

    // Fetch complete invoice with relations after transaction commit
    // For free users, we need to fetch InvoiceItems separately with tenant_id filter
    // For enterprise users, we can use includes normally
    let completeInvoice = null;
    try {
      // First, fetch invoice with Store and Customer (these don't need tenant_id filter)
      completeInvoice = await req.db.models.Invoice.findByPk(invoice.id, {
        include: [
          {
            model: req.db.models.Store,
            required: false, // Store is optional for free users
            attributes: ['id', 'name', 'store_type', 'address', 'city', 'state', 'email', 'phone']
          },
          {
            model: req.db.models.Customer,
            required: false // Customer is optional - can be null when customer_id is null
          }
        ]
      });

      // Always fetch InvoiceItems separately for free users (need tenant_id filter)
      // For enterprise users, we could include them, but fetching separately is safer
      const items = await req.db.models.InvoiceItem.findAll({
        where: {
          invoice_id: invoice.id,
          ...(isFreePlan ? { tenant_id: tenantId } : {})
        },
        include: [
          {
            model: req.db.models.Product,
            required: false // Product is optional (manual items don't have products)
          }
        ],
        order: [['id', 'ASC']] // Ensure consistent ordering
      });

      // Convert invoice to plain object and add items
      if (completeInvoice) {
        completeInvoice = completeInvoice.toJSON ? completeInvoice.toJSON() : completeInvoice;
        completeInvoice.InvoiceItems = items.map(item => item.toJSON ? item.toJSON() : item);
        console.log(`Loaded complete invoice with ${completeInvoice.InvoiceItems.length} items`);
      } else {
        // Fallback: use invoice we just created
        completeInvoice = invoice.toJSON ? invoice.toJSON() : invoice;
        completeInvoice.InvoiceItems = items.map(item => item.toJSON ? item.toJSON() : item);
        console.log(`Using created invoice with ${completeInvoice.InvoiceItems.length} items as fallback`);
      }
    } catch (fetchError) {
      console.error('Error fetching complete invoice:', fetchError);
      console.error('Fetch error details:', {
        message: fetchError.message,
        stack: fetchError.stack?.split('\n').slice(0, 5).join('\n'),
        invoiceId: invoice.id,
        tenantId: isFreePlan ? tenantId : null
      });
      // Use the invoice we just created as fallback with items from createdInvoiceItems
      completeInvoice = invoice.toJSON ? invoice.toJSON() : invoice;
      completeInvoice.InvoiceItems = createdInvoiceItems.map(item => item.toJSON ? item.toJSON() : item);
      console.log(`Using created invoice with ${completeInvoice.InvoiceItems.length} items as fallback after error`);
    }

    // Generate AI templates automatically (non-blocking - if it fails, still return invoice)
    let templateData = { templates: [], previews: [] };
    try {
      // Only generate templates if we have a valid invoice object
      if (completeInvoice && completeInvoice.id) {
        // Set a timeout for template generation to prevent hanging
        const templatePromise = generateTemplatesForInvoice(completeInvoice, tenantId, req);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Template generation timeout')), 30000)
        );
        
        templateData = await Promise.race([templatePromise, timeoutPromise]);
      }
    } catch (error) {
      console.error('Failed to generate templates during invoice creation:', error);
      console.error('Template generation error details:', {
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        invoiceId: completeInvoice?.id,
        hasCustomer: !!completeInvoice?.Customer,
        customerId: completeInvoice?.customer_id
      });
      // Continue without templates - invoice creation was successful
      templateData = { templates: [], previews: [] };
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
          safeInvoice.Customer = null; // Explicitly set to null instead of undefined
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
          model: req.db.models.Customer
        },
        {
          model: req.db.models.InvoiceItem,
          include: [
            {
              model: req.db.models.Product
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

