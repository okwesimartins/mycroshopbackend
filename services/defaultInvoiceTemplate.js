/**
 * Default Invoice Template
 * Simple, clean template that adapts to user's logo colors
 */

function escapeHtml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generate default invoice template with logo colors
 */
function generateDefaultTemplate(data) {
  const {
    invoice,
    customer = {},
    store = {},
    items = [],
    logoUrl = null,
    colors = {}
  } = data;

  // Extract colors from logo - use these throughout
  const primary = colors.primary || '#2563EB';
  const secondary = colors.secondary || '#64748B';
  const accent = colors.accent || '#F59E0B';
  const text = colors.text || '#111827';
  const background = colors.background || '#FFFFFF';
  const border = colors.border || '#E5E7EB';
  const tableHeader = colors.table_header || primary;
  const tableRowAlt = colors.table_row_alt || '#F9FAFB';

  // Business info
  const businessName = store?.name || '';
  const businessTagline = store?.description || '';
  const businessAddress = [store?.address, store?.city, store?.state, store?.country].filter(Boolean).join(', ');
  const businessEmail = store?.email || '';
  const businessPhone = store?.phone || '';

  // Customer info
  const customerName = customer?.name || '';
  const customerAddress = [customer?.address, customer?.city, customer?.state, customer?.country].filter(Boolean).join(', ');
  const customerEmail = customer?.email || '';
  const customerPhone = customer?.phone || '';

  // Invoice info
  const invoiceNumber = invoice?.invoice_number || 'INV-001';
  const issueDate = invoice?.issue_date || '';
  const dueDate = invoice?.due_date || '';
  const currency = invoice?.currency_symbol || (invoice?.currency === 'USD' ? '$' : invoice?.currency === 'GBP' ? '£' : invoice?.currency === 'EUR' ? '€' : invoice?.currency === 'NGN' ? '₦' : '$');

  // Totals
  const subtotal = Number(invoice?.subtotal || 0);
  const tax = Number(invoice?.tax_amount || 0);
  const discount = Number(invoice?.discount_amount || 0);
  const total = Number(invoice?.total || 0);

  // Notes
  const notes = invoice?.notes || '';

  // Generate items rows
  const itemsRows = items.map(item => {
    const itemName = escapeHtml(item.item_name || item.name || '');
    const quantity = Number(item.quantity || 0);
    const price = Number(item.unit_price || item.price || 0);
    const itemTotal = Number(item.total || (quantity * price));
    
    return `
      <tr>
        <td>${itemName}</td>
        <td style="text-align: center;">${quantity.toLocaleString()}</td>
        <td style="text-align: right;">${currency} ${price.toFixed(2)}</td>
        <td style="text-align: right; font-weight: 600;">${currency} ${itemTotal.toFixed(2)}</td>
      </tr>
    `;
  }).join('');

  // Logo HTML
  const logoHtml = logoUrl 
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" style="max-width: 150px; max-height: 80px; object-fit: contain;" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${escapeHtml(invoiceNumber)}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      color: ${text};
      background: #f5f5f5;
      padding: 40px 20px;
      line-height: 1.6;
    }

    .invoice-container {
      max-width: 800px;
      margin: 0 auto;
      background: ${background};
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 40px;
      padding-bottom: 30px;
      border-bottom: 2px solid ${border};
    }

    .logo-section {
      flex: 1;
    }

    .logo-section img {
      margin-bottom: 10px;
    }

    .business-name {
      font-size: 24px;
      font-weight: 700;
      color: ${primary};
      margin-bottom: 5px;
    }

    .business-tagline {
      font-size: 14px;
      color: ${secondary};
      margin-bottom: 10px;
    }

    .business-info {
      font-size: 12px;
      color: ${text};
      line-height: 1.8;
    }

    .invoice-info {
      text-align: right;
    }

    .invoice-title {
      font-size: 32px;
      font-weight: 800;
      color: ${primary};
      margin-bottom: 20px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .invoice-details {
      font-size: 13px;
      color: ${text};
      line-height: 2;
    }

    .invoice-details strong {
      color: ${primary};
    }

    /* Customer Section */
    .customer-section {
      margin-bottom: 40px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 700;
      color: ${primary};
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 15px;
    }

    .customer-info {
      background: ${tableRowAlt};
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid ${primary};
    }

    .customer-info p {
      margin: 5px 0;
      font-size: 14px;
      color: ${text};
    }

    /* Items Table */
    .items-section {
      margin-bottom: 30px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }

    thead {
      background: ${tableHeader};
      color: #ffffff;
    }

    thead th {
      padding: 15px;
      text-align: left;
      font-weight: 600;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    thead th:nth-child(2),
    thead th:nth-child(3),
    thead th:nth-child(4) {
      text-align: right;
    }

    tbody tr {
      border-bottom: 1px solid ${border};
    }

    tbody tr:nth-child(even) {
      background: ${tableRowAlt};
    }

    tbody td {
      padding: 15px;
      font-size: 14px;
      color: ${text};
    }

    /* Totals Section */
    .totals-section {
      margin-top: 30px;
      margin-left: auto;
      width: 100%;
      max-width: 350px;
    }

    .totals-row {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid ${border};
      font-size: 14px;
    }

    .totals-row:last-child {
      border-bottom: none;
    }

    .totals-label {
      color: ${text};
      font-weight: 500;
    }

    .totals-value {
      color: ${text};
      font-weight: 600;
    }

    .total-row {
      margin-top: 10px;
      padding-top: 15px;
      border-top: 2px solid ${primary};
      font-size: 18px;
      font-weight: 700;
    }

    .total-row .totals-label {
      color: ${primary};
      font-size: 18px;
    }

    .total-row .totals-value {
      color: ${primary};
      font-size: 20px;
    }

    /* Notes Section */
    .notes-section {
      margin-top: 40px;
      padding-top: 30px;
      border-top: 1px solid ${border};
    }

    .notes-content {
      font-size: 13px;
      color: ${secondary};
      line-height: 1.8;
      white-space: pre-line;
    }

    /* Footer */
    .footer {
      margin-top: 40px;
      padding-top: 30px;
      border-top: 1px solid ${border};
      text-align: center;
      font-size: 12px;
      color: ${secondary};
    }

    /* Print Styles */
    @media print {
      body {
        background: white;
        padding: 0;
      }

      .invoice-container {
        box-shadow: none;
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="invoice-container">
    <!-- Header -->
    <div class="header">
      <div class="logo-section">
        ${logoHtml}
        ${businessName ? `<div class="business-name">${escapeHtml(businessName)}</div>` : ''}
        ${businessTagline ? `<div class="business-tagline">${escapeHtml(businessTagline)}</div>` : ''}
        ${(businessAddress || businessEmail || businessPhone) ? `<div class="business-info">
          ${businessAddress ? `<div>${escapeHtml(businessAddress)}</div>` : ''}
          ${businessEmail ? `<div>${escapeHtml(businessEmail)}</div>` : ''}
          ${businessPhone ? `<div>${escapeHtml(businessPhone)}</div>` : ''}
        </div>` : ''}
      </div>
      <div class="invoice-info">
        <div class="invoice-title">Invoice</div>
        <div class="invoice-details">
          ${invoiceNumber ? `<div><strong>Invoice #:</strong> ${escapeHtml(invoiceNumber)}</div>` : ''}
          ${issueDate ? `<div><strong>Issue Date:</strong> ${escapeHtml(issueDate)}</div>` : ''}
          ${dueDate ? `<div><strong>Due Date:</strong> ${escapeHtml(dueDate)}</div>` : ''}
        </div>
      </div>
    </div>

    <!-- Customer Section -->
    ${customerName || customerAddress || customerEmail || customerPhone ? `
    <div class="customer-section">
      <div class="section-title">Bill To</div>
      <div class="customer-info">
        ${customerName ? `<p style="font-weight: 600; margin-bottom: 8px;">${escapeHtml(customerName)}</p>` : ''}
        ${customerAddress ? `<p>${escapeHtml(customerAddress)}</p>` : ''}
        ${customerEmail ? `<p>${escapeHtml(customerEmail)}</p>` : ''}
        ${customerPhone ? `<p>${escapeHtml(customerPhone)}</p>` : ''}
      </div>
    </div>
    ` : ''}

    <!-- Items Table -->
    <div class="items-section">
      <div class="section-title">Items</div>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Quantity</th>
            <th>Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>
    </div>

    <!-- Totals Section -->
    <div class="totals-section">
      ${subtotal > 0 ? `<div class="totals-row">
        <span class="totals-label">Subtotal</span>
        <span class="totals-value">${currency} ${subtotal.toFixed(2)}</span>
      </div>` : ''}
      ${discount > 0 ? `<div class="totals-row">
        <span class="totals-label">Discount</span>
        <span class="totals-value">-${currency} ${discount.toFixed(2)}</span>
      </div>` : ''}
      ${tax > 0 ? `<div class="totals-row">
        <span class="totals-label">Tax</span>
        <span class="totals-value">${currency} ${tax.toFixed(2)}</span>
      </div>` : ''}
      <div class="totals-row total-row">
        <span class="totals-label">Total</span>
        <span class="totals-value">${currency} ${total.toFixed(2)}</span>
      </div>
    </div>

    <!-- Notes Section -->
    ${notes ? `
    <div class="notes-section">
      <div class="section-title">Notes</div>
      <div class="notes-content">${escapeHtml(notes)}</div>
    </div>
    ` : ''}

    <!-- Footer -->
    <div class="footer">
      <p>Thank you for your business!</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  generateDefaultTemplate
};

