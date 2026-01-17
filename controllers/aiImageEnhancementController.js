const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Enhance product image using AI
 * Supports: color change, background replacement, element addition, style enhancement
 */
async function enhanceProductImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Image file is required'
      });
    }

    const {
      enhancement_type, // 'change_color', 'change_background', 'add_elements', 'enhance_style', 'remove_background'
      color, // Target color for color change (hex code or color name)
      background, // Background description or 'transparent' for removal
      elements, // JSON string array of elements to add: ['text: "Sale 50%", position: "top-right"']
      style, // Style description: 'modern', 'vintage', 'minimalist', 'luxury'
      prompt // Custom prompt for advanced enhancements
    } = req.body;

    if (!enhancement_type) {
      return res.status(400).json({
        success: false,
        message: 'enhancement_type is required. Options: change_color, change_background, add_elements, enhance_style, remove_background'
      });
    }

    // Read image file
    const imageBuffer = fs.readFileSync(req.file.path);
    const imageBase64 = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype;

    // Prepare enhancement prompt based on type
    let enhancementPrompt = '';
    
    switch (enhancement_type) {
      case 'change_color':
        if (!color) {
          return res.status(400).json({
            success: false,
            message: 'color parameter is required for change_color enhancement'
          });
        }
        enhancementPrompt = `Change the primary color of this product to ${color}. Keep the product shape and structure identical. Only change the color. Make it look natural and realistic.`;
        break;

      case 'change_background':
        if (!background) {
          return res.status(400).json({
            success: false,
            message: 'background parameter is required for change_background enhancement'
          });
        }
        if (background === 'transparent' || background === 'remove') {
          enhancementPrompt = `Remove the background from this product image. Make the background completely transparent while keeping the product intact and sharp.`;
        } else {
          enhancementPrompt = `Replace the background of this product image with: ${background}. Keep the product in the foreground sharp and clear. Make it look professional and realistic.`;
        }
        break;

      case 'add_elements':
        let elementsToAdd = [];
        if (elements) {
          try {
            elementsToAdd = typeof elements === 'string' ? JSON.parse(elements) : elements;
          } catch (e) {
            elementsToAdd = [];
          }
        }
        if (elementsToAdd.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'elements parameter is required (JSON array) for add_elements enhancement'
          });
        }
        enhancementPrompt = `Add the following elements to this product image: ${JSON.stringify(elementsToAdd)}. Make them look natural and integrated with the product.`;
        break;

      case 'enhance_style':
        const styleDesc = style || 'professional e-commerce product photography';
        enhancementPrompt = `Enhance this product image in a ${styleDesc} style. Improve lighting, composition, and overall visual appeal while keeping the product recognizable. Make it suitable for e-commerce.`;
        break;

      case 'remove_background':
        enhancementPrompt = `Remove the background from this product image completely. Make it transparent background. Keep the product edges clean and sharp.`;
        break;

      default:
        if (prompt) {
          enhancementPrompt = prompt;
        } else {
          return res.status(400).json({
            success: false,
            message: `Unknown enhancement_type: ${enhancement_type}`
          });
        }
    }

    // Use Gemini 1.5 Pro for image understanding and generation
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    // For image editing, we'll use Gemini to understand and generate instructions
    // Note: Gemini can generate images via Imagen API, but for direct image editing,
    // we'll use a combination approach
    
    // Option 1: Use Gemini Vision to analyze and provide enhanced version description
    // Then use Imagen API or other service to generate
    
    // Option 2: Use Stability AI or other image generation API with Gemini's guidance
    
    // For now, let's implement using Gemini's vision capabilities + image generation
    try {
      // Step 1: Analyze the image with Gemini
      const analysisPrompt = `Analyze this product image and provide a detailed description for enhancement. ${enhancementPrompt}`;
      
      const analysisResult = await model.generateContent([
        {
          inlineData: {
            data: imageBase64,
            mimeType: mimeType
          }
        },
        analysisPrompt
      ]);

      const analysisText = analysisResult.response.text();

      // Step 2: Generate enhanced image using Imagen (Google's image generation)
      // Note: Imagen API requires separate setup
      // For now, we'll provide the enhancement details and suggest using external service
      
      // Alternative: Use Stability AI or other image generation service
      // For demonstration, we'll create a response with enhancement instructions
      
      // Save enhanced image instructions
      const enhancedImagePath = path.join(__dirname, '../uploads/enhanced', `enhanced-${Date.now()}-${req.file.filename}`);
      
      // For production, integrate with actual image generation API
      // Here's the structure for using Stability AI or similar:
      
      res.json({
        success: true,
        message: 'Image enhancement analysis complete',
        data: {
          original_image: getFullUrl(req, `/uploads/products/${req.file.filename}`),
          enhancement_type: enhancement_type,
          analysis: analysisText,
          instructions: enhancementPrompt,
          // In production, this would be the enhanced image URL
          enhanced_image_url: null, // Would be set after image generation
          note: 'Image generation requires Imagen API or Stability AI integration. Enhancement analysis complete.'
        }
      });

      // Clean up original file (or keep it)
      // fs.unlinkSync(req.file.path);

    } catch (error) {
      console.error('Gemini API error:', error);
      throw error;
    }

  } catch (error) {
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    console.error('Error enhancing product image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to enhance product image',
      error: error.message
    });
  }
}

/**
 * Helper function to get full URL
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
 * Simple background removal using external API (remove.bg alternative)
 * Uses Gemini to detect product and suggest background removal
 */
async function removeBackgroundSimple(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Image file is required'
      });
    }

    // For production, integrate with remove.bg API or similar
    // This is a placeholder that uses Gemini to analyze
    
    const imageBuffer = fs.readFileSync(req.file.path);
    const imageBase64 = imageBuffer.toString('base64');
    
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    
    const prompt = `Analyze this product image and describe what the background looks like. If it's a simple background, suggest how to remove it. Return a JSON with: { "has_simple_background": boolean, "background_type": string, "removal_difficulty": "easy" | "medium" | "hard" }`;
    
    const result = await model.generateContent([
      {
        inlineData: {
          data: imageBase64,
          mimeType: req.file.mimetype
        }
      },
      prompt
    ]);

    const analysis = JSON.parse(result.response.text());

    res.json({
      success: true,
      data: {
        analysis: analysis,
        original_image: getFullUrl(req, `/uploads/products/${req.file.filename}`),
        note: 'For actual background removal, integrate with remove.bg API or use image processing libraries'
      }
    });

  } catch (error) {
    console.error('Error in background removal:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to analyze image for background removal',
      error: error.message
    });
  }
}

module.exports = {
  enhanceProductImage,
  removeBackgroundSimple
};

