const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getAvailableTemplates } = require('./invoiceHtmlTemplates');

// Initialize Gemini AI (used for logo color extraction, not template generation)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Generate invoice template options - returns template metadata
 * Templates are HTML/CSS templates with inline styles
 * 
 * @param {Object} invoiceData - Invoice data (not used, kept for API consistency)
 * @param {Object} brandColors - Brand color palette extracted from user's logo
 * @returns {Promise<Array>} Array of template metadata objects
 */
async function generateTemplateOptions(invoiceData, brandColors) {
  // Get available HTML templates
  console.log('🎨 Using HTML/CSS template library');
  const templates = getAvailableTemplates();
  console.log(`✅ Loaded ${templates.length} HTML templates from library`);
  
  // Return template metadata (the actual HTML will be generated when rendering)
  return templates.map(template => ({
    id: template.id,
    name: template.name,
    description: template.description,
    source: 'html_template_library',
    generated_at: new Date().toISOString()
  }));
}

module.exports = {
  generateTemplateOptions
};
