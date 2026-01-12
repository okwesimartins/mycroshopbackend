const { generateDefaultTemplate } = require('./defaultInvoiceTemplate');

/**
 * Generate invoice template options - returns single default template
 * 
 * @param {Object} invoiceData - Invoice data
 * @param {Object} brandColors - Brand color palette extracted from user's logo
 * @returns {Promise<Array>} Array with single default template
 */
async function generateTemplateOptions(invoiceData, brandColors) {
  console.log('📄 Using default invoice template with logo colors');
  
  // Return single default template - use consistent ID that matches what we query for
  return [{
    id: 'default_template',
    name: 'Default Professional Invoice',
    description: 'Clean, professional invoice template with dynamic branding',
    source: 'default_template',
    generated_at: new Date().toISOString()
  }];
}

module.exports = {
  generateTemplateOptions
};
