const escapeHtml = (unsafe) => {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

/**
 * Render invoice HTML from invoice data and an AI template recipe.
 * This does NOT use inline styles per element; instead it uses a small design system
 * of CSS classes plus design tokens coming from the template.
 *
 * @param {Object} options
 * @param {Object} options.invoice - Invoice instance (with Customer, Store, InvoiceItems)
 * @param {Object} options.template - AI template JSON recipe
 * @param {Object} options.brandColors - Base brand colors (fallback if tokens missing)
 * @returns {string} HTML string
 */
function renderInvoiceHtml({ invoice, template, brandColors }) {
  const tokens = {
    primary: template.tokens?.primary || brandColors.primary,
    secondary: template.tokens?.secondary || brandColors.secondary,
    accent: template.tokens?.accent || brandColors.accent,
    text: template.tokens?.text || brandColors.text,
    background: template.tokens?.background || brandColors.background,
    border: template.tokens?.border || brandColors.border,
    table_header: template.tokens?.table_header || brandColors.table_header,
    table_row_alt: template.tokens?.table_row_alt || brandColors.table_row_alt,
    font: template.tokens?.font || 'Inter',
    fontSize: template.tokens?.fontSize || '14px',
    headingSize: template.tokens?.headingSize || '24px'
  };

  const spacing = template.spacing || {
    section_gap: '32px',
    item_gap: '12px',
    padding: '32px'
  };

  const layoutMap = {};
  (template.layout || []).forEach((block) => {
    layoutMap[block.block] = block;
  });

  const decorations = Array.isArray(template.decorations)
    ? template.decorations
    : [];

  const customer = invoice.Customer || {};
  const store = invoice.Store || {};
  const items = invoice.InvoiceItems || [];

  const css = buildBaseCss(tokens, spacing);
  const decorationLayer = renderDecorations(decorations, tokens);

  // Get logo URL from invoice context (passed from controller)
  const logoUrl = invoice.logoUrl || null;
  const headerHtml = renderHeaderBlock(layoutMap.Header, { invoice, store, logoUrl });
  const customerHtml = renderCustomerBlock(layoutMap.CustomerInfo, { customer });
  const itemsHtml = renderItemsBlock(layoutMap.ItemsTable, { items, currency: '₦' });
  const totalsHtml = renderTotalsBlock(layoutMap.Totals, { invoice, currency: '₦' });
  const paymentHtml = renderPaymentBlock(layoutMap.Payment, { invoice });
  const footerHtml = renderFooterBlock(layoutMap.Footer, { invoice, store });

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Invoice ${escapeHtml(invoice.invoice_number || '')}</title>
  <style>
  ${css}
  </style>
</head>
<body>
  <div class="invoice-root">
    ${decorationLayer}
    <div class="invoice-content">
      ${headerHtml}
      ${customerHtml}
      ${itemsHtml}
      ${totalsHtml}
      ${paymentHtml}
      ${footerHtml}
    </div>
  </div>
</body>
</html>
`.trim();
}

function buildBaseCss(tokens, spacing) {
  return `
  * {
    box-sizing: border-box;
  }
  body {
    margin: 0;
    padding: 0;
    font-family: ${tokens.font}, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: ${tokens.fontSize};
    color: ${tokens.text};
    background: ${tokens.background};
  }
  .invoice-root {
    position: relative;
    width: 100%;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 24px;
  }
  .invoice-content {
    position: relative;
    width: 800px;
    max-width: 100%;
    background: #ffffff;
    border-radius: 12px;
    padding: ${spacing.padding};
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.16);
    overflow: hidden;
  }

  /* Decorations */
  .invoice-decoration-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
  }
  .invoice-decoration {
    position: absolute;
    opacity: 0.25;
  }

  /* Layout */
  .section {
    margin-bottom: ${spacing.section_gap};
    position: relative;
    z-index: 1;
  }
  .section-title {
    font-size: ${tokens.headingSize};
    font-weight: 600;
    margin-bottom: 8px;
    color: ${tokens.primary};
  }

  /* Header variants */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    border-bottom: 2px solid ${tokens.border};
    padding-bottom: 16px;
  }
  .header--centered {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .header--minimal {
    border-bottom: none;
  }
  .header-logo {
    font-size: 24px;
    font-weight: 700;
    color: ${tokens.primary};
  }
  .header-logo-img {
    max-height: 60px;
    max-width: 200px;
    object-fit: contain;
  }
  .header-meta {
    text-align: right;
    font-size: 12px;
  }

  /* Two-column layouts */
  .two-column {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: ${spacing.item_gap};
  }

  /* Customer block */
  .customer-card {
    border-radius: 10px;
    padding: 16px 18px;
    background: rgba(148, 163, 184, 0.05);
    border: 1px solid ${tokens.border};
  }
  .customer-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${tokens.secondary};
    margin-bottom: 4px;
  }
  .customer-name {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 2px;
  }
  .customer-detail {
    font-size: 13px;
    opacity: 0.8;
  }

  /* Items table */
  .items-table {
    width: 100%;
    border-collapse: collapse;
    border-radius: 10px;
    overflow: hidden;
  }
  .items-table th,
  .items-table td {
    padding: 10px 12px;
    text-align: left;
  }
  .items-table thead {
    background: ${tokens.table_header};
    color: #ffffff;
  }
  .items-table--bordered td,
  .items-table--bordered th {
    border: 1px solid ${tokens.border};
  }
  .items-table--minimal thead {
    background: transparent;
    color: ${tokens.text};
    border-bottom: 1px solid ${tokens.border};
  }
  .items-table tbody tr:nth-child(even) {
    background: ${tokens.table_row_alt};
  }
  .items-table .col-qty,
  .items-table .col-price,
  .items-table .col-total {
    text-align: right;
    white-space: nowrap;
  }

  /* Totals */
  .totals {
    display: flex;
    justify-content: flex-end;
  }
  .totals-card {
    min-width: 260px;
    border-radius: 10px;
    padding: 16px 18px;
    border: 1px solid ${tokens.border};
    background: rgba(148, 163, 184, 0.03);
  }
  .totals-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
    font-size: 13px;
  }
  .totals-row.total {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed ${tokens.border};
    font-size: 16px;
    font-weight: 600;
    color: ${tokens.primary};
  }

  /* Payment */
  .payment-box {
    border-radius: 10px;
    padding: 14px 16px;
    border: 1px dashed ${tokens.border};
    background: rgba(79, 70, 229, 0.02);
    font-size: 13px;
  }
  .payment-label {
    font-weight: 600;
    margin-bottom: 4px;
  }
  .payment-notes {
    white-space: pre-line;
  }

  /* Footer */
  .footer {
    font-size: 11px;
    color: #6b7280;
    text-align: center;
  }
  .footer--left {
    text-align: left;
  }
  `.trim();
}

function renderDecorations(decorations, tokens) {
  if (!decorations.length) {
    return '';
  }

  const colorFromToken = (tokenKey) => {
    switch (tokenKey) {
      case 'primary':
        return tokens.primary;
      case 'secondary':
        return tokens.secondary;
      case 'accent':
      default:
        return tokens.accent;
    }
  };

  const anchorToPosition = (anchor) => {
    switch (anchor) {
      case 'top-left':
        return 'top: -40px; left: -40px;';
      case 'top-right':
        return 'top: -40px; right: -40px;';
      case 'bottom-left':
        return 'bottom: -40px; left: -40px;';
      case 'bottom-right':
        return 'bottom: -40px; right: -40px;';
      case 'center':
      default:
        return 'top: 50%; left: 50%; transform: translate(-50%, -50%);';
    }
  };

  const elements = decorations.map((decoration, index) => {
    if (!decoration || !decoration.asset) return '';
    const sizeScale = decoration.scale || 1.0;
    const width = 320 * sizeScale;
    const height = 200 * sizeScale;
    const positionStyle = anchorToPosition(decoration.anchor);
    const opacity = decoration.colors?.opacity ?? 0.18;
    const fill = colorFromToken(decoration.colors?.fill || 'accent');

    // Single generic swoosh/shape that can stand in for all assets
    return `
    <svg
      class="invoice-decoration"
      style="${positionStyle} width:${width}px; height:${height}px; opacity:${opacity};"
      viewBox="0 0 320 200"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M0,160 C80,40 160,40 320,0 L320,200 L0,200 Z"
        fill="${fill}"
      />
    </svg>
    `;
  });

  return `
  <div class="invoice-decoration-layer">
    ${elements.join('\n')}
  </div>
  `.trim();
}

function renderHeaderBlock(config = {}, { invoice, store, logoUrl }) {
  const variantClass = (() => {
    switch (config.variant) {
      case 'centered':
        return 'header header--centered';
      case 'minimal':
        return 'header header--minimal';
      default:
        return 'header';
    }
  })();

  const businessName = store.name || 'Invoice';
  const storeAddress = [store.address, store.city, store.state]
    .filter(Boolean)
    .join(', ');

  // Render logo if available, otherwise use text
  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" class="header-logo-img" />`
    : `<div class="header-logo">${escapeHtml(businessName)}</div>`;

  return `
  <section class="section">
    <div class="${variantClass}">
      <div>
        ${logoHtml}
      </div>
      <div class="header-meta">
        <div><strong>Invoice #</strong> ${escapeHtml(invoice.invoice_number || '')}</div>
        <div><strong>Issue Date:</strong> ${escapeHtml(invoice.issue_date || '')}</div>
        ${invoice.due_date ? `<div><strong>Due Date:</strong> ${escapeHtml(invoice.due_date)}</div>` : ''}
        ${storeAddress ? `<div>${escapeHtml(storeAddress)}</div>` : ''}
      </div>
    </div>
  </section>
  `.trim();
}

function renderCustomerBlock(config = {}, { customer }) {
  const showLabel = config.show_label !== false;
  const variant = config.variant || 'left';

  const wrapperClass =
    variant === 'two_column'
      ? 'two-column'
      : variant === 'right'
      ? 'two-column'
      : '';

  const card = `
    <div class="customer-card">
      ${showLabel ? '<div class="customer-label">Bill To</div>' : ''}
      <div class="customer-name">${escapeHtml(customer.name || 'Customer')}</div>
      ${customer.email ? `<div class="customer-detail">${escapeHtml(customer.email)}</div>` : ''}
      ${customer.phone ? `<div class="customer-detail">${escapeHtml(customer.phone)}</div>` : ''}
    </div>
  `;

  return `
  <section class="section">
    ${
      wrapperClass
        ? `<div class="${wrapperClass}">
            <div>${card}</div>
            <div></div>
          </div>`
        : card
    }
  </section>
  `.trim();
}

function renderItemsBlock(config = {}, { items, currency }) {
  const variant = config.variant || 'bordered';
  const tableClass = [
    'items-table',
    variant === 'bordered' || config.show_borders ? 'items-table--bordered' : '',
    variant === 'minimal' ? 'items-table--minimal' : ''
  ]
    .filter(Boolean)
    .join(' ');

  const rows = items.map((item) => {
    return `
      <tr>
        <td>
          <div>${escapeHtml(item.item_name)}</div>
          ${
            item.description
              ? `<div style="font-size:12px; opacity:0.8;">${escapeHtml(item.description)}</div>`
              : ''
          }
        </td>
        <td class="col-qty">${Number(item.quantity || 0).toLocaleString()}</td>
        <td class="col-price">${currency} ${Number(item.unit_price || 0).toFixed(2)}</td>
        <td class="col-total">${currency} ${Number(item.total || 0).toFixed(2)}</td>
      </tr>
    `;
  });

  return `
  <section class="section">
    <table class="${tableClass}">
      <thead>
        <tr>
          <th>Description</th>
          <th class="col-qty">Qty</th>
          <th class="col-price">Unit Price</th>
          <th class="col-total">Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows.join('\n')}
      </tbody>
    </table>
  </section>
  `.trim();
}

function renderTotalsBlock(config = {}, { invoice, currency }) {
  const subtotal = Number(invoice.subtotal || 0);
  const tax = Number(invoice.tax_amount || 0);
  const discount = Number(invoice.discount_amount || 0);
  const total = Number(invoice.total || subtotal + tax - discount);

  return `
  <section class="section">
    <div class="totals">
      <div class="totals-card">
        <div class="totals-row">
          <span>Subtotal</span>
          <span>${currency} ${subtotal.toFixed(2)}</span>
        </div>
        <div class="totals-row">
          <span>Tax</span>
          <span>${currency} ${tax.toFixed(2)}</span>
        </div>
        ${
          discount > 0
            ? `<div class="totals-row">
                <span>Discount</span>
                <span>- ${currency} ${discount.toFixed(2)}</span>
              </div>`
            : ''
        }
        <div class="totals-row total">
          <span>Total</span>
          <span>${currency} ${total.toFixed(2)}</span>
        </div>
      </div>
    </div>
  </section>
  `.trim();
}

function renderPaymentBlock(config = {}, { invoice }) {
  const notes = invoice.notes || '';

  return `
  <section class="section">
    <div class="payment-box">
      <div class="payment-label">Payment Instructions</div>
      <div class="payment-notes">${escapeHtml(notes)}</div>
    </div>
  </section>
  `.trim();
}

function renderFooterBlock(config = {}, { invoice, store }) {
  const variant = config.variant || 'centered';
  const cls =
    variant === 'left'
      ? 'footer footer--left'
      : 'footer';

  const business = store.name || 'MycroShop Invoice';

  return `
  <section class="section">
    <div class="${cls}">
      <div>Thank you for your business.</div>
      <div>${escapeHtml(business)}</div>
    </div>
  </section>
  `.trim();
}

module.exports = {
  renderInvoiceHtml
};


