/**
 * Digital Stamp Generation Service
 * Generates digital stamp images for receipts
 */

const sharp = require('sharp');

/**
 * Generate digital stamp image
 * @param {Object} options - Stamp options
 * @returns {Promise<Buffer>} - PNG image buffer
 */
async function generateStampImage(options = {}) {
  const {
    companyName = 'Company Name',
    style = 'rectangular', // 'rectangular' or 'circular'
    width = 200,
    height = 80,
    primaryColor = '#2563EB',
    borderColor = '#000000',
    textColor = '#000000'
  } = options;

  try {
    // Create SVG for stamp
    const svg = generateStampSVG({
      companyName,
      style,
      width,
      height,
      primaryColor,
      borderColor,
      textColor
    });

    // Convert SVG to PNG using sharp
    const imageBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    return imageBuffer;
  } catch (error) {
    console.error('Error generating stamp image:', error);
    // Fallback: return simple text-based stamp
    return generateTextStamp(companyName, width, height);
  }
}

/**
 * Generate SVG for stamp
 */
function generateStampSVG(options) {
  const {
    companyName,
    style,
    width,
    height,
    primaryColor,
    borderColor,
    textColor
  } = options;

  const date = new Date().toLocaleDateString();
  const fontSize = Math.max(12, Math.min(16, width / companyName.length * 0.8));
  const statusFontSize = fontSize * 1.2;

  if (style === 'circular') {
    const radius = Math.min(width, height) / 2 - 5;
    const centerX = width / 2;
    const centerY = height / 2;

    return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${centerX}" cy="${centerY}" r="${radius}" 
                fill="white" stroke="${borderColor}" stroke-width="3"/>
        <text x="${centerX}" y="${centerY - 8}" 
              text-anchor="middle" 
              font-family="Arial, sans-serif" 
              font-size="${fontSize}" 
              font-weight="bold" 
              fill="${textColor}">
          ${escapeXml(companyName)}
        </text>
        <text x="${centerX}" y="${centerY + 12}" 
              text-anchor="middle" 
              font-family="Arial, sans-serif" 
              font-size="${statusFontSize}" 
              font-weight="bold" 
              fill="${primaryColor}">
          PAID
        </text>
        <text x="${centerX}" y="${centerY + 28}" 
              text-anchor="middle" 
              font-family="Arial, sans-serif" 
              font-size="10" 
              fill="${textColor}">
          ${date}
        </text>
      </svg>
    `;
  } else {
    // Rectangular stamp
    return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="5" width="${width - 10}" height="${height - 10}" 
              fill="white" stroke="${borderColor}" stroke-width="3" rx="5"/>
        <text x="${width / 2}" y="${height / 2 - 15}" 
              text-anchor="middle" 
              font-family="Arial, sans-serif" 
              font-size="${fontSize}" 
              font-weight="bold" 
              fill="${textColor}">
          ${escapeXml(companyName)}
        </text>
        <text x="${width / 2}" y="${height / 2 + 5}" 
              text-anchor="middle" 
              font-family="Arial, sans-serif" 
              font-size="${statusFontSize}" 
              font-weight="bold" 
              fill="${primaryColor}">
          PAID
        </text>
        <text x="${width / 2}" y="${height / 2 + 25}" 
              text-anchor="middle" 
              font-family="Arial, sans-serif" 
              font-size="10" 
              fill="${textColor}">
          ${date}
        </text>
      </svg>
    `;
  }
}

/**
 * Generate simple text-based stamp (fallback)
 */
function generateTextStamp(companyName, width, height) {
  // For now, return null - will be handled in ESC/POS generation
  return null;
}

/**
 * Escape XML/SVG special characters
 */
function escapeXml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert image buffer to ESC/POS bitmap format
 * @param {Buffer} imageBuffer - PNG image buffer
 * @param {number} maxWidth - Maximum width in pixels (typically 200-300 for 80mm paper)
 * @returns {Promise<Buffer>} - ESC/POS bitmap commands
 */
async function convertImageToEscPos(imageBuffer, maxWidth = 200) {
  try {
    // Resize, convert to grayscale, and threshold
    const processedImage = await sharp(imageBuffer)
      .resize(maxWidth, null, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .greyscale()
      .threshold(128) // Convert to 1-bit (black/white)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = processedImage;
    const imageWidth = info.width;
    const imageHeight = info.height;

    // Convert to ESC/POS bitmap format
    return convertToEscPosBitmap(data, imageWidth, imageHeight);
  } catch (error) {
    console.error('Error converting image to ESC/POS:', error);
    throw error;
  }
}

/**
 * Convert raw image data to ESC/POS bitmap commands
 * @param {Buffer} imageData - Raw 1-bit image data
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @returns {Buffer} - ESC/POS bitmap commands
 */
function convertToEscPosBitmap(imageData, width, height) {
  const commands = [];

  // Calculate bytes per line (width in pixels / 8 bits per byte)
  const bytesPerLine = Math.ceil(width / 8);

  // ESC/POS command: GS v 0 (Print raster bit image)
  // Format: GS v 0 [xL xH yL yH] [d1...dk]
  commands.push(Buffer.from([0x1D, 0x76, 0x30, 0x00])); // GS v 0

  // Image width (low byte, high byte)
  const widthLow = bytesPerLine & 0xFF;
  const widthHigh = (bytesPerLine >> 8) & 0xFF;

  // Image height (low byte, high byte)
  const heightLow = height & 0xFF;
  const heightHigh = (height >> 8) & 0xFF;

  commands.push(Buffer.from([widthLow, widthHigh, heightLow, heightHigh]));

  // Convert image data to 1-bit per pixel, packed into bytes
  const bitmapData = Buffer.alloc(bytesPerLine * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const pixelValue = imageData[pixelIndex];

      // If pixel is dark (value < 128), set bit to 1
      if (pixelValue < 128) {
        const byteIndex = Math.floor(x / 8);
        const bitIndex = 7 - (x % 8);
        bitmapData[y * bytesPerLine + byteIndex] |= (1 << bitIndex);
      }
    }
  }

  commands.push(bitmapData);

  return Buffer.concat(commands);
}

module.exports = {
  generateStampImage,
  convertImageToEscPos,
  convertToEscPosBitmap
};

