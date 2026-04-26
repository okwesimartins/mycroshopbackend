const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const axios = require('axios');

// Sharp is optional — used for pixel-level color extraction (most reliable method)
let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  console.warn('Sharp not available — pixel color extraction disabled. Install with: npm install sharp');
}

/**
 * Convert RGB to HSL
 */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract dominant brand colors directly from logo pixels using sharp.
 * This is deterministic and accurate — no AI involved.
 * Strategy:
 *   1. Resize to 80×80 thumbnail (speed)
 *   2. Sample every pixel
 *   3. Discard near-black, near-white, near-gray (backgrounds/shadows)
 *   4. Bucket remaining colored pixels into 12 hue segments
 *   5. Return the two most populated saturated colors
 */
async function extractColorsFromLogoPixels(imageBuffer) {
  if (!sharp) throw new Error('sharp not available');

  const { data } = await sharp(imageBuffer)
    .resize(80, 80, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = {}; // hue segment → { count, rSum, gSum, bSum }

  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const { h, s, l } = rgbToHsl(r, g, b);

    // Skip near-white (l > 90%), near-black (l < 8%), near-gray (s < 18%)
    if (l > 90 || l < 8 || s < 18) continue;

    const bucket = Math.floor(h / 30); // 12 buckets of 30° each
    if (!buckets[bucket]) buckets[bucket] = { count: 0, rSum: 0, gSum: 0, bSum: 0 };
    buckets[bucket].count++;
    buckets[bucket].rSum += r;
    buckets[bucket].gSum += g;
    buckets[bucket].bSum += b;
  }

  const sorted = Object.values(buckets)
    .filter(b => b.count > 5)
    .sort((a, b) => b.count - a.count);

  if (sorted.length === 0) throw new Error('No saturated colors found in logo');

  const toColor = (b) => rgbToHex(
    Math.round(b.rSum / b.count),
    Math.round(b.gSum / b.count),
    Math.round(b.bSum / b.count)
  );

  return {
    primary:   toColor(sorted[0]),
    secondary: sorted[1] ? toColor(sorted[1]) : null,
    source:    'pixel_extraction'
  };
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
      mimeType = 'image/png';
    }

    // ── Priority 1: pixel-level extraction with sharp (deterministic, always accurate) ──
    if (sharp) {
      try {
        const pixelColors = await extractColorsFromLogoPixels(imageBuffer);
        console.log('✅ Pixel color extraction succeeded:', pixelColors);
        return {
          primary:               pixelColors.primary,
          secondary:             pixelColors.secondary || null,
          accent:                pixelColors.secondary || null,
          background_preference: 'light',
          style:                 'modern',
          confidence:            1.0,
          source:                'pixel_extraction',
          extracted_at:          new Date().toISOString()
        };
      } catch (pixelErr) {
        console.warn('Pixel extraction failed, falling back to Gemini:', pixelErr.message);
      }
    }

    // ── Priority 2: Gemini Vision (fallback when sharp unavailable or pixel extraction fails) ──
    // Convert to PNG/JPEG for Gemini if needed
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
      try {
        if (sharp) {
          imageBuffer = await sharp(imageBuffer).png().toBuffer();
          mimeType = 'image/png';
        }
      } catch (e) {
        console.warn('Image format conversion failed:', e.message);
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
  extractColorsFromLogoPixels,
  generateColorPalette
};


