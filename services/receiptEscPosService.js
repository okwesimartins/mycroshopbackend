/**
 * ESC/POS Command Generation Service
 * Converts receipt data to ESC/POS commands for thermal printers
 */

const { generateStampImage, convertImageToEscPos } = require('./receiptStampService');

/**
 * Generate ESC/POS commands for receipt
 * @param {Object} receiptData - Receipt data
 * @param {Object} options - Options for stamp and formatting
 * @returns {Promise<Buffer>} - ESC/POS commands as buffer
 */
async function generateEscPosReceipt(receiptData, options = {}) {
  const {
    includeStamp = true,
    stampStyle = 'rectangular',
    maxWidth = 200 // 80mm paper width
  } = options;

  const commands = [];

  // Initialize printer
  commands.push(Buffer.from([0x1B, 0x40])); // ESC @ (Initialize)

  // Center align for header
  commands.push(Buffer.from([0x1B, 0x61, 0x01])); // ESC a 1 (Center)

  // Double size for header
  commands.push(Buffer.from([0x1D, 0x21, 0x11])); // GS ! 17 (Double width + height)
  commands.push(Buffer.from('RECEIPT\n', 'ascii'));

  // Reset formatting
  commands.push(Buffer.from([0x1D, 0x21, 0x00])); // GS ! 0 (Normal size)
  commands.push(Buffer.from([0x1B, 0x61, 0x00])); // ESC a 0 (Left align)

  // Company name (optional - only if provided and includeCompanyName is true)
  if (includeCompanyName && receiptData.company_name) {
    commands.push(Buffer.from(`${receiptData.company_name}\n`, 'ascii'));
  }
  commands.push(Buffer.from('─'.repeat(32) + '\n', 'ascii'));

  // Receipt number
  const receiptNumber = receiptData.receipt_number || 'RCP-001';
  commands.push(Buffer.from(`Receipt #: ${receiptNumber}\n`, 'ascii'));

  // Date and time
  const date = receiptData.transaction_date || new Date().toLocaleDateString();
  const time = receiptData.transaction_time || new Date().toLocaleTimeString();
  commands.push(Buffer.from(`Date: ${date}\n`, 'ascii'));
  commands.push(Buffer.from(`Time: ${time}\n`, 'ascii'));
  commands.push(Buffer.from('\n', 'ascii'));

  // Items header
  commands.push(Buffer.from('─'.repeat(32) + '\n', 'ascii'));
  commands.push(Buffer.from('Item                    Qty  Price  Total\n', 'ascii'));
  commands.push(Buffer.from('─'.repeat(32) + '\n', 'ascii'));

  // Items
  if (receiptData.items && receiptData.items.length > 0) {
    receiptData.items.forEach(item => {
      const itemName = (item.item_name || item.name || '').substring(0, 20).padEnd(20);
      const quantity = String(Number(item.quantity || 0)).padStart(3);
      const price = formatCurrency(item.unit_price || item.price || 0, receiptData.currency || 'USD').padStart(6);
      const total = formatCurrency(item.total || (Number(item.quantity || 0) * Number(item.unit_price || item.price || 0)), receiptData.currency || 'USD').padStart(7);
      
      commands.push(Buffer.from(`${itemName} ${quantity} ${price} ${total}\n`, 'ascii'));
    });
  }

  commands.push(Buffer.from('─'.repeat(32) + '\n', 'ascii'));
  commands.push(Buffer.from('\n', 'ascii'));

  // Totals
  const currency = receiptData.currency_symbol || getCurrencySymbol(receiptData.currency || 'USD');
  
  if (receiptData.subtotal > 0) {
    const subtotal = formatCurrency(receiptData.subtotal, receiptData.currency || 'USD');
    commands.push(Buffer.from(`Subtotal: ${subtotal.padStart(20)}\n`, 'ascii'));
  }

  if (receiptData.discount_amount > 0) {
    const discount = formatCurrency(receiptData.discount_amount, receiptData.currency || 'USD');
    commands.push(Buffer.from(`Discount: -${discount.padStart(19)}\n`, 'ascii'));
  }

  if (receiptData.tax_amount > 0) {
    const tax = formatCurrency(receiptData.tax_amount, receiptData.currency || 'USD');
    commands.push(Buffer.from(`Tax: ${tax.padStart(23)}\n`, 'ascii'));
  }

  // Total (bold)
  commands.push(Buffer.from('─'.repeat(32) + '\n', 'ascii'));
  commands.push(Buffer.from([0x1B, 0x45, 0x01])); // ESC E 1 (Bold on)
  const total = formatCurrency(receiptData.total || 0, receiptData.currency || 'USD');
  commands.push(Buffer.from(`TOTAL: ${total.padStart(20)}\n`, 'ascii'));
  commands.push(Buffer.from([0x1B, 0x45, 0x00])); // ESC E 0 (Bold off)
  commands.push(Buffer.from('\n', 'ascii'));

  // Payment method
  const paymentMethod = receiptData.payment_method || 'Cash';
  commands.push(Buffer.from(`Payment: ${paymentMethod}\n`, 'ascii'));
  commands.push(Buffer.from('\n', 'ascii'));

  // Digital Stamp (optional - can be disabled for simple receipts)
  const companyName = receiptData.company_name || '';
  if (includeStamp && companyName) {
    try {
      // Generate stamp image
      const stampImage = await generateStampImage({
        companyName: companyName,
        style: stampStyle,
        width: maxWidth,
        height: 60,
        primaryColor: receiptData.primary_color || '#2563EB',
        borderColor: '#000000',
        textColor: '#000000'
      });

      if (stampImage) {
        // Convert to ESC/POS bitmap
        const stampEscPos = await convertImageToEscPos(stampImage, maxWidth);
        
        // Center the stamp
        commands.push(Buffer.from([0x1B, 0x61, 0x01])); // Center align
        commands.push(Buffer.from('\n', 'ascii'));
        
        // Add stamp bitmap
        commands.push(stampEscPos);
        
        // Reset alignment
        commands.push(Buffer.from([0x1B, 0x61, 0x00])); // Left align
        commands.push(Buffer.from('\n', 'ascii'));
      } else {
        // Fallback: Text-based stamp
        commands.push(generateTextStamp(companyName));
      }
    } catch (error) {
      console.error('Error generating stamp for ESC/POS:', error);
      // Fallback: Text-based stamp
      commands.push(generateTextStamp(companyName));
    }
  }

  // Footer
  commands.push(Buffer.from('\n', 'ascii'));
  commands.push(Buffer.from([0x1B, 0x61, 0x01])); // Center align
  commands.push(Buffer.from('Thank you for your business!\n', 'ascii'));
  commands.push(Buffer.from([0x1B, 0x61, 0x00])); // Left align
  commands.push(Buffer.from('\n', 'ascii'));

  // Cut paper
  commands.push(Buffer.from([0x1D, 0x56, 0x00])); // GS V 0 (Cut paper)

  return Buffer.concat(commands);
}

/**
 * Generate text-based stamp (fallback)
 */
function generateTextStamp(companyName) {
  const commands = [];
  
  // Center align
  commands.push(Buffer.from([0x1B, 0x61, 0x01])); // Center
  
  // Draw border with characters
  commands.push(Buffer.from('┌────────────────────────┐\n', 'ascii'));
  commands.push(Buffer.from('│                        │\n', 'ascii'));
  
  // Company name (bold, double size)
  commands.push(Buffer.from([0x1D, 0x21, 0x11])); // Double size
  commands.push(Buffer.from([0x1B, 0x45, 0x01])); // Bold on
  const namePadding = Math.floor((24 - companyName.length) / 2);
  const paddedName = ' '.repeat(namePadding) + companyName.substring(0, 24) + ' '.repeat(24 - companyName.length - namePadding);
  commands.push(Buffer.from(`│${paddedName}│\n`, 'ascii'));
  commands.push(Buffer.from([0x1B, 0x45, 0x00])); // Bold off
  commands.push(Buffer.from([0x1D, 0x21, 0x00])); // Normal size
  
  commands.push(Buffer.from('│                        │\n', 'ascii'));
  commands.push(Buffer.from('│        PAID            │\n', 'ascii'));
  commands.push(Buffer.from('│                        │\n', 'ascii'));
  const date = new Date().toLocaleDateString();
  const datePadding = Math.floor((24 - date.length) / 2);
  const paddedDate = ' '.repeat(datePadding) + date + ' '.repeat(24 - date.length - datePadding);
  commands.push(Buffer.from(`│${paddedDate}│\n`, 'ascii'));
  commands.push(Buffer.from('└────────────────────────┘\n', 'ascii'));
  
  // Reset alignment
  commands.push(Buffer.from([0x1B, 0x61, 0x00])); // Left align
  
  return Buffer.concat(commands);
}

/**
 * Format currency value
 */
function formatCurrency(amount, currency = 'USD') {
  const symbol = getCurrencySymbol(currency);
  return `${symbol}${Number(amount).toFixed(2)}`;
}

/**
 * Get currency symbol
 */
function getCurrencySymbol(currency) {
  const symbols = {
    'USD': '$',
    'GBP': '£',
    'EUR': '€',
    'NGN': '₦',
    'CAD': 'C$',
    'AUD': 'A$',
    'JPY': '¥',
    'CNY': '¥',
    'INR': '₹',
    'ZAR': 'R'
  };
  return symbols[currency.toUpperCase()] || '$';
}

module.exports = {
  generateEscPosReceipt
};

