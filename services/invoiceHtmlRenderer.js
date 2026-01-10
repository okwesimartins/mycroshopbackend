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

  // Safely extract associations - they might be null if foreign keys are null
  const customer = (invoice && invoice.Customer) ? invoice.Customer : {};
  const store = (invoice && invoice.Store) ? invoice.Store : {};
  const items = (invoice && invoice.InvoiceItems) ? (Array.isArray(invoice.InvoiceItems) ? invoice.InvoiceItems : []) : [];

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
    padding: 60px 24px;
    overflow: visible;
  }
  .invoice-content {
    position: relative;
    width: 800px;
    max-width: 100%;
    background: #ffffff;
    border-radius: 12px;
    padding: ${spacing.padding};
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.16);
    overflow: visible;
    z-index: 1;
    margin: 0 auto;
  }

  /* Decorations - positioned absolutely to extend beyond content */
  .invoice-decoration-layer {
    position: absolute;
    top: -80px;
    left: -80px;
    right: -80px;
    bottom: -80px;
    width: calc(100% + 160px);
    height: calc(100% + 160px);
    pointer-events: none;
    z-index: 0;
    overflow: visible;
  }
  .invoice-decoration {
    position: absolute;
    pointer-events: none;
    z-index: 0;
    overflow: visible;
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
    position: relative;
    z-index: 2;
  }
  .header--centered {
    flex-direction: column;
    align-items: center;
    text-align: center;
    border-bottom: 3px solid ${tokens.primary};
    padding-bottom: 20px;
  }
  .header--minimal {
    border-bottom: none;
  }
  .header--split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    align-items: start;
  }
  .header-logo {
    font-size: 24px;
    font-weight: 700;
    color: ${tokens.primary};
  }
  .header-logo-img {
    max-height: 70px;
    max-width: 220px;
    object-fit: contain;
    margin-bottom: 8px;
    display: block;
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
    position: relative;
    z-index: 2;
  }
  .items-table th,
  .items-table td {
    padding: 12px 14px;
    text-align: left;
  }
  .items-table thead {
    background: ${tokens.table_header};
    color: #ffffff;
  }
  .items-table--accent_header thead {
    background: ${tokens.accent};
    color: #ffffff;
    font-weight: 600;
  }
  .items-table--bordered td,
  .items-table--bordered th {
    border: 1px solid ${tokens.border};
  }
  .items-table--minimal thead {
    background: transparent;
    color: ${tokens.text};
    border-bottom: 2px solid ${tokens.border};
    font-weight: 600;
  }
  .items-table--highlighted thead {
    background: linear-gradient(135deg, ${tokens.primary} 0%, ${tokens.accent} 100%);
    color: #ffffff;
  }
  .items-table tbody tr:nth-child(even) {
    background: ${tokens.table_row_alt};
  }
  .items-table--zebra_stripes tbody tr:nth-child(even) {
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
        return 'top: -80px; left: -80px;';
      case 'top-right':
        return 'top: -80px; right: -80px;';
      case 'bottom-left':
        return 'bottom: -80px; left: -80px;';
      case 'bottom-right':
        return 'bottom: -80px; right: -80px;';
      case 'center':
      default:
        return 'top: 50%; left: 50%; transform: translate(-50%, -50%);';
    }
  };

  // Generate different SVG shapes based on asset type
  const generateSVGShape = (asset, width, height, fill, opacity) => {
    const assetType = asset || 'corner_swoosh';
    
    switch (assetType) {
      case 'corner_swoosh':
        // Beautiful curved swoosh at corner
        return `
        <path
          d="M0,${height * 0.6} Q${width * 0.3},${height * 0.2} ${width * 0.6},${height * 0.4} T${width},0 L${width},${height} L0,${height} Z"
          fill="${fill}"
          opacity="${opacity}"
        />
        <path
          d="M0,${height * 0.8} Q${width * 0.2},${height * 0.3} ${width * 0.5},${height * 0.5} T${width * 0.9},${height * 0.2}"
          stroke="${fill}"
          stroke-width="2"
          fill="none"
          opacity="${opacity * 0.6}"
        />
        `;
      
      case 'diagonal_band':
        // Diagonal gradient-like band
        const gradId = `diagonalGrad-${Math.random().toString(36).substr(2, 9)}`;
        return `
        <defs>
          <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${fill};stop-opacity:${opacity}" />
            <stop offset="100%" style="stop-color:${fill};stop-opacity:${opacity * 0.3}" />
          </linearGradient>
        </defs>
        <path
          d="M0,${height * 0.4} L${width * 0.7},0 L${width},${height * 0.3} L${width * 0.3},${height} Z"
          fill="url(#${gradId})"
        />
        `;
      
      case 'wave_footer':
        // Wave pattern at bottom
        return `
        <path
          d="M0,${height * 0.7} Q${width * 0.25},${height * 0.5} ${width * 0.5},${height * 0.7} T${width},${height * 0.7} L${width},${height} L0,${height} Z"
          fill="${fill}"
          opacity="${opacity}"
        />
        <path
          d="M0,${height * 0.8} Q${width * 0.25},${height * 0.65} ${width * 0.5},${height * 0.8} T${width},${height * 0.8}"
          stroke="${fill}"
          stroke-width="1.5"
          fill="none"
          opacity="${opacity * 0.5}"
        />
        `;
      
      case 'circle_stamp':
        // Circular decorative stamp
        const circleGradId = `circleGrad-${Math.random().toString(36).substr(2, 9)}`;
        const radius = Math.min(width, height) * 0.4;
        return `
        <defs>
          <radialGradient id="${circleGradId}" cx="50%" cy="50%">
            <stop offset="0%" style="stop-color:${fill};stop-opacity:${opacity * 0.8}" />
            <stop offset="100%" style="stop-color:${fill};stop-opacity:${opacity * 0.2}" />
          </radialGradient>
        </defs>
        <circle
          cx="${width / 2}"
          cy="${height / 2}"
          r="${radius}"
          fill="url(#${circleGradId})"
        />
        <circle
          cx="${width / 2}"
          cy="${height / 2}"
          r="${radius * 0.875}"
          fill="none"
          stroke="${fill}"
          stroke-width="2"
          opacity="${opacity * 0.6}"
        />
        `;
      
      case 'geometric_pattern':
        // Geometric pattern with triangles and shapes
        return `
        <polygon
          points="${width * 0.2},${height * 0.8} ${width * 0.5},${height * 0.2} ${width * 0.8},${height * 0.8}"
          fill="${fill}"
          opacity="${opacity}"
        />
        <polygon
          points="${width * 0.3},${height * 0.7} ${width * 0.5},${height * 0.4} ${width * 0.7},${height * 0.7}"
          fill="${fill}"
          opacity="${opacity * 0.5}"
        />
        <rect
          x="${width * 0.6}"
          y="${height * 0.3}"
          width="${width * 0.3}"
          height="${height * 0.3}"
          fill="${fill}"
          opacity="${opacity * 0.4}"
          transform="rotate(45 ${width * 0.75} ${height * 0.45})"
        />
        `;
      
      case 'organic_curve':
        // Organic flowing curves
        return `
        <path
          d="M0,${height} C${width * 0.2},${height * 0.7} ${width * 0.4},${height * 0.3} ${width * 0.6},${height * 0.5} C${width * 0.8},${height * 0.7} ${width},${height * 0.4} ${width},0 L${width},${height} Z"
          fill="${fill}"
          opacity="${opacity}"
        />
        <path
          d="M0,${height * 0.9} Q${width * 0.25},${height * 0.6} ${width * 0.5},${height * 0.75} Q${width * 0.75},${height * 0.9} ${width},${height * 0.7}"
          stroke="${fill}"
          stroke-width="2"
          fill="none"
          opacity="${opacity * 0.6}"
        />
        `;
      
      default:
        // Default: elegant corner swoosh
        return `
        <path
          d="M0,${height * 0.7} C${width * 0.1},${height * 0.3} ${width * 0.3},${height * 0.1} ${width * 0.6},${height * 0.3} C${width * 0.8},${height * 0.5} ${width},${height * 0.2} ${width},0 L${width},${height} L0,${height} Z"
          fill="${fill}"
          opacity="${opacity}"
        />
        `;
    }
  };

  const elements = decorations.map((decoration, index) => {
    if (!decoration || !decoration.asset) return '';
    const sizeScale = decoration.scale || 1.0;
    const width = 400 * sizeScale;
    const height = 300 * sizeScale;
    const positionStyle = anchorToPosition(decoration.anchor || 'top-right');
    const opacity = decoration.colors?.opacity ?? 0.12;
    const fill = colorFromToken(decoration.colors?.fill || 'accent');
    const rotate = decoration.rotate || 0;
    const assetType = decoration.asset;

    return `
    <svg
      class="invoice-decoration"
      style="${positionStyle} width:${width}px; height:${height}px; pointer-events: none; z-index: 0; position: absolute;"
      viewBox="0 0 ${width} ${height}"
      xmlns="http://www.w3.org/2000/svg"
      ${rotate ? `transform="rotate(${rotate} ${width/2} ${height/2})"` : ''}
    >
      ${generateSVGShape(assetType, width, height, fill, opacity)}
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

function renderCustomerBlock(config = {}, { customer = {} }) {
  if (!config || !config.block) {
    return '';
  }

  const showLabel = config.show_label !== false;
  const variant = config.variant || 'left';

  const wrapperClass =
    variant === 'two_column'
      ? 'two-column'
      : variant === 'right'
      ? 'two-column'
      : '';

  // Safely access customer properties - customer might be null or empty object
  const customerName = (customer && customer.name) ? customer.name : 'Customer';
  const customerEmail = (customer && customer.email) ? customer.email : null;
  const customerPhone = (customer && customer.phone) ? customer.phone : null;

  const card = `
    <div class="customer-card">
      ${showLabel ? '<div class="customer-label">Bill To</div>' : ''}
      <div class="customer-name">${escapeHtml(customerName)}</div>
      ${customerEmail ? `<div class="customer-detail">${escapeHtml(customerEmail)}</div>` : ''}
      ${customerPhone ? `<div class="customer-detail">${escapeHtml(customerPhone)}</div>` : ''}
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


