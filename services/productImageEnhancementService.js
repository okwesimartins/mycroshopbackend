/**
 * Product Image Enhancement Service
 * Uses Gemini AI to enhance product images with predefined presets
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Sharp for image processing
let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  console.warn('Sharp not available - some image enhancements may be limited');
}

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Preset configurations for image enhancement
 */
const PRESETS = {
  'clean_up_enhance': {
    name: 'Clean Up & Enhance',
    description: 'Clean up the image, improve quality, remove imperfections, and enhance overall appearance',
    prompt: `Enhance this product image by:
- Cleaning up any imperfections, dust, or blemishes
- Improving sharpness and clarity
- Optimizing lighting for professional e-commerce look
- Maintaining the product's original colors and appearance
- Making it ready for marketplace listing
Return a high-quality, professional product image suitable for e-commerce.`
  },
  'marketplace_ready': {
    name: 'Marketplace Ready (White Background)',
    description: 'Clean white background perfect for marketplace listings',
    prompt: `Transform this product image to have a clean, pure white background (#FFFFFF):
- Remove the existing background completely
- Place the product on a seamless white background
- Ensure professional lighting with no shadows or harsh edges
- Make the product stand out clearly
- Optimize for marketplace listings (Amazon, eBay, etc.)
Return a professional product image with white background.`
  },
  'background_removed': {
    name: 'Background Removed (Transparent PNG)',
    description: 'Remove background and create transparent PNG',
    prompt: `Remove the background from this product image completely:
- Create a transparent background (PNG format)
- Keep the product edges clean and sharp
- Remove all shadows and background elements
- Maintain product quality and detail
- Ensure the product is isolated perfectly
Return the product with transparent background.`
  },
  'brand_background': {
    name: 'Brand Background (Use My Store Color)',
    description: 'Apply your store brand color as background',
    prompt: (brandColor) => `Transform this product image with a brand-colored background:
- Replace the background with a solid color: ${brandColor || '#2563EB'}
- Ensure the product stands out against the background
- Apply professional lighting
- Maintain brand consistency
- Create a cohesive brand look
Return a professional product image with brand-colored background.`
  },
  'minimal_neutral': {
    name: 'Minimal Neutral (Light Gray Studio)',
    description: 'Minimalist look with light gray studio background',
    prompt: `Transform this product image to a minimal, neutral studio look:
- Use a light gray (#F5F5F5) studio background
- Apply soft, even lighting
- Create a clean, minimalist aesthetic
- Remove distractions
- Focus attention on the product
- Professional e-commerce photography style
Return a minimal, neutral product image.`
  },
  'premium_luxury': {
    name: 'Premium / Luxury Look',
    description: 'Premium luxury aesthetic with elegant styling',
    prompt: `Transform this product image to a premium, luxury aesthetic:
- Apply elegant, sophisticated lighting
- Use subtle shadows and depth
- Create a high-end, premium feel
- Enhance product details and textures
- Apply a refined color palette
- Professional luxury brand photography style
Return a premium, luxury product image.`
  },
  'bold_pop': {
    name: 'Bold Pop (Color Backdrop)',
    description: 'Vibrant, bold look with colorful backdrop',
    prompt: `Transform this product image with a bold, vibrant look:
- Use a colorful, eye-catching background
- Apply vibrant, saturated colors
- Create a bold, modern aesthetic
- Make the product pop with contrast
- Use dynamic lighting
- Create an energetic, attention-grabbing image
Return a bold, vibrant product image with colorful backdrop.`
  }
};

/**
 * Get available presets
 */
function getAvailablePresets() {
  return Object.keys(PRESETS).map(key => ({
    id: key,
    name: PRESETS[key].name,
    description: PRESETS[key].description
  }));
}

/**
 * Enhance product image using Gemini AI with preset
 * @param {string} imagePath - Path to the product image
 * @param {string} presetId - Preset ID from PRESETS
 * @param {string} brandColor - Optional brand color for brand_background preset
 * @returns {Promise<Object>} Enhanced image data
 */
async function enhanceProductImage(imagePath, presetId, brandColor = null) {
  try {
    if (!PRESETS[presetId]) {
      throw new Error(`Invalid preset ID: ${presetId}`);
    }

    // Read image file
    let imageBuffer;
    let mimeType = 'image/png';

    if (typeof imagePath === 'string') {
      // Check if it's a URL
      if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        const response = await axios.get(imagePath, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data);
        mimeType = response.headers['content-type'] || 'image/jpeg';
      } else {
        // Local file path
        const fullPath = imagePath.startsWith('/') 
          ? path.join(__dirname, '..', imagePath)
          : path.join(__dirname, '..', 'uploads', imagePath);
        
        if (!fs.existsSync(fullPath)) {
          throw new Error(`Image file not found: ${fullPath}`);
        }
        
        imageBuffer = fs.readFileSync(fullPath);
        
        // Detect mime type from extension
        const ext = path.extname(fullPath).toLowerCase();
        if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
        else if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.webp') mimeType = 'image/webp';
        else if (ext === '.gif') mimeType = 'image/gif';
      }
    } else if (Buffer.isBuffer(imagePath)) {
      imageBuffer = imagePath;
    } else {
      throw new Error('Invalid image path or buffer');
    }

    const imageBase64 = imageBuffer.toString('base64');

    // Get preset prompt
    const preset = PRESETS[presetId];
    let enhancementPrompt = typeof preset.prompt === 'function' 
      ? preset.prompt(brandColor)
      : preset.prompt;

    // Use Gemini 1.5 Pro Vision for image understanding and generation
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-pro',
      generationConfig: {
        temperature: 0.4,
        topK: 32,
        topP: 1,
        maxOutputTokens: 4096,
      }
    });

    // Create the enhancement request
    const fullPrompt = `${enhancementPrompt}

Important instructions:
- Maintain the product's original shape, size, and proportions
- Keep the product recognizable and accurate
- Ensure high quality and professional appearance
- Optimize for e-commerce and marketplace use
- Return a detailed description of the enhanced image that can be used to regenerate it`;

    // Use Gemini to analyze the image and guide enhancement
    const analysisResult = await model.generateContent([
      {
        inlineData: {
          data: imageBase64,
          mimeType: mimeType
        }
      },
      fullPrompt
    ]);

    const analysisText = analysisResult.response.text();

    // Prepare output path
    const outputPath = path.join(__dirname, '../uploads/products/enhanced', `enhanced-${Date.now()}-${path.basename(imagePath)}`);
    
    // Ensure directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    if (!sharp) {
      throw new Error('Sharp library is required for image enhancement. Please install: npm install sharp');
    }

    let enhancedImageBuffer = imageBuffer;
    let usedGeminiImageModel = false;

    // For background removal, try Gemini image models first
    if (presetId === 'background_removed') {
      try {
        enhancedImageBuffer = await enhanceWithGeminiImageModel(imageBuffer, mimeType, enhancementPrompt);
        usedGeminiImageModel = true;
        console.log('✅ Used Gemini image model for background removal');
      } catch (geminiError) {
        console.warn('⚠️ Gemini image model failed, falling back to Sharp:', geminiError.message);
        // Fall through to Sharp processing
      }
    }

    // If not using Gemini or if it failed, use Sharp
    if (!usedGeminiImageModel) {
      let sharpImage = sharp(imageBuffer);

    // Apply enhancements based on preset
    switch (presetId) {
      case 'clean_up_enhance':
        // Enhance quality, sharpen, improve contrast
        enhancedImageBuffer = await sharpImage
          .sharpen()
          .normalise()
          .modulate({ brightness: 1.1, saturation: 1.05 })
          .toBuffer();
        break;

      case 'marketplace_ready':
        // Remove background and add white background
        // First, try to extract the product (simple approach - remove similar colors)
        // For better results, would need advanced background removal API
        enhancedImageBuffer = await sharpImage
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .extend({
            top: 100,
            bottom: 100,
            left: 100,
            right: 100,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
          })
          .sharpen()
          .toBuffer();
        break;

      case 'background_removed':
        // Background removal should already be handled by Gemini image model above
        // If we reach here, Gemini failed and we're using Sharp fallback
        // Sharp can't truly remove backgrounds, so we'll just convert to PNG
        // For better results, the Gemini image model should handle this
        enhancedImageBuffer = await sharpImage
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .png() // Ensure PNG format for transparency
          .toBuffer();
        break;

      case 'brand_background':
        // Add brand colored background
        const brandColorRgb = hexToRgb(brandColor || '#2563EB');
        enhancedImageBuffer = await sharpImage
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .extend({
            top: 150,
            bottom: 150,
            left: 150,
            right: 150,
            background: brandColorRgb
          })
          .sharpen()
          .toBuffer();
        break;

      case 'minimal_neutral':
        // Light gray studio background
        enhancedImageBuffer = await sharpImage
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .extend({
            top: 150,
            bottom: 150,
            left: 150,
            right: 150,
            background: { r: 245, g: 245, b: 245, alpha: 1 }
          })
          .sharpen()
          .modulate({ brightness: 1.05 })
          .toBuffer();
        break;

      case 'premium_luxury':
        // Premium look with enhanced lighting and contrast
        enhancedImageBuffer = await sharpImage
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .sharpen({ sigma: 1.5 })
          .normalise()
          .modulate({ brightness: 1.15, saturation: 1.1 })
          .extend({
            top: 100,
            bottom: 100,
            left: 100,
            right: 100,
            background: { r: 250, g: 250, b: 250, alpha: 1 }
          })
          .toBuffer();
        break;

      case 'bold_pop':
        // Vibrant colors with colorful background
        const vibrantColor = { r: 255, g: 100, b: 150, alpha: 1 }; // Pink/magenta
        enhancedImageBuffer = await sharpImage
          .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
          .modulate({ brightness: 1.2, saturation: 1.3 })
          .extend({
            top: 150,
            bottom: 150,
            left: 150,
            right: 150,
            background: vibrantColor
          })
          .sharpen()
          .toBuffer();
        break;

      default:
        // Default enhancement
        enhancedImageBuffer = await sharpImage
          .sharpen()
          .normalise()
          .toBuffer();
      }
    }

    // Save enhanced image
    await fs.promises.writeFile(outputPath, enhancedImageBuffer);

    // Get relative path for URL
    const relativePath = `/uploads/products/enhanced/${path.basename(outputPath)}`;

    return {
      success: true,
      preset: preset.name,
      description: analysisText,
      originalImage: imagePath,
      enhancedImageUrl: relativePath,
      enhancedImagePath: outputPath,
      enhancementMethod: usedGeminiImageModel ? 'gemini_image_model' : 'sharp',
      note: usedGeminiImageModel 
        ? 'Enhanced using Gemini AI image model' 
        : 'Enhanced using Sharp image processing'
    };

  } catch (error) {
    console.error('Error enhancing product image:', error);
    throw error;
  }
}

/**
 * Generate product image using Gemini (for catalog makeover)
 * @param {string} productDescription - Description of the product
 * @param {string} presetId - Preset ID
 * @param {string} brandColor - Optional brand color
 * @returns {Promise<Object>} Generated image data
 */
async function generateProductImage(productDescription, presetId, brandColor = null) {
  try {
    if (!PRESETS[presetId]) {
      throw new Error(`Invalid preset ID: ${presetId}`);
    }

    const preset = PRESETS[presetId];
    let enhancementPrompt = typeof preset.prompt === 'function' 
      ? preset.prompt(brandColor)
      : preset.prompt;

    // Use Gemini to generate product image
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-pro',
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 4096,
      }
    });

    const fullPrompt = `Generate a professional product image for: ${productDescription}

${enhancementPrompt}

Requirements:
- High quality, professional e-commerce photography
- Product should be clearly visible and well-lit
- Suitable for marketplace and online store listings
- Professional product photography standards`;

    // Generate image description (Gemini can describe, actual generation needs Imagen or similar)
    const result = await model.generateContent(fullPrompt);
    const description = result.response.text();

    return {
      success: true,
      preset: preset.name,
      productDescription: productDescription,
      generatedDescription: description,
      // In production, this would be the URL to the generated image
      generatedImageUrl: null,
      note: 'Product image description generated. For actual image generation, integrate with image generation API (Imagen, DALL-E, Stability AI, etc.).'
    };

  } catch (error) {
    console.error('Error generating product image:', error);
    throw error;
  }
}

/**
 * Enhance image using Gemini image models (for background removal and advanced edits)
 * Tries multiple Gemini image generation models with fallback
 * @param {Buffer} imageBuffer - Original image buffer
 * @param {string} mimeType - Image MIME type
 * @param {string} prompt - Enhancement prompt
 * @returns {Promise<Buffer>} Enhanced image buffer
 */
async function enhanceWithGeminiImageModel(imageBuffer, mimeType, prompt) {
  try {
    const imageBase64 = imageBuffer.toString('base64');
    
    // Try using Gemini image generation models
    // Note: Model names may vary - check Google AI Studio for latest available models
    const imageModelNames = [
      'gemini-2.5-flash-image',
      'gemini-3-pro-image-preview',
      'imagen-3.0-generate-001',
      'gemini-1.5-pro' // Fallback - may return text but worth trying
    ];

    let lastError = null;

    // Try each available image model
    for (const modelName of imageModelNames) {
      try {
        console.log(`🔄 Trying Gemini image model: ${modelName}`);
        
        const imageModel = genAI.getGenerativeModel({ 
          model: modelName,
          generationConfig: {
            temperature: 0.3,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 4096,
          }
        });

        // Create detailed prompt for background removal
        const backgroundRemovalPrompt = `Remove the background from this product image completely. 
Make the background transparent (PNG format). 
Keep the product edges clean and sharp. 
Maintain product quality and detail. 
Professional e-commerce standard.
Return the enhanced image with transparent background.`;

        // Request image enhancement
        const result = await imageModel.generateContent([
          {
            inlineData: {
              data: imageBase64,
              mimeType: mimeType
            }
          },
          backgroundRemovalPrompt
        ]);

        const response = result.response;
        
        // Check if response contains image data
        const candidates = response.candidates || [];
        
        for (const candidate of candidates) {
          const parts = candidate.content?.parts || [];
          for (const part of parts) {
            // Check for inline image data in response
            if (part.inlineData && part.inlineData.data) {
              // Found image data in response!
              console.log(`✅ Successfully got image from ${modelName}`);
              const enhancedBase64 = part.inlineData.data;
              return Buffer.from(enhancedBase64, 'base64');
            }
          }
        }

        // If we got here, the model responded but didn't return image data
        // Try next model
        console.log(`⚠️ ${modelName} returned text instead of image, trying next model...`);
        
      } catch (modelError) {
        // Model not available or error - try next one
        console.log(`⚠️ ${modelName} not available:`, modelError.message);
        lastError = modelError;
        continue;
      }
    }

    // If all models failed or returned text, throw error to fall back to Sharp
    throw new Error(`Gemini image models not available or returned text descriptions. Last error: ${lastError?.message || 'No image data in response'}`);

  } catch (error) {
    console.error('Gemini image model enhancement error:', error);
    throw error;
  }
}

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
    alpha: 1
  } : { r: 37, g: 99, b: 235, alpha: 1 }; // Default blue
}

module.exports = {
  getAvailablePresets,
  enhanceProductImage,
  generateProductImage,
  PRESETS
};

