const { Sequelize } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { calculateTax } = require('../services/taxCalculator');
const { getTenantById } = require('../config/tenant');

/**
 * Generate unique transaction number
 */
function generateTransactionNumber() {
  const prefix = 'POS';
  const timestamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Lookup product by barcode (for POS barcode scanning)
 * 
 * How it works:
 * 1. USB barcode scanner acts as HID keyboard
 * 2. Scanner types barcode + presses Enter
 * 3. Frontend receives input, calls this endpoint
 * 4. Backend searches:
 *    - Product barcode/SKU (main product)
 *    - Variation option barcode/SKU (product variants like "Blue Large T-Shirt")
 * 5. Returns product with variation context if found via variation
 * 
 * Frontend should:
 * - Auto-focus hidden input field
 * - Listen for Enter key after barcode input
 * - Call this endpoint with scanned barcode
 * - Add product to cart on success
 * - Clear input and refocus for next scan
 */
async function lookupProductByBarcode(req, res) {
  try {
    const { barcode, store_id } = req.query;

    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: 'Barcode is required'
      });
    }

    // Build product where clause - filter by store if specified
    const productWhere = {
      [Sequelize.Op.or]: [
        { barcode: barcode },
        { sku: barcode }
      ],
      is_active: true
    };

    // Filter by store if store_id is provided (for enterprise users with multiple stores)
    if (store_id) {
      productWhere.store_id = store_id;
    }

    // First try to find by product barcode/SKU
    let product = await req.db.models.Product.findOne({
      where: productWhere,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        },
        {
          model: req.db.models.ProductVariation,
          include: [
            {
              model: req.db.models.ProductVariationOption,
              where: { is_available: true },
              required: false
            }
          ],
          required: false
        }
      ],
      order: [
        [{ model: req.db.models.ProductVariation }, { model: req.db.models.ProductVariationOption }, 'sort_order', 'ASC']
      ]
    });

    // If not found, check variation options (each variation option can have its own barcode/SKU)
    if (!product) {
      const variationOption = await req.db.models.ProductVariationOption.findOne({
        where: {
          [Sequelize.Op.or]: [
            { barcode: barcode },
            { sku: barcode }
          ],
          is_available: true
        },
        include: [
          {
            model: req.db.models.ProductVariation,
            include: [
              {
                model: req.db.models.Product,
                where: { is_active: true },
                required: true,
                include: [
                  {
                    model: req.db.models.Store,
                    attributes: ['id', 'name']
                  }
                ]
              }
            ]
          }
        ]
      });

      if (variationOption && variationOption.ProductVariation && variationOption.ProductVariation.Product) {
        // Found via variation option - return product with variation info
        product = variationOption.ProductVariation.Product;
        
        // Filter by store if specified and product has store_id
        if (store_id && product.store_id && parseInt(product.store_id) !== parseInt(store_id)) {
          return res.status(404).json({
            success: false,
            message: 'Product not found in this store'
          });
        }

        // Calculate final price (base + variation adjustment)
        const basePrice = parseFloat(product.price) || 0;
        const priceAdjustment = parseFloat(variationOption.price_adjustment) || 0;
        const finalPrice = basePrice + priceAdjustment;

        // Add variation context to response
        return res.json({
          success: true,
          data: {
            product: {
              ...product.toJSON(),
              // Override price with final price for this variation
              price: finalPrice
            },
            variation_option: {
              id: variationOption.id,
              variation_id: variationOption.variation_id,
              variation_name: variationOption.ProductVariation.variation_name,
              variation_type: variationOption.ProductVariation.variation_type,
              option_value: variationOption.option_value,
              option_display_name: variationOption.option_display_name || variationOption.option_value,
              price_adjustment: variationOption.price_adjustment,
              base_price: basePrice,
              final_price: finalPrice,
              stock: variationOption.stock,
              sku: variationOption.sku,
              barcode: variationOption.barcode,
              image_url: variationOption.image_url,
              is_available: variationOption.is_available
            },
            scan_type: 'variation_option' // Indicates this was found via variation option
          }
        });
      }
    }

    // Filter by store if specified (for products found by main barcode/SKU)
    if (product && store_id && product.store_id && parseInt(product.store_id) !== parseInt(store_id)) {
      return res.status(404).json({
        success: false,
        message: 'Product not found in this store'
      });
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found. Please check the barcode or enter product manually.'
      });
    }

    // Check stock availability
    const productData = product.toJSON();
    const availableStock = productData.stock || 0;
    
    res.json({
      success: true,
      data: {
        product: productData,
        scan_type: 'product', // Indicates this was found via main product barcode/SKU
        available: availableStock > 0,
        stock_warning: availableStock <= 5 && availableStock > 0
      }
    });
  } catch (error) {
    console.error('Error looking up product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to lookup product'
    });
  }
}

/**
 * Create POS transaction
 */
async function createTransaction(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const {
      store_id,
      customer_id,
      items, // Array of { product_id, quantity, unit_price, discount_percentage, discount_amount }
      payment_method = 'cash',
      amount_paid,
      discount_amount = 0,
      notes
    } = req.body;

    if (!store_id || !items || !Array.isArray(items) || items.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'store_id and items are required'
      });
    }

    // Verify store exists
    const store = await req.db.models.Store.findByPk(store_id);
    if (!store) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    // Get tenant for tax calculation
    const tenantId = req.user.tenantId;
    let tenant = null;
    try {
      tenant = await getTenantById(tenantId);
    } catch (error) {
      console.warn('Could not fetch tenant for tax calculation:', error);
    }

    // Calculate totals
    let subtotal = 0;
    const transactionItems = [];

    for (const item of items) {
      const { product_id, quantity, unit_price, discount_percentage = 0, discount_amount: itemDiscount = 0 } = item;

      if (!product_id || !quantity || unit_price === undefined) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Each item must have product_id, quantity, and unit_price'
        });
      }

      // Get product info
      const product = await req.db.models.Product.findByPk(product_id);
      if (!product) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Product ${product_id} not found`
        });
      }

      // Check stock
      if (product.stock < quantity) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.stock}, Requested: ${quantity}`
        });
      }

      const itemSubtotal = quantity * unit_price;
      const calculatedDiscount = itemDiscount || (itemSubtotal * (discount_percentage / 100));
      const itemTotal = itemSubtotal - calculatedDiscount;
      subtotal += itemTotal;

      transactionItems.push({
        product_id,
        product_name: product.name,
        barcode: product.barcode || product.sku,
        quantity,
        unit_price,
        discount_percentage,
        discount_amount: calculatedDiscount,
        total: itemTotal
      });
    }

    // Calculate tax
    let taxBreakdown = null;
    let taxAmount = 0;
    if (tenant && tenant.country) {
      taxBreakdown = calculateTax({
        country: tenant.country,
        subtotal: subtotal,
        businessType: tenant.business_type || 'company',
        annualTurnover: tenant.annual_turnover ? parseFloat(tenant.annual_turnover) : null,
        totalFixedAssets: tenant.total_fixed_assets ? parseFloat(tenant.total_fixed_assets) : null
      });
      taxAmount = taxBreakdown.total_tax;
    }

    const total = subtotal + taxAmount - discount_amount;
    const changeAmount = amount_paid ? Math.max(0, amount_paid - total) : 0;

    // Create POS transaction
    const posTransaction = await req.db.models.POSTransaction.create({
      transaction_number: generateTransactionNumber(),
      store_id,
      staff_id: req.user.staffId || null,
      customer_id: customer_id || null,
      subtotal,
      tax_amount: taxAmount,
      discount_amount,
      total,
      payment_method,
      amount_paid: amount_paid || total,
      change_amount: changeAmount,
      status: 'completed',
      notes: notes || null
    }, { transaction });

    // Create transaction items
    for (const item of transactionItems) {
      await req.db.models.POSTransactionItem.create({
        transaction_id: posTransaction.id,
        ...item
      }, { transaction });

      // Update product stock
      const product = await req.db.models.Product.findByPk(item.product_id);
      await product.update({
        stock: product.stock - item.quantity
      }, { transaction });

      // Record stock movement
      await req.db.models.StockMovement.create({
        product_id: item.product_id,
        store_id,
        movement_type: 'sale',
        quantity: -item.quantity,
        reference_type: 'pos_transaction',
        reference_id: posTransaction.id,
        created_by: req.user.staffId || req.user.id
      }, { transaction });
    }

    await transaction.commit();

    // Fetch complete transaction
    const completeTransaction = await req.db.models.POSTransaction.findByPk(posTransaction.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'address', 'phone']
        },
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone']
        },
        {
          model: req.db.models.POSTransactionItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'barcode']
            }
          ]
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Transaction completed successfully',
      data: {
        transaction: completeTransaction,
        receipt: {
          transaction_number: completeTransaction.transaction_number,
          date: completeTransaction.created_at,
          items: completeTransaction.POSTransactionItems,
          subtotal: completeTransaction.subtotal,
          tax: completeTransaction.tax_amount,
          discount: completeTransaction.discount_amount,
          total: completeTransaction.total,
          payment_method: completeTransaction.payment_method,
          amount_paid: completeTransaction.amount_paid,
          change: completeTransaction.change_amount
        }
      }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error creating POS transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create transaction'
    });
  }
}

/**
 * Get all POS transactions
 */
async function getAllTransactions(req, res) {
  try {
    const { page = 1, limit = 50, store_id, staff_id, start_date, end_date, status } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (store_id) where.store_id = store_id;
    if (staff_id) where.staff_id = staff_id;
    if (status) where.status = status;
    if (start_date || end_date) {
      where.created_at = {};
      if (start_date) where.created_at[Sequelize.Op.gte] = start_date;
      if (end_date) where.created_at[Sequelize.Op.lte] = end_date;
    }

    const { count, rows } = await req.db.models.POSTransaction.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        },
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        transactions: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting transactions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get transactions'
    });
  }
}

/**
 * Get transaction by ID
 */
async function getTransactionById(req, res) {
  try {
    const transaction = await req.db.models.POSTransaction.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'address', 'phone']
        },
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name', 'email']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone']
        },
        {
          model: req.db.models.POSTransactionItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'barcode', 'sku']
            }
          ]
        }
      ]
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: { transaction }
    });
  } catch (error) {
    console.error('Error getting transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get transaction'
    });
  }
}

/**
 * Refund transaction
 */
async function refundTransaction(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const { reason } = req.body;
    const posTransaction = await req.db.models.POSTransaction.findByPk(req.params.id);

    if (!posTransaction) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    if (posTransaction.status === 'refunded') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Transaction already refunded'
      });
    }

    // Update transaction status
    await posTransaction.update({
      status: 'refunded'
    }, { transaction });

    // Get transaction items and restore stock
    const items = await req.db.models.POSTransactionItem.findAll({
      where: { transaction_id: posTransaction.id }
    });

    for (const item of items) {
      const product = await req.db.models.Product.findByPk(item.product_id);
      if (product) {
        await product.update({
          stock: product.stock + item.quantity
        }, { transaction });

        // Record stock movement
        await req.db.models.StockMovement.create({
          product_id: item.product_id,
          store_id: posTransaction.store_id,
          movement_type: 'return',
          quantity: item.quantity,
          reference_type: 'pos_transaction',
          reference_id: posTransaction.id,
          notes: `Refund: ${reason || 'No reason provided'}`,
          created_by: req.user.staffId || req.user.id
        }, { transaction });
      }
    }

    await transaction.commit();

    res.json({
      success: true,
      message: 'Transaction refunded successfully',
      data: { transaction: posTransaction }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error refunding transaction:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to refund transaction'
    });
  }
}

module.exports = {
  lookupProductByBarcode,
  createTransaction,
  getAllTransactions,
  getTransactionById,
  refundTransaction
};

