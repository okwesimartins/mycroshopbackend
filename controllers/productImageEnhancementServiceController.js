/**
 * Product Image Enhancement Controller
 * Handles product image enhancement and generation with AI presets
 */

const { getTenantConnection } = require('../config/database');
const { getTenantById } = require('../config/tenant');
const initModels = require('../models');
const {
  getAvailablePresets,
  enhanceProductImage,
  generateProductImage
} = require('../services/productImageEnhancementService');
const path = require('path');
const fs = require('fs');

/**
 * Get available enhancement presets
 * GET /api/v1/products/image-enhancement/presets
 */
async function getPresets(req, res) {
  try {
    const presets = getAvailablePresets();
    
    res.json({
      success: true,
      data: {
        presets,
        count: presets.length
      }
    });
  } catch (error) {
    console.error('Error getting presets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get presets',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Enhance existing product image
 * POST /api/v1/products/image-enhancement/enhance
 * Body: { product_id, preset_id, brand_color (optional) }
 */
async function enhanceProductImageEndpoint(req, res) {
  try {
    const { product_id, preset_id, brand_color } = req.body;

    if (!product_id || !preset_id) {
      return res.status(400).json({
        success: false,
        message: 'product_id and preset_id are required'
      });
    }

    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);

    // Get product
    const product = await models.Product.findByPk(product_id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (!product.image_url) {
      return res.status(400).json({
        success: false,
        message: 'Product does not have an image'
      });
    }

    // Get tenant for brand color if not provided
    let finalBrandColor = brand_color;
    if (!finalBrandColor && preset_id === 'brand_background') {
      const tenantId = req.user?.tenantId;
      if (tenantId) {
        const { getTenantById } = require('../config/tenant');
        const tenant = await getTenantById(tenantId);
        // Extract primary color from logo or use default
        // For now, use a default brand color
        finalBrandColor = '#2563EB'; // Default blue
      }
    }

    // Enhance image
    const result = await enhanceProductImage(product.image_url, preset_id, finalBrandColor);

    // Get full URL for enhanced image
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    res.json({
      success: true,
      message: 'Product image enhanced successfully',
      data: {
        product_id: product.id,
        product_name: product.name,
        preset: result.preset,
        original_image: getFullUrl(product.image_url),
        enhanced_image: getFullUrl(result.enhancedImageUrl),
        enhanced_image_path: result.enhancedImageUrl, // Relative path for saving
        description: result.description,
        enhancement_method: result.enhancementMethod || 'sharp', // 'gemini_image_model' or 'sharp'
        note: result.note || 'Image enhanced successfully'
      }
    });
  } catch (error) {
    console.error('Error enhancing product image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to enhance product image',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Generate product image for catalog makeover
 * POST /api/v1/products/image-enhancement/generate
 * Body: { product_description, preset_id, brand_color (optional) }
 */
async function generateProductImageEndpoint(req, res) {
  try {
    const { product_description, preset_id, brand_color } = req.body;

    if (!product_description || !preset_id) {
      return res.status(400).json({
        success: false,
        message: 'product_description and preset_id are required'
      });
    }

    // Get tenant for brand color if not provided
    let finalBrandColor = brand_color;
    if (!finalBrandColor && preset_id === 'brand_background') {
      const tenantId = req.user?.tenantId;
      if (tenantId) {
        const { getTenantById } = require('../config/tenant');
        const tenant = await getTenantById(tenantId);
        finalBrandColor = '#2563EB'; // Default brand color
      }
    }

    // Generate image
    const result = await generateProductImage(product_description, preset_id, finalBrandColor);

    res.json({
      success: true,
      message: 'Product image generated successfully',
      data: {
        preset: result.preset,
        product_description: result.productDescription,
        generated_image: result.generatedImageUrl,
        description: result.generatedDescription,
        note: result.note
      }
    });
  } catch (error) {
    console.error('Error generating product image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate product image',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Save enhanced image as product's main image
 * POST /api/v1/products/image-enhancement/save
 * Body: { product_id, enhanced_image_path }
 */
async function saveEnhancedImage(req, res) {
  try {
    const { product_id, enhanced_image_path } = req.body;

    if (!product_id || !enhanced_image_path) {
      return res.status(400).json({
        success: false,
        message: 'product_id and enhanced_image_path are required'
      });
    }

    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);

    // Get product
    const product = await models.Product.findByPk(product_id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Verify enhanced image exists
    const fs = require('fs');
    const path = require('path');
    const fullPath = path.join(__dirname, '..', enhanced_image_path);
    
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({
        success: false,
        message: 'Enhanced image file not found'
      });
    }

    // Update product image
    await product.update({
      image_url: enhanced_image_path
    });

    // Get full URL
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    res.json({
      success: true,
      message: 'Enhanced image saved as product image',
      data: {
        product_id: product.id,
        product_name: product.name,
        image_url: enhanced_image_path,
        image_url_full: getFullUrl(enhanced_image_path)
      }
    });
  } catch (error) {
    console.error('Error saving enhanced image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save enhanced image',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  getPresets,
  enhanceProductImageEndpoint,
  generateProductImageEndpoint,
  saveEnhancedImage
};

