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
  
  // Return single default template
  return [{
    id: 'default',
    name: 'Default Invoice',
    description: 'Clean, professional invoice template',
    source: 'default_template',
    generated_at: new Date().toISOString()
  }];
}

module.exports = {
  generateTemplateOptions
};
