const { Sequelize } = require('sequelize');
const fs = require('fs');
const path = require('path');

/**
 * Helper function to get full URL from relative path
 */
function getFullUrl(req, relativePath) {
  if (!relativePath) return null;
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
    return relativePath;
  }
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}${relativePath}`;
}

/**
 * Get all products (store-specific or all stores)
 */
async function getAllProducts(req, res) {
  try {
    const { page = 1, limit = 50, search, category, isActive, store_id, all_stores } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    
    // Filter by store if store_id provided, unless all_stores is true
    if (store_id && all_stores !== 'true') {
      where.store_id = store_id;
    }
    
    if (search) {
      where[Sequelize.Op.or] = [
        { name: { [Sequelize.Op.like]: `%${search}%` } },
        { sku: { [Sequelize.Op.like]: `%${search}%` } }
      ];
    }
    if (category) {
      where.category = category;
    }
    if (isActive !== undefined) {
      where.is_active = isActive === 'true';
    }

    const { count, rows } = await req.db.models.Product.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type']
        },
        {
          model: req.db.models.ProductVariation,
          include: [
            {
              model: req.db.models.ProductVariationOption
            }
          ],
          required: false
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        products: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get products'
    });
  }
}

/**
 * Get product by ID
 */
async function getProductById(req, res) {
  try {
    const product = await req.db.models.Product.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type']
        },
        {
          model: req.db.models.Store,
          as: 'Stores', // Products in multiple stores via ProductStore
          through: { attributes: ['stock', 'price_override'] }
        }
      ]
    });
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.json({
      success: true,
      data: { product }
    });
  } catch (error) {
    console.error('Error getting product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product'
    });
  }
}

/**
 * Add product to additional stores
 */
async function addProductToStores(req, res) {
  try {
    const { product_id } = req.params;
    const { store_ids } = req.body; // Array of store IDs

    if (!Array.isArray(store_ids) || store_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'store_ids must be a non-empty array'
      });
    }

    const product = await req.db.models.Product.findByPk(product_id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const added = [];
    const skipped = [];

    for (const store_id of store_ids) {
      // Check if store exists
      const store = await req.db.models.Store.findByPk(store_id);
      if (!store) {
        skipped.push({ store_id, reason: 'Store not found' });
        continue;
      }

      // Check if already in store
      const existing = await req.db.models.ProductStore.findOne({
        where: { product_id, store_id }
      });

      if (existing) {
        skipped.push({ store_id, reason: 'Product already in store' });
        continue;
      }

      // Get tenant to check subscription plan
      const tenantId = req.user?.tenantId;
      const { getTenantById } = require('../config/tenant');
      let tenant = null;
      let isFreePlan = false;
      try {
        tenant = await getTenantById(tenantId);
        isFreePlan = tenant && tenant.subscription_plan === 'free';
      } catch (error) {
        console.warn('Could not fetch tenant:', error);
      }

      // Add to store
      await req.db.models.ProductStore.create({
        tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
        product_id,
        store_id,
        stock: product.stock || 0
      });

      added.push(store_id);
    }

    res.json({
      success: true,
      message: `Product added to ${added.length} store(s)`,
      data: {
        added,
        skipped
      }
    });
  } catch (error) {
    console.error('Error adding product to stores:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add product to stores'
    });
  }
}

/**
 * Remove product from store
 */
async function removeProductFromStore(req, res) {
  try {
    const { product_id, store_id } = req.params;

    const productStore = await req.db.models.ProductStore.findOne({
      where: { product_id, store_id }
    });

    if (!productStore) {
      return res.status(404).json({
        success: false,
        message: 'Product not found in store'
      });
    }

    // Don't remove if it's the primary store (store_id in products table)
    const product = await req.db.models.Product.findByPk(product_id);
    if (product && product.store_id === parseInt(store_id)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove product from its primary store. Update the product instead.'
      });
    }

    await productStore.destroy();

    res.json({
      success: true,
      message: 'Product removed from store successfully'
    });
  } catch (error) {
    console.error('Error removing product from store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove product from store'
    });
  }
}

/**
 * Create product (store-specific)
 */
async function createProduct(req, res) {
  try {
    const {
      store_id, 
      name, 
      sku, 
      barcode,
      description, 
      price, 
      cost, 
      stock, 
      low_stock_threshold, 
      category, 
      image_url,
      expiry_date,
      batch_number,
      unit_of_measure = 'piece',
      add_to_stores, // Array of store IDs to also add this product to
      variations // Array of variation objects: [{variation_name, variation_type, is_required, options: [{value, display_name, price_adjustment, stock, sku, barcode, image_url, is_default}]}]
    } = req.body;

    // Get tenant to check subscription plan
    const tenantId = req.user?.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // Restrict inventory endpoint to enterprise users only
    // Free users should use POST /api/v1/online-stores/:id/products to create products directly for their online store
    if (isFreePlan) {
      return res.status(400).json({
        success: false,
        message: 'This endpoint is for enterprise users only. Free users should use POST /api/v1/online-stores/:id/products to create products directly for their online store.'
      });
    }

    // For enterprise users: store_id is required on products table
    if (!store_id) {
      return res.status(400).json({
        success: false,
        message: 'store_id is required'
      });
    }

    // Verify store exists
    const store = await req.db.models.Store.findByPk(store_id);
    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    // Handle product image: prioritize uploaded file over image_url
    let finalImageUrl = image_url || null;
    
    // Check for product_image in req.files (when using .any()) or req.file (when using .single())
    if (req.files && Array.isArray(req.files)) {
      const productImageFile = req.files.find(file => file.fieldname === 'product_image');
      if (productImageFile) {
        finalImageUrl = `/uploads/products/${productImageFile.filename}`;
      }
    } else if (req.file && req.file.fieldname === 'product_image') {
      // Fallback for .single() multer
      finalImageUrl = `/uploads/products/${req.file.filename}`;
    }

    // Determine final stock and price values: null if variations exist (they manage their own values)
    // This check happens before validation to ensure proper handling
    let finalStock = null;
    let finalPrice = null;
    if (variations) {
      let parsedVariations = [];
      if (typeof variations === 'string') {
        try {
          parsedVariations = JSON.parse(variations);
        } catch (parseError) {
          // Will be handled in validation below
        }
      } else if (Array.isArray(variations)) {
        parsedVariations = variations;
      }
      
      // If variations exist with options, stock and price should be null
      const hasVariationOptions = Array.isArray(parsedVariations) && parsedVariations.length > 0 &&
        parsedVariations.some(v => v.options && Array.isArray(v.options) && v.options.length > 0);
      
      if (hasVariationOptions) {
        finalStock = null; // Variations manage their own stock
        finalPrice = null; // Variations manage their own price
      } else {
        // No variations or no options, use provided values (defaults)
        finalStock = stock !== undefined && stock !== null ? stock : 0;
        finalPrice = price !== undefined && price !== null ? price : 0;
      }
    } else {
      // No variations provided, use values normally
      finalStock = stock !== undefined && stock !== null ? stock : 0;
      finalPrice = price !== undefined && price !== null ? price : 0;
    }

    const product = await req.db.models.Product.create({
      tenant_id: null, // Enterprise users don't need tenant_id (separate DB)
      store_id: store_id, // Required for enterprise users
      name,
      sku: sku || null,
      barcode: barcode || null,
      description: description || null,
      price: finalPrice, // null if variations exist, otherwise price value
      cost: cost || 0,
      stock: finalStock, // null if variations exist, otherwise stock value
      low_stock_threshold: low_stock_threshold || 10,
      category: category || null,
      image_url: finalImageUrl,
      expiry_date: expiry_date || null,
      batch_number: batch_number || null,
      unit_of_measure: unit_of_measure || 'piece',
      is_active: true
    });

    // Enterprise users: Add product to additional stores if add_to_stores is provided
    if (add_to_stores && Array.isArray(add_to_stores)) {
      for (const additionalStoreId of add_to_stores) {
        if (additionalStoreId !== store_id) {
          // Check if store exists
          const additionalStore = await req.db.models.Store.findByPk(additionalStoreId);
          if (additionalStore) {
            // Check if already exists
            const existing = await req.db.models.ProductStore.findOne({
              where: { product_id: product.id, store_id: additionalStoreId }
            });
            
            if (!existing) {
              await req.db.models.ProductStore.create({
                tenant_id: null, // Enterprise users don't need tenant_id
                product_id: product.id,
                store_id: additionalStoreId,
                stock: stock || 0
              });
            }
          }
        }
      }
    }

    // Handle product variations if provided (for enterprise users)
    if (variations) {
      let parsedVariations = [];
      
      // Parse variations if it's a string (from form-data)
      if (typeof variations === 'string') {
        try {
          parsedVariations = JSON.parse(variations);
        } catch (parseError) {
          console.error('Error parsing variations JSON:', parseError);
          // Don't fail the entire request, just log and continue without variations
        }
      } else if (Array.isArray(variations)) {
        parsedVariations = variations;
      }

      // Validate: If product has variations, primary stock and price must not be provided
      // Variations have their own stock and price levels, so primary product values don't make sense
      if (Array.isArray(parsedVariations) && parsedVariations.length > 0) {
        // Check if any variation has options
        const hasVariationOptions = parsedVariations.some(v => 
          v.options && Array.isArray(v.options) && v.options.length > 0
        );
        
        if (hasVariationOptions) {
          const errors = [];
          
          // Check for primary stock
          if (stock !== undefined && stock !== null && stock !== '') {
            errors.push('stock');
          }
          
          // Check for primary price
          if (price !== undefined && price !== null && price !== '') {
            errors.push('price');
          }
          
          if (errors.length > 0) {
            // Clean up uploaded files if any
            if (req.file && fs.existsSync(req.file.path)) {
              fs.unlinkSync(req.file.path);
            }
            // Clean up uploaded variation option images if any
            if (req.files) {
              const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
              files.forEach(file => {
                if (fs.existsSync(file.path)) {
                  fs.unlinkSync(file.path);
                }
              });
            }
            
            const fieldNames = errors.join(' and ');
            return res.status(400).json({
              success: false,
              message: `Products with variations cannot have primary ${fieldNames}. Each variation option manages its own ${fieldNames} level.`,
              suggestion: `Remove the "${errors.join('" and "')}" parameter(s) from your request. ${errors.map(e => e.charAt(0).toUpperCase() + e.slice(1))} should only be specified in the variation options (e.g., options[0].${errors[0]}).`
            });
          }
        }
      }

      // Validate: Only ONE variation type per product allowed (keep it simple!)
      if (Array.isArray(parsedVariations) && parsedVariations.length > 1) {
        // Clean up uploaded files if any
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        // Clean up uploaded variation option images if any
        if (req.files) {
          const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
          files.forEach(file => {
            if (fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
          });
        }
        
        return res.status(400).json({
          success: false,
          message: 'A product can only have ONE variation type. Please choose either Color, Size, Material, etc., but not multiple types together.',
          suggestion: 'If you need multiple variations (e.g., Color + Size), create separate products like "T-Shirt - Red" (with sizes) and "T-Shirt - Blue" (with sizes).'
        });
      }

      // Create variations and options
      if (Array.isArray(parsedVariations) && parsedVariations.length > 0) {
        for (let i = 0; i < parsedVariations.length; i++) {
          const variationData = parsedVariations[i];
          if (!variationData.variation_name || !variationData.variation_type) {
            continue; // Skip invalid variations
          }

          const variation = await req.db.models.ProductVariation.create({
            tenant_id: null, // Enterprise users don't need tenant_id
            product_id: product.id,
            variation_name: variationData.variation_name,
            variation_type: variationData.variation_type || 'other',
            is_required: variationData.is_required || false,
            sort_order: variationData.sort_order !== undefined ? parseInt(variationData.sort_order) : i
          });

          // Create variation options
          if (variationData.options && Array.isArray(variationData.options)) {
            for (let j = 0; j < variationData.options.length; j++) {
              const optionData = variationData.options[j];
              if (!optionData.value) {
                continue; // Skip invalid options
              }

              // Handle image: prioritize uploaded file over image_url
              let variationImageUrl = optionData.image_url || null;
              const variationImageFieldName = `variation_option_image_${i}_${j}`;
              
              // Check if file was uploaded for this variation option
              if (req.files) {
                // Handle both single file and multiple files
                const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
                const uploadedFile = files.find(file => 
                  file.fieldname === variationImageFieldName || 
                  file.fieldname.startsWith(`variation_option_image_${i}_${j}`)
                );
                
                if (uploadedFile) {
                  variationImageUrl = `/uploads/product-variations/${uploadedFile.filename}`;
                }
              }

              // Calculate price: Use direct price if provided, otherwise calculate from base price + adjustment
              let finalPrice = product.price;
              if (optionData.price !== undefined && optionData.price !== null) {
                // Direct price provided - use it
                finalPrice = parseFloat(optionData.price);
              } else if (optionData.price_adjustment !== undefined && optionData.price_adjustment !== null) {
                // Price adjustment provided - add to base price
                finalPrice = parseFloat(product.price) + parseFloat(optionData.price_adjustment || 0);
              }
              // If neither provided, use base product price

              await req.db.models.ProductVariationOption.create({
                tenant_id: null, // Enterprise users don't need tenant_id
                variation_id: variation.id,
                option_value: optionData.value,
                option_display_name: optionData.display_name || optionData.value,
                price_adjustment: finalPrice - parseFloat(product.price), // Store as adjustment for backward compatibility
                stock: parseInt(optionData.stock) || 0,
                sku: optionData.sku || null,
                barcode: optionData.barcode || null,
                image_url: variationImageUrl,
                is_default: optionData.is_default || false,
                is_available: optionData.is_available !== false,
                sort_order: optionData.sort_order !== undefined ? parseInt(optionData.sort_order) : j
              });
            }
          }
        }
      }
    }

    const completeProduct = await req.db.models.Product.findByPk(product.id, {
      include: [
        {
          model: req.db.models.Store
        },
        {
          model: req.db.models.ProductVariation,
          include: [
            {
              model: req.db.models.ProductVariationOption
            }
          ],
          required: false
        }
      ]
    });

    // Convert image_url to full URL if it's a relative path
    const productData = completeProduct.toJSON();
    if (productData.image_url && productData.image_url.startsWith('/uploads/')) {
      productData.image_url = getFullUrl(req, productData.image_url);
    }

    // Convert variation option image URLs to full URLs
    if (productData.ProductVariations) {
      productData.ProductVariations = productData.ProductVariations.map(variation => {
        if (variation.ProductVariationOptions) {
          variation.ProductVariationOptions = variation.ProductVariationOptions.map(option => {
            if (option.image_url && option.image_url.startsWith('/uploads/')) {
              option.image_url = getFullUrl(req, option.image_url);
            }
            return option;
          });
        }
        return variation;
      });
    }

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: { product: productData }
    });
  } catch (error) {
    console.error('Error creating product:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        success: false,
        message: 'SKU already exists'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to create product'
    });
  }
}

/**
 * Update product
 */
async function updateProduct(req, res) {
  try {
    const product = await req.db.models.Product.findByPk(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const { name, sku, description, price, cost, stock, low_stock_threshold, category, image_url, is_active, variations } = req.body;

    // Handle product image: prioritize uploaded file over image_url
    let finalImageUrl = image_url;
    if (req.file) {
      // File was uploaded via multer
      finalImageUrl = `/uploads/products/${req.file.filename}`;
      // Delete old image if exists
      if (product.image_url && product.image_url.startsWith('/uploads/products/')) {
        const oldImagePath = path.join(__dirname, '..', product.image_url);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
    }

    // Handle stock and price: set to null if variations are being added/updated
    let finalStock = stock;
    let finalPrice = price;
    if (variations !== undefined) {
      if (variations) {
        let parsedVariations = [];
        if (typeof variations === 'string') {
          try {
            parsedVariations = JSON.parse(variations);
          } catch (parseError) {
            // Already handled above
          }
        } else if (Array.isArray(variations)) {
          parsedVariations = variations;
        }
        
        // If variations exist with options, stock and price should be null
        const hasVariationOptions = Array.isArray(parsedVariations) && parsedVariations.length > 0 &&
          parsedVariations.some(v => v.options && Array.isArray(v.options) && v.options.length > 0);
        
        if (hasVariationOptions) {
          finalStock = null; // Variations manage their own stock
          finalPrice = null; // Variations manage their own price
        }
      } else {
        // variations is empty array/null, product no longer has variations
        // Allow stock and price to be set normally
      }
    }

    await product.update({
      ...(name !== undefined && { name }),
      ...(sku !== undefined && { sku }),
      ...(description !== undefined && { description }),
      ...(price !== undefined && { price: finalPrice }),
      ...(cost !== undefined && { cost }),
      ...(stock !== undefined && { stock: finalStock }),
      ...(low_stock_threshold !== undefined && { low_stock_threshold }),
      ...(category !== undefined && { category }),
      ...(finalImageUrl !== undefined && { image_url: finalImageUrl }),
      ...(is_active !== undefined && { is_active })
    });

    // Handle variations update if provided
    if (variations !== undefined) {
      // Delete existing variations (cascade will delete options)
      await req.db.models.ProductVariation.destroy({
        where: { product_id: product.id }
      });

      // Create new variations if provided
      if (variations) {
        let parsedVariations = [];
        
        if (typeof variations === 'string') {
          try {
            parsedVariations = JSON.parse(variations);
          } catch (parseError) {
            console.error('Error parsing variations JSON:', parseError);
          }
        } else if (Array.isArray(variations)) {
          parsedVariations = variations;
        }

        // Validate: If product has variations, primary stock and price must not be provided
        // Variations have their own stock and price levels, so primary product values don't make sense
        if (Array.isArray(parsedVariations) && parsedVariations.length > 0) {
          // Check if any variation has options
          const hasVariationOptions = parsedVariations.some(v => 
            v.options && Array.isArray(v.options) && v.options.length > 0
          );
          
          if (hasVariationOptions) {
            const errors = [];
            
            // Check for primary stock
            if (stock !== undefined && stock !== null && stock !== '') {
              errors.push('stock');
            }
            
            // Check for primary price
            if (price !== undefined && price !== null && price !== '') {
              errors.push('price');
            }
            
            if (errors.length > 0) {
              // Clean up uploaded files if any
              if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
              }
              // Clean up uploaded variation option images if any
              if (req.files) {
                const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
                files.forEach(file => {
                  if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                  }
                });
              }
              
              const fieldNames = errors.join(' and ');
              return res.status(400).json({
                success: false,
                message: `Products with variations cannot have primary ${fieldNames}. Each variation option manages its own ${fieldNames} level.`,
                suggestion: `Remove the "${errors.join('" and "')}" parameter(s) from your request. ${errors.map(e => e.charAt(0).toUpperCase() + e.slice(1))} should only be specified in the variation options (e.g., options[0].${errors[0]}).`
              });
            }
          }
        }

        // Validate: Only ONE variation type per product allowed (keep it simple!)
        if (Array.isArray(parsedVariations) && parsedVariations.length > 1) {
          // Clean up uploaded files if any
          if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
          // Clean up uploaded variation option images if any
          if (req.files) {
            const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
            files.forEach(file => {
              if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
              }
            });
          }
          
          return res.status(400).json({
            success: false,
            message: 'A product can only have ONE variation type. Please choose either Color, Size, Material, etc., but not multiple types together.',
            suggestion: 'If you need multiple variations (e.g., Color + Size), create separate products like "T-Shirt - Red" (with sizes) and "T-Shirt - Blue" (with sizes).'
          });
        }

        if (Array.isArray(parsedVariations) && parsedVariations.length > 0) {
          const tenantId = req.user?.tenantId;
          const { getTenantById } = require('../config/tenant');
          let tenant = null;
          let isFreePlan = false;
          try {
            tenant = await getTenantById(tenantId);
            isFreePlan = tenant && tenant.subscription_plan === 'free';
          } catch (error) {
            console.warn('Could not fetch tenant:', error);
          }

          for (let i = 0; i < parsedVariations.length; i++) {
            const variationData = parsedVariations[i];
            if (!variationData.variation_name || !variationData.variation_type) {
              continue;
            }

            const variation = await req.db.models.ProductVariation.create({
              tenant_id: isFreePlan ? tenantId : null,
              product_id: product.id,
              variation_name: variationData.variation_name,
              variation_type: variationData.variation_type || 'other',
              is_required: variationData.is_required || false,
              sort_order: variationData.sort_order !== undefined ? parseInt(variationData.sort_order) : i
            });

            if (variationData.options && Array.isArray(variationData.options)) {
              for (let j = 0; j < variationData.options.length; j++) {
                const optionData = variationData.options[j];
                if (!optionData.value) {
                  continue;
                }

              // Calculate price: Use direct price if provided, otherwise calculate from base price + adjustment
              let finalPrice = parseFloat(product.price);
              if (optionData.price !== undefined && optionData.price !== null) {
                // Direct price provided - use it (much clearer for frontend!)
                finalPrice = parseFloat(optionData.price);
              } else if (optionData.price_adjustment !== undefined && optionData.price_adjustment !== null) {
                // Price adjustment provided (backward compatibility) - add to base price
                finalPrice = parseFloat(product.price) + parseFloat(optionData.price_adjustment || 0);
              }
              // If neither provided, use base product price

              await req.db.models.ProductVariationOption.create({
                tenant_id: isFreePlan ? tenantId : null,
                variation_id: variation.id,
                option_value: optionData.value,
                option_display_name: optionData.display_name || optionData.value,
                price_adjustment: finalPrice - parseFloat(product.price), // Store as adjustment for database consistency
                stock: parseInt(optionData.stock) || 0,
                sku: optionData.sku || null,
                barcode: optionData.barcode || null,
                image_url: optionData.image_url || null,
                is_default: optionData.is_default || false,
                is_available: optionData.is_available !== false,
                sort_order: optionData.sort_order !== undefined ? parseInt(optionData.sort_order) : j
              });
              }
            }
          }
        }
      }
    }

    // Fetch updated product with variations
    const updatedProduct = await req.db.models.Product.findByPk(product.id, {
      include: [
        {
          model: req.db.models.Store
        },
        {
          model: req.db.models.ProductVariation,
          include: [
            {
              model: req.db.models.ProductVariationOption
            }
          ],
          required: false
        }
      ]
    });

    // Convert image_url to full URL if it's a relative path
    const productData = updatedProduct.toJSON();
    if (productData.image_url && productData.image_url.startsWith('/uploads/')) {
      productData.image_url = getFullUrl(req, productData.image_url);
    }

    // Convert variation option image URLs to full URLs
    if (productData.ProductVariations) {
      productData.ProductVariations = productData.ProductVariations.map(variation => {
        if (variation.ProductVariationOptions) {
          variation.ProductVariationOptions = variation.ProductVariationOptions.map(option => {
            if (option.image_url && option.image_url.startsWith('/uploads/')) {
              option.image_url = getFullUrl(req, option.image_url);
            }
            return option;
          });
        }
        return variation;
      });
    }

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: { product: productData }
    });
  } catch (error) {
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product'
    });
  }
}

/**
 * Delete product
 */
async function deleteProduct(req, res) {
  try {
    const product = await req.db.models.Product.findByPk(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    await product.destroy();

    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product'
    });
  }
}

/**
 * Get low stock products
 */
/**
 * Lookup product by barcode (for inventory management/stock taking)
 * Similar to POS lookup but returns additional inventory info
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

    // Build product where clause
    const productWhere = {
      [Sequelize.Op.or]: [
        { barcode: barcode },
        { sku: barcode }
      ],
      is_active: true
    };

    if (store_id) {
      productWhere.store_id = store_id;
    }

    // First try to find by product barcode/SKU
    let product = await req.db.models.Product.findOne({
      where: productWhere,
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'store_type']
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
      ]
    });

    // If not found, check variation options
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
                    attributes: ['id', 'name', 'store_type']
                  }
                ]
              }
            ]
          }
        ]
      });

      if (variationOption && variationOption.ProductVariation && variationOption.ProductVariation.Product) {
        product = variationOption.ProductVariation.Product;
        const basePrice = parseFloat(product.price) || 0;
        const priceAdjustment = parseFloat(variationOption.price_adjustment) || 0;
        
        return res.json({
          success: true,
          data: {
            product: product.toJSON(),
            variation_option: {
              id: variationOption.id,
              variation_name: variationOption.ProductVariation.variation_name,
              option_value: variationOption.option_value,
              stock: variationOption.stock,
              sku: variationOption.sku,
              barcode: variationOption.barcode
            },
            current_stock: variationOption.stock || 0,
            scan_type: 'variation_option'
          }
        });
      }
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found. Please check the barcode.'
      });
    }

    // Get stock from ProductStore if product is in multiple stores
    let currentStock = product.stock || 0;
    if (store_id) {
      const productStore = await req.db.models.ProductStore.findOne({
        where: {
          product_id: product.id,
          store_id: store_id
        }
      });
      if (productStore) {
        currentStock = productStore.stock || 0;
      }
    }

    res.json({
      success: true,
      data: {
        product: product.toJSON(),
        current_stock: currentStock,
        scan_type: 'product',
        low_stock_threshold: product.low_stock_threshold,
        stock_warning: product.low_stock_threshold && currentStock <= product.low_stock_threshold
      }
    });
  } catch (error) {
    console.error('Error looking up product by barcode:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to lookup product'
    });
  }
}

/**
 * Update stock by barcode (for stock taking)
 * Supports both absolute stock value and relative adjustment
 */
async function updateStockByBarcode(req, res) {
  try {
    const { barcode, stock, stock_adjustment, store_id, notes } = req.body;

    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: 'Barcode is required'
      });
    }

    if (stock === undefined && stock_adjustment === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Either stock or stock_adjustment is required'
      });
    }

    // Find product or variation option by barcode
    let product = await req.db.models.Product.findOne({
      where: {
        [Sequelize.Op.or]: [
          { barcode: barcode },
          { sku: barcode }
        ],
        is_active: true
      }
    });

    let variationOption = null;
    let isVariationOption = false;

    if (!product) {
      // Check variation options
      variationOption = await req.db.models.ProductVariationOption.findOne({
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
                required: true
              }
            ]
          }
        ]
      });

      if (variationOption && variationOption.ProductVariation && variationOption.ProductVariation.Product) {
        product = variationOption.ProductVariation.Product;
        isVariationOption = true;
      }
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Calculate new stock
    let previousStock;
    let newStock;

    if (isVariationOption) {
      previousStock = variationOption.stock || 0;
      if (stock !== undefined) {
        newStock = parseInt(stock);
      } else {
        newStock = previousStock + parseInt(stock_adjustment || 0);
      }
      
      // Update variation option stock
      await variationOption.update({ stock: Math.max(0, newStock) });
    } else {
      // Handle store-specific stock or global stock
      if (store_id) {
        let productStore = await req.db.models.ProductStore.findOne({
          where: {
            product_id: product.id,
            store_id: store_id
          }
        });

        if (!productStore) {
          // Create ProductStore entry if it doesn't exist
          const tenantId = req.user?.tenantId;
          const { getTenantById } = require('../config/tenant');
          let tenant = null;
          let isFreePlan = false;
          try {
            tenant = await getTenantById(tenantId);
            isFreePlan = tenant && tenant.subscription_plan === 'free';
          } catch (error) {
            console.warn('Could not fetch tenant:', error);
          }

          productStore = await req.db.models.ProductStore.create({
            tenant_id: isFreePlan ? tenantId : null,
            product_id: product.id,
            store_id: store_id,
            stock: 0
          });
        }

        previousStock = productStore.stock || 0;
        if (stock !== undefined) {
          newStock = parseInt(stock);
        } else {
          newStock = previousStock + parseInt(stock_adjustment || 0);
        }

        await productStore.update({ stock: Math.max(0, newStock) });
      } else {
        previousStock = product.stock || 0;
        if (stock !== undefined) {
          newStock = parseInt(stock);
        } else {
          newStock = previousStock + parseInt(stock_adjustment || 0);
        }

        await product.update({ stock: Math.max(0, newStock) });
      }
    }

    // Record stock movement
    const { initModels } = require('../middleware/models');
    const models = initModels(req.db);
    
    const tenantId = req.user?.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    await models.StockMovement.create({
      tenant_id: isFreePlan ? tenantId : null,
      product_id: product.id,
      store_id: store_id || product.store_id || null,
      movement_type: stock_adjustment ? 'adjustment' : 'manual_update',
      quantity: stock !== undefined ? (newStock - previousStock) : parseInt(stock_adjustment || 0),
      reference_type: 'stock_taking',
      notes: notes || `Stock updated via barcode scanner: ${isVariationOption ? 'variation option' : 'product'}`,
      created_by: req.user.staffId || req.user.id
    });

    res.json({
      success: true,
      message: 'Stock updated successfully',
      data: {
        product: {
          id: product.id,
          name: product.name,
          barcode: isVariationOption ? variationOption.barcode : product.barcode,
          sku: isVariationOption ? variationOption.sku : product.sku
        },
        variation_option: isVariationOption ? {
          id: variationOption.id,
          variation_name: variationOption.ProductVariation.variation_name,
          option_value: variationOption.option_value
        } : null,
        previous_stock: previousStock,
        new_stock: newStock,
        adjustment: newStock - previousStock
      }
    });
  } catch (error) {
    console.error('Error updating stock by barcode:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update stock'
    });
  }
}

/**
 * Bulk update stock for multiple products (for efficient stock taking)
 */
async function bulkUpdateStock(req, res) {
  try {
    const { items } = req.body; // Array of { barcode, stock, stock_adjustment, store_id }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'items must be a non-empty array'
      });
    }

    const results = {
      successful: [],
      failed: []
    };

    for (const item of items) {
      try {
        const { barcode, stock, stock_adjustment, store_id, notes } = item;

        if (!barcode) {
          results.failed.push({
            barcode: barcode || 'N/A',
            error: 'Barcode is required'
          });
          continue;
        }

        if (stock === undefined && stock_adjustment === undefined) {
          results.failed.push({
            barcode,
            error: 'Either stock or stock_adjustment is required'
          });
          continue;
        }

        // Find product or variation option
        let product = await req.db.models.Product.findOne({
          where: {
            [Sequelize.Op.or]: [
              { barcode: barcode },
              { sku: barcode }
            ],
            is_active: true
          }
        });

        let variationOption = null;
        let isVariationOption = false;

        if (!product) {
          variationOption = await req.db.models.ProductVariationOption.findOne({
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
                    required: true
                  }
                ]
              }
            ]
          });

          if (variationOption && variationOption.ProductVariation && variationOption.ProductVariation.Product) {
            product = variationOption.ProductVariation.Product;
            isVariationOption = true;
          }
        }

        if (!product) {
          results.failed.push({
            barcode,
            error: 'Product not found'
          });
          continue;
        }

        // Update stock (same logic as updateStockByBarcode)
        let previousStock;
        let newStock;

        if (isVariationOption) {
          previousStock = variationOption.stock || 0;
          newStock = stock !== undefined ? parseInt(stock) : previousStock + parseInt(stock_adjustment || 0);
          await variationOption.update({ stock: Math.max(0, newStock) });
        } else {
          if (store_id) {
            let productStore = await req.db.models.ProductStore.findOne({
              where: {
                product_id: product.id,
                store_id: store_id
              }
            });

            if (!productStore) {
              const tenantId = req.user?.tenantId;
              const { getTenantById } = require('../config/tenant');
              let tenant = null;
              let isFreePlan = false;
              try {
                tenant = await getTenantById(tenantId);
                isFreePlan = tenant && tenant.subscription_plan === 'free';
              } catch (error) {
                console.warn('Could not fetch tenant:', error);
              }

              productStore = await req.db.models.ProductStore.create({
                tenant_id: isFreePlan ? tenantId : null,
                product_id: product.id,
                store_id: store_id,
                stock: 0
              });
            }

            previousStock = productStore.stock || 0;
            newStock = stock !== undefined ? parseInt(stock) : previousStock + parseInt(stock_adjustment || 0);
            await productStore.update({ stock: Math.max(0, newStock) });
          } else {
            previousStock = product.stock || 0;
            newStock = stock !== undefined ? parseInt(stock) : previousStock + parseInt(stock_adjustment || 0);
            await product.update({ stock: Math.max(0, newStock) });
          }
        }

        results.successful.push({
          barcode,
          product_id: product.id,
          product_name: product.name,
          previous_stock: previousStock,
          new_stock: newStock
        });
      } catch (error) {
        console.error(`Error processing item ${item.barcode}:`, error);
        results.failed.push({
          barcode: item.barcode || 'N/A',
          error: error.message || 'Unknown error'
        });
      }
    }

    res.json({
      success: true,
      message: `Processed ${items.length} items: ${results.successful.length} successful, ${results.failed.length} failed`,
      data: results
    });
  } catch (error) {
    console.error('Error bulk updating stock:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bulk update stock'
    });
  }
}

async function getLowStockProducts(req, res) {
  try {
    const products = await req.db.models.Product.findAll({
      where: {
        is_active: true,
        stock: {
          [Sequelize.Op.lte]: Sequelize.col('low_stock_threshold')
        }
      },
      order: [['stock', 'ASC']]
    });

    res.json({
      success: true,
      data: { products }
    });
  } catch (error) {
    console.error('Error getting low stock products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get low stock products'
    });
  }
}

/**
 * Get product categories (dynamically generated from products)
 * Returns all unique categories that users have created when uploading products
 * Categories are sorted by usage count (most used first) or alphabetically
 */
async function getProductCategories(req, res) {
  try {
    const { sort_by = 'count' } = req.query; // 'count' or 'name'
    
    // Get all unique categories with their usage counts using proper GROUP BY
    const categories = await req.db.models.Product.findAll({
      attributes: [
        'category',
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'product_count']
      ],
      where: {
        category: {
          [Sequelize.Op.ne]: null,
          [Sequelize.Op.ne]: '' // Exclude empty strings
        }
      },
      group: ['category'],
      having: Sequelize.where(
        Sequelize.col('category'),
        { [Sequelize.Op.ne]: null }
      ),
      raw: true
    });

    // Format the results
    let formattedCategories = categories.map(cat => ({
      name: cat.category,
      product_count: parseInt(cat.product_count) || 0
    }));

    // Sort results
    if (sort_by === 'count') {
      // Sort by product count (descending - most used first)
      formattedCategories.sort((a, b) => b.product_count - a.product_count);
    } else if (sort_by === 'name') {
      // Sort alphabetically
      formattedCategories.sort((a, b) => a.name.localeCompare(b.name));
    }

    res.json({
      success: true,
      data: {
        categories: formattedCategories,
        total: formattedCategories.length,
        sort_by: sort_by
      }
    });
  } catch (error) {
    console.error('Error getting product categories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product categories'
    });
  }
}

module.exports = {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getLowStockProducts,
  addProductToStores,
  removeProductFromStore,
  lookupProductByBarcode,
  updateStockByBarcode,
  bulkUpdateStock,
  getProductCategories
};

