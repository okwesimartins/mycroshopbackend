/**
 * Receipt Template Service
 * Generates receipt HTML template (for PDF/preview)
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
 * Generate receipt HTML template
 */
function generateReceiptTemplate(data) {
  const {
    receipt,
    store = {},
    items = [],
    logoUrl = null,
    colors = {},
    digitalStamp = null
  } = data;

  // Extract colors from logo
  const primary = colors.primary || '#2563EB';
  const secondary = colors.secondary || '#64748B';
  const text = colors.text || '#111827';
  const border = colors.border || '#E5E7EB';

  // Business info
  const businessName = store?.name || 'Business Name';
  const businessAddress = [store?.address, store?.city, store?.state, store?.country].filter(Boolean).join(', ');
  const businessPhone = store?.phone || '';
  const businessEmail = store?.email || '';

  // Receipt info
  const receiptNumber = receipt?.receipt_number || 'RCP-001';
  const transactionDate = receipt?.transaction_date || new Date().toLocaleDateString();
  const transactionTime = receipt?.transaction_time || new Date().toLocaleTimeString();
  const currency = receipt?.currency_symbol || (receipt?.currency === 'USD' ? '$' : receipt?.currency === 'GBP' ? '£' : receipt?.currency === 'EUR' ? '€' : receipt?.currency === 'NGN' ? '₦' : '$');

  // Totals
  const subtotal = Number(receipt?.subtotal || 0);
  const tax = Number(receipt?.tax_amount || 0);
  const discount = Number(receipt?.discount_amount || 0);
  const total = Number(receipt?.total || 0);
  const paymentMethod = receipt?.payment_method || 'Cash';

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
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" style="max-width: 120px; max-height: 60px; object-fit: contain;" />`
    : '';

  // Digital stamp HTML (if provided)
  const stampHtml = digitalStamp 
    ? `<div class="stamp-container">
        <div class="stamp">
          <div class="stamp-company">${escapeHtml(digitalStamp.company_name || businessName)}</div>
          <div class="stamp-status">PAID</div>
          <div class="stamp-date">${new Date().toLocaleDateString()}</div>
        </div>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipt ${escapeHtml(receiptNumber)}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Courier New', monospace;
      color: ${text};
      background: #ffffff;
      padding: 20px;
      line-height: 1.4;
      font-size: 12px;
    }

    .receipt-container {
      max-width: 300px;
      margin: 0 auto;
      background: #ffffff;
      padding: 20px;
      border: 1px solid ${border};
    }

    /* Header */
    .header {
      text-align: center;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px dashed ${border};
    }

    .logo-section img {
      margin-bottom: 10px;
      max-width: 120px;
      max-height: 60px;
    }

    .business-name {
      font-size: 16px;
      font-weight: 700;
      color: ${primary};
      margin-bottom: 5px;
      text-transform: uppercase;
    }

    .business-info {
      font-size: 10px;
      color: ${secondary};
      line-height: 1.6;
    }

    /* Receipt Info */
    .receipt-info {
      margin-bottom: 15px;
      padding-bottom: 15px;
      border-bottom: 1px dashed ${border};
    }

    .receipt-info-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 5px;
      font-size: 11px;
    }

    .receipt-info-label {
      font-weight: 600;
      color: ${text};
    }

    .receipt-info-value {
      color: ${text};
    }

    /* Items Table */
    .items-section {
      margin-bottom: 15px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }

    thead {
      border-bottom: 2px solid ${primary};
    }

    thead th {
      padding: 8px 5px;
      text-align: left;
      font-weight: 700;
      font-size: 10px;
      text-transform: uppercase;
      color: ${primary};
    }

    thead th:nth-child(2),
    thead th:nth-child(3),
    thead th:nth-child(4) {
      text-align: right;
    }

    tbody tr {
      border-bottom: 1px dotted ${border};
    }

    tbody td {
      padding: 6px 5px;
      font-size: 11px;
      color: ${text};
    }

    tbody td:first-child {
      font-weight: 500;
    }

    tbody td:last-child {
      font-weight: 600;
    }

    /* Totals */
    .totals-section {
      margin-bottom: 15px;
      padding-top: 10px;
      border-top: 2px solid ${primary};
    }

    .totals-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 5px;
      font-size: 11px;
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
      padding-top: 10px;
      border-top: 1px solid ${border};
      font-size: 14px;
      font-weight: 800;
    }

    .total-row .totals-label {
      color: ${primary};
      font-size: 14px;
    }

    .total-row .totals-value {
      color: ${primary};
      font-size: 16px;
    }

    /* Payment Method */
    .payment-section {
      margin-bottom: 15px;
      padding: 10px;
      background: ${border};
      border-radius: 4px;
    }

    .payment-method {
      font-size: 11px;
      font-weight: 600;
      color: ${primary};
    }

    /* Digital Stamp */
    .stamp-container {
      text-align: center;
      margin: 20px 0;
      padding: 15px 0;
      border-top: 2px dashed ${border};
    }

    .stamp {
      display: inline-block;
      padding: 15px 25px;
      border: 3px solid ${primary};
      border-radius: 8px;
      background: #ffffff;
      text-align: center;
    }

    .stamp-company {
      font-size: 14px;
      font-weight: 700;
      color: ${primary};
      margin-bottom: 5px;
      text-transform: uppercase;
    }

    .stamp-status {
      font-size: 16px;
      font-weight: 800;
      color: ${primary};
      margin-bottom: 5px;
    }

    .stamp-date {
      font-size: 10px;
      color: ${secondary};
    }

    /* Footer */
    .footer {
      text-align: center;
      margin-top: 20px;
      padding-top: 15px;
      border-top: 1px dashed ${border};
      font-size: 10px;
      color: ${secondary};
    }

    /* Print Styles */
    @media print {
      body {
        background: white;
        padding: 0;
      }

      .receipt-container {
        border: none;
        padding: 15px;
      }
    }
  </style>
</head>
<body>
  <div class="receipt-container">
    <!-- Header -->
    <div class="header">
      ${logoHtml}
      <div class="business-name">${escapeHtml(businessName)}</div>
      ${businessAddress ? `<div class="business-info">${escapeHtml(businessAddress)}</div>` : ''}
      ${businessPhone ? `<div class="business-info">Tel: ${escapeHtml(businessPhone)}</div>` : ''}
      ${businessEmail ? `<div class="business-info">${escapeHtml(businessEmail)}</div>` : ''}
    </div>

    <!-- Receipt Info -->
    <div class="receipt-info">
      <div class="receipt-info-row">
        <span class="receipt-info-label">Receipt #:</span>
        <span class="receipt-info-value">${escapeHtml(receiptNumber)}</span>
      </div>
      <div class="receipt-info-row">
        <span class="receipt-info-label">Date:</span>
        <span class="receipt-info-value">${escapeHtml(transactionDate)}</span>
      </div>
      <div class="receipt-info-row">
        <span class="receipt-info-label">Time:</span>
        <span class="receipt-info-value">${escapeHtml(transactionTime)}</span>
      </div>
    </div>

    <!-- Items Table -->
    <div class="items-section">
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th style="text-align: right;">Qty</th>
            <th style="text-align: right;">Price</th>
            <th style="text-align: right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>
    </div>

    <!-- Totals -->
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
        <span class="totals-label">TOTAL</span>
        <span class="totals-value">${currency} ${total.toFixed(2)}</span>
      </div>
    </div>

    <!-- Payment Method -->
    <div class="payment-section">
      <div class="payment-method">Payment: ${escapeHtml(paymentMethod)}</div>
    </div>

    <!-- Digital Stamp -->
    ${stampHtml}

    <!-- Footer -->
    <div class="footer">
      <p>Thank you for your business!</p>
      <p>This is a computer-generated receipt</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  generateReceiptTemplate
};

