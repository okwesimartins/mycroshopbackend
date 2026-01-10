const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const axios = require('axios');

// Sharp is optional - only used for image format conversion
// If not available, we'll skip conversion (Gemini can handle most formats)
let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  console.warn('Sharp not available - image format conversion will be skipped. Install with: npm install sharp');
}

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Extract brand colors from logo image using Gemini Vision
 * @param {Buffer|string} logoImage - Logo image buffer or URL
 * @returns {Promise<Object>} Extracted colors
 */
async function extractColorsFromLogo(logoImage) {
  try {
    let imageBuffer;
    let mimeType = 'image/png';

    // Handle URL or buffer
    if (typeof logoImage === 'string') {
      // Check if it's a relative path (starts with /uploads/ or uploads/)
      if (logoImage.startsWith('/uploads/') || logoImage.startsWith('uploads/')) {
        // Read file from local filesystem
        const fs = require('fs');
        const path = require('path');
        const logoFilename = logoImage.split('/').pop();
        const logoFilePath = path.join(__dirname, '..', 'uploads', 'logos', logoFilename);
        
        if (fs.existsSync(logoFilePath)) {
          imageBuffer = fs.readFileSync(logoFilePath);
          // Detect mime type from file extension
          if (logoImage.endsWith('.jpg') || logoImage.endsWith('.jpeg')) {
            mimeType = 'image/jpeg';
          } else if (logoImage.endsWith('.webp')) {
            mimeType = 'image/webp';
          } else if (logoImage.endsWith('.gif')) {
            mimeType = 'image/gif';
          } else if (logoImage.endsWith('.png')) {
            mimeType = 'image/png';
          }
          console.log(`✅ Read logo file for color extraction: ${logoFilePath} (${imageBuffer.length} bytes, ${mimeType})`);
        } else {
          throw new Error(`Logo file not found at: ${logoFilePath}`);
        }
      } else if (logoImage.startsWith('http://') || logoImage.startsWith('https://')) {
        // Download image from absolute URL
        const response = await axios.get(logoImage, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data);
        
        // Detect mime type from URL or response headers
        if (logoImage.endsWith('.jpg') || logoImage.endsWith('.jpeg')) {
          mimeType = 'image/jpeg';
        } else if (logoImage.endsWith('.webp')) {
          mimeType = 'image/webp';
        } else if (logoImage.endsWith('.gif')) {
          mimeType = 'image/gif';
        } else if (logoImage.endsWith('.png')) {
          mimeType = 'image/png';
        }
      } else {
        throw new Error(`Invalid logo path: ${logoImage}. Must be a relative path (/uploads/...), absolute URL (http://...), or Buffer.`);
      }
    } else {
      // Assume it's a Buffer
      imageBuffer = logoImage;
      mimeType = 'image/png'; // Default for buffer
    }

    // Convert to PNG if needed (Gemini works best with PNG/JPEG)
    // Only convert if sharp is available, otherwise use original format
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
      if (sharp) {
        try {
          imageBuffer = await sharp(imageBuffer).png().toBuffer();
          mimeType = 'image/png';
        } catch (error) {
          console.warn('Failed to convert image format with sharp, using original format:', error.message);
          // Continue with original format - Gemini can often handle it
        }
      } else {
        console.warn('Sharp not available - using original image format. Gemini may still process it.');
        // Continue with original format - Gemini can handle many formats
      }
    }

    // Use Gemini 1.5 Pro Vision for image analysis
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    const prompt = `
Analyze this logo image and extract brand colors. Return ONLY a valid JSON object with no markdown formatting.

Extract:
1. Primary brand color (most dominant/main color in the logo)
2. Secondary color (second most prominent color, if present)
3. Accent color (highlight/emphasis color, if present)
4. Background color preference (light or dark based on logo style)

Also analyze the overall style and suggest if the brand is:
- Modern/Contemporary
- Classic/Traditional
- Minimalist
- Bold/Vibrant

Return JSON format:
{
  "primary": "#HEX_CODE",
  "secondary": "#HEX_CODE or null",
  "accent": "#HEX_CODE or null",
  "background_preference": "light" or "dark",
  "style": "modern" | "classic" | "minimalist" | "bold",
  "confidence": 0.0-1.0
}

Important: Return ONLY the JSON object, no explanations, no markdown code blocks.
`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: mimeType
        }
      }
    ]);

    const responseText = result.response.text();
    
    // Clean response (remove markdown code blocks if present)
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/g, '');
    }
    
    const extractedColors = JSON.parse(cleanedText);

    // Validate hex colors
    const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
    if (extractedColors.primary && !hexColorRegex.test(extractedColors.primary)) {
      throw new Error('Invalid primary color format');
    }
    if (extractedColors.secondary && !hexColorRegex.test(extractedColors.secondary)) {
      extractedColors.secondary = null;
    }
    if (extractedColors.accent && !hexColorRegex.test(extractedColors.accent)) {
      extractedColors.accent = null;
    }

    return {
      primary: extractedColors.primary || '#000000',
      secondary: extractedColors.secondary || null,
      accent: extractedColors.accent || null,
      background_preference: extractedColors.background_preference || 'light',
      style: extractedColors.style || 'modern',
      confidence: extractedColors.confidence || 0.8,
      extracted_at: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error extracting colors from logo:', error);
    
    // Return default colors if extraction fails
    return {
      primary: '#2563EB',
      secondary: null,
      accent: null,
      background_preference: 'light',
      style: 'modern',
      confidence: 0,
      error: error.message,
      extracted_at: new Date().toISOString()
    };
  }
}

/**
 * Generate full color palette from extracted colors
 * @param {Object} extractedColors - Colors extracted from logo
 * @returns {Promise<Object>} Complete color palette
 */
async function generateColorPalette(extractedColors) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    const prompt = `
Given these brand colors extracted from a logo:
- Primary: ${extractedColors.primary}
- Secondary: ${extractedColors.secondary || 'none'}
- Accent: ${extractedColors.accent || 'none'}
- Style: ${extractedColors.style}
- Background preference: ${extractedColors.background_preference}

Generate a complete, professional invoice color palette that:
1. Uses the primary color as the main brand color
2. Creates 2-3 complementary colors that harmonize with the primary
3. Ensures excellent contrast for text readability (WCAG AA compliant)
4. Suggests an accent color for highlights and important elements
5. Recommends appropriate background color (light or dark)
6. Suggests border/subtle colors for tables and dividers
7. Follows color theory principles (complementary, analogous, or triadic)

Return ONLY a valid JSON object:
{
  "primary": "#HEX",
  "secondary": "#HEX",
  "accent": "#HEX",
  "text": "#HEX",
  "background": "#HEX",
  "border": "#HEX",
  "table_header": "#HEX",
  "table_row_alt": "#HEX",
  "palette_type": "complementary" | "analogous" | "triadic" | "monochromatic",
  "contrast_ratio": "AA" | "AAA"
}

Important: 
- Ensure text color has at least 4.5:1 contrast with background
- Use the primary color intelligently (not overwhelming)
- Return ONLY the JSON object, no markdown, no explanations.
`;

    const result = await model.generateContent([prompt]);
    const responseText = result.response.text();
    
    // Clean response
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/g, '');
    }
    
    const palette = JSON.parse(cleanedText);

    // Validate and set defaults
    const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
    
    return {
      primary: hexColorRegex.test(palette.primary) ? palette.primary : extractedColors.primary,
      secondary: hexColorRegex.test(palette.secondary) ? palette.secondary : (extractedColors.secondary || '#64748B'),
      accent: hexColorRegex.test(palette.accent) ? palette.accent : (extractedColors.accent || '#F59E0B'),
      text: hexColorRegex.test(palette.text) ? palette.text : (extractedColors.background_preference === 'dark' ? '#FFFFFF' : '#1F2937'),
      background: hexColorRegex.test(palette.background) ? palette.background : (extractedColors.background_preference === 'dark' ? '#111827' : '#FFFFFF'),
      border: hexColorRegex.test(palette.border) ? palette.border : '#E5E7EB',
      table_header: hexColorRegex.test(palette.table_header) ? palette.table_header : palette.primary || extractedColors.primary,
      table_row_alt: hexColorRegex.test(palette.table_row_alt) ? palette.table_row_alt : '#F9FAFB',
      palette_type: palette.palette_type || 'complementary',
      contrast_ratio: palette.contrast_ratio || 'AA',
      generated_at: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error generating color palette:', error);
    
    // Return default palette based on extracted colors
    const isDark = extractedColors.background_preference === 'dark';
    
    return {
      primary: extractedColors.primary || '#2563EB',
      secondary: extractedColors.secondary || '#64748B',
      accent: extractedColors.accent || '#F59E0B',
      text: isDark ? '#FFFFFF' : '#1F2937',
      background: isDark ? '#111827' : '#FFFFFF',
      border: isDark ? '#374151' : '#E5E7EB',
      table_header: extractedColors.primary || '#2563EB',
      table_row_alt: isDark ? '#1F2937' : '#F9FAFB',
      palette_type: 'complementary',
      contrast_ratio: 'AA',
      error: error.message,
      generated_at: new Date().toISOString()
    };
  }
}

module.exports = {
  extractColorsFromLogo,
  generateColorPalette
};


