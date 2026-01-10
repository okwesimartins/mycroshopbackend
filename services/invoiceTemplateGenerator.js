const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateTemplateLibrary } = require('./invoiceTemplateLibrary');

// Initialize Gemini AI (used for logo color extraction, not template generation)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Generate invoice template options from template library
 * Templates are pre-designed and colors are dynamically applied based on user's logo
 * 
 * @param {Object} invoiceData - Invoice data (not used for template library, kept for API consistency)
 * @param {Object} brandColors - Brand color palette extracted from user's logo
 * @returns {Promise<Array>} Array of template JSON objects
 */
async function generateTemplateOptions(invoiceData, brandColors) {
  // Use beautiful pre-designed template library as primary source
  console.log('🎨 Using template library with beautiful pre-designed templates');
  const libraryTemplates = generateTemplateLibrary(brandColors);
  console.log(`✅ Loaded ${libraryTemplates.length} beautiful templates from library`);
  return libraryTemplates;
}

module.exports = {
  generateTemplateOptions
};
