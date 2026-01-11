const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getAvailableTemplates } = require('./invoiceHtmlTemplates');
const { generateAITemplateOptions } = require('./aiInvoiceTemplateGenerator');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Generate invoice template options - uses AI to create beautiful, dynamic templates
 * 
 * @param {Object} invoiceData - Invoice data for AI generation
 * @param {Object} brandColors - Brand color palette extracted from user's logo
 * @returns {Promise<Array>} Array of template metadata objects with AI-generated HTML
 */
async function generateTemplateOptions(invoiceData, brandColors) {
  try {
    console.log('🤖 Generating beautiful AI-powered invoice templates...');
    
    // Use AI to generate beautiful, dynamic templates
    const aiTemplates = await generateAITemplateOptions(invoiceData, brandColors);
    
    if (aiTemplates && aiTemplates.length > 0) {
      console.log(`✅ Generated ${aiTemplates.length} AI-powered templates`);
      return aiTemplates;
    }
    
    // Fallback to static templates if AI generation fails
    console.log('⚠️ AI generation failed, falling back to static templates');
    const templates = getAvailableTemplates();
    return templates.map(template => ({
      id: template.id,
      name: template.name,
      description: template.description,
      source: 'html_template_library',
      generated_at: new Date().toISOString()
    }));
  } catch (error) {
    console.error('Error generating AI templates, using fallback:', error);
    // Fallback to static templates
    const templates = getAvailableTemplates();
    return templates.map(template => ({
      id: template.id,
      name: template.name,
      description: template.description,
      source: 'html_template_library',
      generated_at: new Date().toISOString()
    }));
  }
}

module.exports = {
  generateTemplateOptions
};
