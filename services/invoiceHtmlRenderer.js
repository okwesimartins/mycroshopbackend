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
  // Ensure customer is always an object (never null or undefined) since customer_id is optional
  const customer = (invoice && invoice.Customer && typeof invoice.Customer === 'object' && invoice.Customer !== null) ? invoice.Customer : {};
  const store = (invoice && invoice.Store && typeof invoice.Store === 'object' && invoice.Store !== null) ? invoice.Store : {};
  const items = (invoice && invoice.InvoiceItems) ? (Array.isArray(invoice.InvoiceItems) ? invoice.InvoiceItems : []) : [];

  const css = buildBaseCss(tokens, spacing);
  const decorationLayer = renderDecorations(decorations, tokens);

  // Get logo URL from invoice context (passed from controller)
  const logoUrl = invoice.logoUrl || null;
  const headerHtml = renderHeaderBlock(layoutMap.Header, { invoice, store, logoUrl, customer });
  const customerHtml = renderCustomerBlock(layoutMap.CustomerInfo, { customer, invoice, store });
  const itemsHtml = renderItemsBlock(layoutMap.ItemsTable, { items, currency: '₦', tokens });
  const totalsHtml = renderTotalsBlock(layoutMap.Totals, { invoice, currency: '₦', tokens });
  const paymentHtml = renderPaymentBlock(layoutMap.Payment, { invoice, store });
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
    width: 100%;
    height: auto;
    overflow: hidden;
  }
  @page {
    size: A4;
    margin: 0;
  }
  .invoice-root {
    position: relative;
    width: 100%;
    min-height: auto;
    max-height: 1122px; /* A4 height in pixels at 96dpi */
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 20px;
    overflow: hidden;
    page-break-inside: avoid;
  }
  .invoice-content {
    position: relative;
    width: 100%;
    max-width: 750px;
    background: #ffffff;
    border-radius: 8px;
    padding: ${spacing.padding};
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
    overflow: hidden;
    z-index: 1;
    margin: 0 auto;
    page-break-inside: avoid;
    page-break-after: avoid;
  }

  /* Decorations - constrained to not cause overflow */
  .invoice-decoration-layer {
    position: absolute;
    top: -30px;
    left: -30px;
    right: -30px;
    bottom: -30px;
    width: calc(100% + 60px);
    height: calc(100% + 60px);
    pointer-events: none;
    z-index: 0;
    overflow: hidden;
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
    page-break-inside: avoid;
    break-inside: avoid;
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
    max-height: 50px;
    max-width: 180px;
    object-fit: contain;
    margin-bottom: 4px;
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
    border-radius: 8px;
    padding: 12px 14px;
    background: rgba(148, 163, 184, 0.05);
    border: 1px solid ${tokens.border};
    page-break-inside: avoid;
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
    border-radius: 6px;
    overflow: hidden;
    position: relative;
    z-index: 2;
    page-break-inside: avoid;
    font-size: 13px;
  }
  .items-table th,
  .items-table td {
    padding: 8px 10px;
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
    page-break-inside: avoid;
  }
  .totals-card {
    min-width: 240px;
    border-radius: 8px;
    padding: 12px 14px;
    border: 1px solid ${tokens.border};
    background: rgba(148, 163, 184, 0.03);
  }
  .totals-card--bold {
    background: ${tokens.primary};
    color: #ffffff;
    border: none;
  }
  .totals-card--accent {
    background: ${tokens.accent};
    color: #ffffff;
    border: none;
  }
  .totals-card--bold .totals-row,
  .totals-card--accent .totals-row {
    color: #ffffff;
  }
  .totals-card--bold .totals-row.total,
  .totals-card--accent .totals-row.total {
    color: #ffffff;
    border-top-color: rgba(255, 255, 255, 0.3);
    font-size: 18px;
  }
  .totals-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
    font-size: 12px;
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
    border-radius: 8px;
    padding: 10px 12px;
    border: 1px dashed ${tokens.border};
    background: rgba(79, 70, 229, 0.02);
    font-size: 12px;
    page-break-inside: avoid;
  }
  .payment-label {
    font-weight: 600;
    margin-bottom: 4px;
  }
  .payment-notes {
    white-space: pre-line;
  }

  /* Footer variants */
  .footer {
    font-size: 11px;
    color: #6b7280;
    text-align: center;
    padding: 12px 0;
    page-break-inside: avoid;
  }
  .footer--left {
    text-align: left;
  }
  .footer--band {
    background: ${tokens.primary};
    color: #ffffff;
    padding: 16px 20px;
    margin: 0 -${spacing.padding};
    margin-top: 20px;
    border-radius: 0 0 12px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  .footer-band-content {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
    width: 100%;
    justify-content: center;
  }
  .footer-contact-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #ffffff;
  }
  .footer-icon {
    font-size: 14px;
  }
  .footer--signature {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid ${tokens.border};
  }
  .signature-area {
    flex: 1;
    max-width: 200px;
  }
  .signature-line {
    border-top: 1px solid ${tokens.text};
    margin-bottom: 4px;
    padding-top: 20px;
  }
  .signature-label {
    font-size: 11px;
    color: ${tokens.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .thank-you-large {
    font-size: 28px;
    font-weight: 700;
    color: ${tokens.primary};
    text-align: right;
  }
  .footer--centered-elegant {
    text-align: center;
    padding: 16px 0;
    border-top: 1px solid ${tokens.border};
  }
  .thank-you {
    font-size: 18px;
    font-weight: 700;
    color: ${tokens.primary};
    margin-bottom: 8px;
  }
  .footer-contact-elegant {
    font-size: 11px;
    color: ${tokens.secondary};
  }
  .footer--contact {
    text-align: center;
    font-size: 11px;
    color: ${tokens.secondary};
    padding-top: 8px;
  }

  /* Header decorative variants */
  .header--decorative {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    align-items: start;
    border-bottom: none;
    padding-bottom: 16px;
  }
  .header-left {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .header-right {
    text-align: right;
  }
  .invoice-title-large {
    font-size: 36px;
    font-weight: 800;
    color: ${tokens.primary};
    letter-spacing: 2px;
    margin-bottom: 12px;
  }
  .header-meta-compact {
    font-size: 11px;
    line-height: 1.6;
    color: ${tokens.text};
  }
  .business-name {
    font-size: 18px;
    font-weight: 600;
    color: ${tokens.primary};
  }
  .business-name-small {
    font-size: 16px;
    font-weight: 600;
    color: ${tokens.primary};
    margin-top: 4px;
  }
  .header--split-invoice {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
    align-items: start;
    border-bottom: 1px solid ${tokens.border};
    padding-bottom: 16px;
  }
  .invoice-title {
    font-size: 32px;
    font-weight: 700;
    color: ${tokens.primary};
    text-align: right;
    margin-bottom: 12px;
    letter-spacing: 1px;
  }
  .header--curved {
    text-align: center;
    border-bottom: none;
    padding-bottom: 16px;
  }
  .header-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .header-meta-curved {
    font-size: 12px;
    color: ${tokens.text};
    margin-top: 8px;
  }

  /* Logo stacked rectangles */
  .header-logo-stacked {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }
  .stacked-rect {
    width: 40px;
    height: 12px;
    border-radius: 3px;
  }
  .stacked-rect.yellow {
    background: ${tokens.accent || '#F59E0B'};
  }
  .stacked-rect.black {
    background: ${tokens.primary};
  }

  /* Totals variants */
  .totals-card--bold {
    background: ${tokens.primary};
    color: #ffffff;
    border: none;
  }
  .totals-card--bold .totals-row {
    color: #ffffff;
  }
  .totals-card--bold .totals-row.total {
    color: #ffffff;
    border-top-color: rgba(255, 255, 255, 0.3);
  }
  .totals-card--blue-box {
    background: ${tokens.primary};
    color: #ffffff;
    border: none;
    padding: 14px 16px;
  }
  .totals-card--blue-box .totals-row {
    color: #ffffff;
    font-size: 13px;
  }
  .totals-row--blue-box {
    background: ${tokens.primary};
    color: #ffffff;
    font-size: 18px;
    font-weight: 700;
    padding: 10px 0;
    border-top: 2px solid rgba(255, 255, 255, 0.3);
  }
  .totals-bar {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-top: 1px solid ${tokens.border};
    border-bottom: 1px solid ${tokens.border};
    margin: 8px 0;
    font-size: 12px;
    font-weight: 600;
  }
  .totals-bar-label {
    color: ${tokens.text};
  }
  .totals-bar-total {
    color: ${tokens.primary};
  }
  .grand-total-button {
    background: ${tokens.accent};
    color: #ffffff;
    padding: 8px 16px;
    border-radius: 4px;
    font-weight: 700;
    font-size: 14px;
    text-align: center;
    margin-bottom: 8px;
  }
  .grand-total-amount {
    font-size: 24px;
    font-weight: 700;
    color: ${tokens.text};
    text-align: center;
  }
  .totals-card--blue-subtotal {
    background: ${tokens.primary};
    color: #ffffff;
    border: none;
    padding: 12px 16px;
  }
  .totals-card--blue-subtotal .totals-row {
    color: #ffffff;
    font-size: 14px;
    font-weight: 600;
  }

  /* Header variants for exact image matches */
  .header--logo-right-title-left {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    align-items: start;
    border-bottom: none;
    padding-bottom: 16px;
  }
  .invoice-title-large-left {
    font-size: 42px;
    font-weight: 800;
    color: ${tokens.text};
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .header-meta-left {
    font-size: 12px;
    color: ${tokens.text};
    line-height: 1.6;
  }
  .business-name-right {
    font-size: 20px;
    font-weight: 600;
    color: ${tokens.text};
    margin-top: 8px;
  }
  .header--logo-left-invoice-right {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: none;
    padding-bottom: 12px;
  }
  .header-logo-left {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .business-name-left {
    font-size: 18px;
    font-weight: 600;
    color: ${tokens.text};
  }
  .invoice-title-right {
    font-size: 38px;
    font-weight: 700;
    color: ${tokens.text};
    letter-spacing: 2px;
  }
  .header--arrowhead-banner {
    position: relative;
    border-bottom: none;
    padding-bottom: 0;
    margin-bottom: 16px;
  }
  .header-arrowhead-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: ${tokens.primary};
    padding: 20px 24px;
    border-radius: 0;
    clip-path: polygon(0 0, calc(100% - 40px) 0, 100% 0, 100% 100%, 0 100%);
  }
  .header-logo-arrowhead {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .business-name-arrowhead {
    font-size: 16px;
    font-weight: 600;
    color: #ffffff;
  }
  .invoice-banner-arrowhead {
    flex: 1;
    text-align: right;
  }
  .invoice-title-banner {
    font-size: 36px;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: 3px;
  }
  .header--logo-details {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: none;
    padding-bottom: 16px;
  }
  .header-logo-details-left {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .invoice-title-details {
    font-size: 32px;
    font-weight: 700;
    color: ${tokens.text};
    margin-top: 8px;
  }
  .header-meta-details {
    font-size: 11px;
    color: ${tokens.text};
    line-height: 1.8;
  }
  .header-billed-to-right {
    text-align: right;
  }
  .billed-to-label {
    font-size: 11px;
    color: ${tokens.secondary};
    margin-bottom: 4px;
  }
  .billed-to-name {
    font-size: 18px;
    font-weight: 600;
    color: ${tokens.text};
  }
  .header--gradient-wave {
    background: linear-gradient(180deg, ${tokens.primary} 0%, ${tokens.primary}dd 100%);
    color: #ffffff;
    padding: 24px 28px;
    margin: 0 -${spacing.padding};
    margin-bottom: 20px;
    border-radius: 0;
    position: relative;
    overflow: hidden;
  }
  .header--gradient-wave::after {
    content: '';
    position: absolute;
    bottom: -10px;
    left: 0;
    right: 0;
    height: 20px;
    background: ${tokens.background};
    border-radius: 20px 20px 0 0;
  }
  .gradient-wave-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: relative;
    z-index: 1;
  }
  .invoice-title-gradient {
    font-size: 40px;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: 2px;
  }
  .invoice-number-gradient {
    font-size: 14px;
    color: #ffffff;
    font-weight: 600;
  }

  /* Customer info card variants */
  .payment-info-card {
    border-radius: 8px;
    padding: 12px 14px;
    background: rgba(148, 163, 184, 0.05);
    border: 1px solid ${tokens.border};
  }
  .invoice-info-card {
    border-radius: 8px;
    padding: 12px 14px;
    background: rgba(148, 163, 184, 0.05);
    border: 1px solid ${tokens.border};
    font-size: 12px;
  }

  /* Table variants for exact image matches */
  .items-table--blue_header thead {
    background: ${tokens.primary};
    color: #ffffff;
    font-weight: 600;
  }
  .items-table--colorful_headers thead th {
    padding: 12px 10px;
    font-weight: 600;
    font-size: 12px;
  }
  .col-desc-yellow {
    background: ${tokens.accent};
    color: #ffffff;
  }
  .col-price-dark, .col-qty-dark, .col-total-dark {
    background: ${tokens.text};
    color: #ffffff;
  }

  /* Payment box variants */
  .payment-box--terms {
    background: transparent;
    border: none;
    padding: 8px 0;
  }
  .payment-box--terms .payment-label {
    font-size: 13px;
    font-weight: 700;
    color: ${tokens.text};
    margin-bottom: 6px;
  }
  .payment-box--left {
    text-align: left;
  }
  .payment-box--contact {
    background: transparent;
    border: none;
  }

  /* Footer variants for exact image matches */
  .footer--authorized {
    text-align: center;
    padding: 16px 0;
    border-top: 1px solid ${tokens.border};
  }
  .authorized-signed {
    font-size: 12px;
    color: ${tokens.primary};
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  .footer--contact-grid {
    padding: 16px 0;
    border-top: 1px solid ${tokens.border};
  }
  .footer-contact-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    font-size: 11px;
    color: ${tokens.secondary};
  }
  .footer-grid-item {
    display: flex;
    gap: 4px;
  }
  .footer--thank-you-large {
    text-align: right;
    padding: 16px 0;
  }
  .thank-you-large-footer {
    font-size: 32px;
    font-weight: 700;
    color: ${tokens.text};
  }
  .footer--minimal {
    text-align: center;
    padding: 8px 0;
    font-size: 11px;
    color: ${tokens.secondary};
  }

  /* New header variants for image templates */
  .header--invoice-title-right {
    text-align: right;
    padding-bottom: 16px;
    border-bottom: none;
  }
  .invoice-title-right-aligned {
    font-size: 42px;
    font-weight: 800;
    color: ${tokens.text};
    letter-spacing: 2px;
    text-align: right;
  }
  .header--invoice-left-logo-right {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: none;
    padding-bottom: 16px;
  }
  .header-left-invoice {
    flex: 1;
  }
  .invoice-title-left-large {
    font-size: 36px;
    font-weight: 700;
    color: ${tokens.text};
    margin-bottom: 8px;
  }
  .header-right-logo {
    text-align: right;
  }
  .header-meta-right {
    font-size: 12px;
    color: ${tokens.secondary};
    margin-top: 8px;
    line-height: 1.6;
  }
  .header--dark-header {
    background: ${tokens.primary};
    color: #ffffff;
    padding: 20px 24px;
    margin: 0 -${spacing.padding};
    margin-bottom: 20px;
    border-radius: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header-dark-left {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .business-name-white {
    font-size: 18px;
    font-weight: 600;
    color: #ffffff;
  }
  .business-tagline-white {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.8);
  }
  .header-dark-right {
    flex: 1;
    text-align: right;
  }
  .invoice-title-white {
    font-size: 40px;
    font-weight: 800;
    color: #ffffff;
    letter-spacing: 3px;
  }

  /* Three column layout */
  .three-column {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 24px;
    align-items: start;
  }

  /* Customer info variants */
  .customer-name-underline {
    border-bottom: 2px solid ${tokens.primary};
    padding-bottom: 4px;
    display: inline-block;
  }
  .invoice-total-due {
    text-align: right;
  }
  .total-due-label {
    font-size: 12px;
    font-weight: 700;
    color: ${tokens.text};
    margin-bottom: 4px;
    text-transform: uppercase;
  }
  .total-due-amount {
    font-size: 24px;
    font-weight: 700;
    color: ${tokens.text};
  }
  .invoice-meta-left {
    font-size: 12px;
    color: ${tokens.text};
    line-height: 1.8;
  }
  .invoice-meta-right {
    font-size: 12px;
    color: ${tokens.text};
    line-height: 1.8;
    text-align: right;
  }
  .invoice-total-due-far {
    text-align: right;
  }

  /* Totals variants */
  .totals-card--dark-box {
    background: ${tokens.primary};
    color: #ffffff;
    border: none;
    padding: 12px 16px;
    margin-top: 8px;
  }

  /* Payment box variants */
  .payment-box--gray {
    background: #F3F4F6;
    border: 1px solid ${tokens.border};
    padding: 12px 14px;
    border-radius: 6px;
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
        return 'top: -20px; left: -20px;';
      case 'top-right':
        return 'top: -20px; right: -20px;';
      case 'bottom-left':
        return 'bottom: -20px; left: -20px;';
      case 'bottom-right':
        return 'bottom: -20px; right: -20px;';
      case 'center':
      default:
        return 'top: 50%; left: 50%; transform: translate(-50%, -50%);';
    }
  };

  // Generate different SVG shapes based on asset type
  const generateSVGShape = (asset, width, height, fill, opacity, anchor = 'top-right') => {
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
      case 'flowing_waves':
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
      
      case 'stacked_rectangles':
        // Stacked rounded rectangles (like logo placeholder)
        return `
        <rect x="${width * 0.1}" y="${height * 0.1}" width="${width * 0.15}" height="${height * 0.12}" rx="4" fill="${fill}" opacity="${opacity}"/>
        <rect x="${width * 0.1}" y="${height * 0.26}" width="${width * 0.15}" height="${height * 0.12}" rx="4" fill="${fill}" opacity="${opacity * 0.7}"/>
        <rect x="${width * 0.1}" y="${height * 0.42}" width="${width * 0.15}" height="${height * 0.12}" rx="4" fill="${fill}" opacity="${opacity}"/>
        `;
      
      case 'accent_line':
        // Horizontal accent line
        return `
        <rect x="0" y="${height * 0.5}" width="${width}" height="3" fill="${fill}" opacity="${opacity}"/>
        `;
      
      case 'corner_triangles':
      case 'corner_triangle_accent':
        // Triangular shapes at corners
        if (anchor === 'bottom') {
          return `
          <polygon points="${width * 0.8},${height * 0.9} ${width},${height * 0.9} ${width},${height}" fill="${fill}" opacity="${opacity}"/>
          <polygon points="0,${height * 0.9} ${width * 0.2},${height * 0.9} 0,${height}" fill="${fill}" opacity="${opacity * 0.8}"/>
          `;
        }
        return `
        <polygon points="${width},0 ${width},${height * 0.2} ${width * 0.85},0" fill="${fill}" opacity="${opacity}"/>
        <polygon points="0,${height} ${width * 0.15},${height} 0,${height * 0.8}" fill="${fill}" opacity="${opacity}"/>
        `;
      
      case 'bold_geometric_header':
        // Large overlapping geometric shape for header
        return `
        <path d="M${width * 0.3},0 L${width},0 L${width},${height * 0.6} L${width * 0.4},${height * 0.3} Z" fill="${fill}" opacity="${opacity}"/>
        <path d="M${width * 0.5},${height * 0.1} L${width * 0.9},${height * 0.1} L${width},${height * 0.5} L${width * 0.6},${height * 0.4} Z" fill="${fill}" opacity="${opacity * 0.7}"/>
        `;
      
      case 'geometric_crystal':
      case 'geometric_pattern_bg':
        // Geometric crystal/gem pattern
        return `
        <polygon points="${width * 0.3},${height * 0.5} ${width * 0.5},${height * 0.2} ${width * 0.7},${height * 0.5} ${width * 0.5},${height * 0.8}" fill="${fill}" opacity="${opacity}"/>
        <polygon points="${width * 0.4},${height * 0.5} ${width * 0.5},${height * 0.35} ${width * 0.6},${height * 0.5} ${width * 0.5},${height * 0.65}" fill="${fill}" opacity="${opacity * 0.5}"/>
        `;
      
      case 'bottom_wave':
        return `
        <path d="M0,${height * 0.6} Q${width * 0.25},${height * 0.4} ${width * 0.5},${height * 0.6} T${width},${height * 0.6} L${width},${height} L0,${height} Z" fill="${fill}" opacity="${opacity}"/>
        `;
      
      case 'large_sweeping_curve_top':
        // Large sweeping curve from left across top and down right
        return `
        <path d="M0,0 Q${width * 0.25},${height * 0.15} ${width * 0.5},${height * 0.1} Q${width * 0.75},${height * 0.05} ${width},${height * 0.2} L${width},0 Z" fill="${fill}" opacity="${opacity}"/>
        <path d="M0,${height * 0.1} Q${width * 0.3},${height * 0.3} ${width * 0.6},${height * 0.25} Q${width * 0.9},${height * 0.2} ${width},${height * 0.35} L${width},${height * 0.25} Q${width * 0.85},${height * 0.15} ${width * 0.6},${height * 0.18} Q${width * 0.35},${height * 0.2} 0,${height * 0.12} Z" fill="${fill}" opacity="${opacity * 0.7}"/>
        `;
      
      case 'large_sweeping_curve_bottom':
        // Large sweeping curve from bottom-left
        return `
        <path d="M0,${height} Q${width * 0.25},${height * 0.85} ${width * 0.5},${height * 0.9} Q${width * 0.75},${height * 0.95} ${width},${height * 0.8} L${width},${height} Z" fill="${fill}" opacity="${opacity}"/>
        `;
      
      case 'layered_angular_shapes':
        // Layered angular shapes creating depth
        return `
        <polygon points="0,0 ${width * 0.4},0 ${width * 0.3},${height * 0.4} 0,${height * 0.5}" fill="${fill}" opacity="${opacity}"/>
        <polygon points="${width * 0.15},0 ${width * 0.5},0 ${width * 0.45},${height * 0.35} ${width * 0.1},${height * 0.45}" fill="${fill}" opacity="${opacity * 0.6}"/>
        <polygon points="${width * 0.25},${height * 0.1} ${width * 0.55},${height * 0.05} ${width * 0.52},${height * 0.38} ${width * 0.22},${height * 0.4}" fill="${fill}" opacity="${opacity * 0.4}"/>
        <line x1="${width * 0.2}" y1="${height * 0.15}" x2="${width * 0.6}" y2="${height * 0.12}" stroke="${fill}" stroke-width="1" opacity="${opacity * 0.3}"/>
        `;
      
      case 'corner_geometric_accent':
        // Geometric accent shapes at corner
        return `
        <polygon points="${width * 0.7},0 ${width},0 ${width},${height * 0.3} ${width * 0.8},${height * 0.15}" fill="${fill}" opacity="${opacity}"/>
        <polygon points="${width * 0.75},${height * 0.05} ${width * 0.95},${height * 0.03} ${width * 0.92},${height * 0.28} ${width * 0.72},${height * 0.2}" fill="${fill}" opacity="${opacity * 0.7}"/>
        `;
      
      case 'abstract_gradient_shapes':
        // Abstract overlapping gradient shapes
        return `
        <path d="M0,0 Q${width * 0.3},${height * 0.2} ${width * 0.2},${height * 0.5} Q${width * 0.1},${height * 0.8} 0,${height}" fill="${fill}" opacity="${opacity}"/>
        <path d="M${width * 0.15},${height * 0.1} Q${width * 0.4},${height * 0.3} ${width * 0.3},${height * 0.6} Q${width * 0.2},${height * 0.9} ${width * 0.1},${height}" fill="${fill}" opacity="${opacity * 0.6}"/>
        <ellipse cx="${width * 0.25}" cy="${height * 0.25}" rx="${width * 0.15}" ry="${height * 0.15}" fill="${fill}" opacity="${opacity * 0.4}"/>
        `;
      
      case 'gradient_wave_header':
        // Gradient wave header with smooth transition
        const gradientId = `gradWave-${Math.random().toString(36).substr(2, 9)}`;
        return `
        <defs>
          <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:${fill};stop-opacity:${opacity}" />
            <stop offset="100%" style="stop-color:${fill};stop-opacity:${opacity * 0.6}" />
          </linearGradient>
        </defs>
        <path d="M0,0 L${width},0 L${width},${height * 0.7} Q${width * 0.75},${height * 0.65} ${width * 0.5},${height * 0.7} T0,${height * 0.7} Z" fill="url(#${gradientId})"/>
        `;
      
      case 'accent_stripe':
        // Vertical accent stripe on the left
        return `
        <rect x="0" y="0" width="${width * 0.08}" height="${height}" fill="${fill}" opacity="${opacity}"/>
        `;
      
      case 'minimal_geometric':
        // Minimal geometric pattern
        return `
        <circle cx="${width * 0.7}" cy="${height * 0.7}" r="${width * 0.15}" fill="${fill}" opacity="${opacity}"/>
        <rect x="${width * 0.75}" y="${height * 0.6}" width="${width * 0.2}" height="${width * 0.2}" transform="rotate(45 ${width * 0.85} ${height * 0.7})" fill="${fill}" opacity="${opacity * 0.5}"/>
        `;
      
      case 'border_frame':
        // Border frame around content
        return `
        <rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="${fill}" stroke-width="2" opacity="${opacity}"/>
        <rect x="${width * 0.05}" y="${height * 0.05}" width="${width * 0.9}" height="${height * 0.9}" fill="none" stroke="${fill}" stroke-width="1" opacity="${opacity * 0.5}"/>
        `;
      
      case 'corner_mark':
        // Small corner mark/icon
        return `
        <polygon points="0,0 ${width * 0.3},0 ${width * 0.2},${height * 0.3} 0,${height * 0.2}" fill="${fill}" opacity="${opacity}"/>
        <line x1="${width * 0.05}" y1="${height * 0.05}" x2="${width * 0.25}" y2="${height * 0.05}" stroke="${fill}" stroke-width="2" opacity="${opacity * 0.8}"/>
        <line x1="${width * 0.05}" y1="${height * 0.05}" x2="${width * 0.05}" y2="${height * 0.25}" stroke="${fill}" stroke-width="2" opacity="${opacity * 0.8}"/>
        `;
      
      case 'diagonal_split':
        // Bold diagonal split
        return `
        <path d="M0,0 L${width},0 L${width},${height * 0.5} L${width * 0.4},${height} L0,${height} Z" fill="${fill}" opacity="${opacity}"/>
        <path d="M${width * 0.1},${height * 0.1} L${width * 0.9},${height * 0.1} L${width * 0.85},${height * 0.55} L${width * 0.35},${height * 0.95} L${width * 0.05},${height * 0.95} Z" fill="${fill}" opacity="${opacity * 0.8}"/>
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
    const sizeScale = Math.min(decoration.scale || 1.0, 1.5); // Allow larger scale for full-width
    const anchor = decoration.anchor || 'top-right';
    
    // Special sizing for full-width/height decorations
    let width, height, positionStyle;
    if (anchor === 'top' || anchor === 'bottom') {
      // Full width decoration
      width = 1200 * sizeScale;
      height = 200 * sizeScale;
      positionStyle = anchor === 'top' 
        ? 'top: -40px; left: 50%; transform: translateX(-50%); width: 120%; height: auto;'
        : 'bottom: -40px; left: 50%; transform: translateX(-50%); width: 120%; height: auto;';
    } else if (anchor === 'left' || anchor === 'right') {
      // Full height decoration
      width = 100 * sizeScale;
      height = 1400 * sizeScale;
      positionStyle = anchor === 'left'
        ? 'top: 0; bottom: 0; left: -30px; width: auto; height: 100%;'
        : 'top: 0; bottom: 0; right: -30px; width: auto; height: 100%;';
    } else {
      // Corner/center decorations
      width = 300 * sizeScale;
      height = 200 * sizeScale;
      positionStyle = anchorToPosition(anchor);
    }
    
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
      preserveAspectRatio="${anchor === 'top' || anchor === 'bottom' || anchor === 'left' || anchor === 'right' ? 'none' : 'xMidYMid'}"
      ${rotate ? `transform="rotate(${rotate} ${width/2} ${height/2})"` : ''}
    >
      ${generateSVGShape(assetType, width, height, fill, opacity, decoration.anchor)}
    </svg>
    `;
  });

  return `
  <div class="invoice-decoration-layer">
    ${elements.join('\n')}
  </div>
  `.trim();
}

function renderHeaderBlock(config = {}, { invoice, store, logoUrl, customer = null }) {
  // Ensure customer is always defined (handle case where customer_id is optional)
  if (typeof customer === 'undefined' || customer === null) {
    customer = {};
  }
  
  const variant = config.variant || 'default';
  const businessName = store?.name || 'Invoice';
  const storeAddress = [store?.address, store?.city, store?.state]
    .filter(Boolean)
    .join(', ');

  // Render logo if available, otherwise use text or stacked rectangles placeholder
  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" class="header-logo-img" />`
    : variant === 'bold_geometric' || variant === 'decorative_top'
    ? `<div class="header-logo-stacked"><div class="stacked-rect yellow"></div><div class="stacked-rect black"></div><div class="stacked-rect yellow"></div></div>`
    : `<div class="header-logo">${escapeHtml(businessName)}</div>`;

  // Different header layouts based on variant
  switch (variant) {
    // Template 1: Logo right, INVOICE title left (Hanover & Tyke style)
    case 'logo_right_title_left':
      return `
      <section class="section">
        <div class="header header--logo-right-title-left">
          <div class="header-left">
            <div class="invoice-title-large-left">INVOICE</div>
            <div class="header-meta-left">
              <div><strong>Invoice Number:</strong> ${escapeHtml(invoice.invoice_number || '')}</div>
              <div><strong>Date:</strong> ${escapeHtml(invoice.issue_date || '')}</div>
            </div>
          </div>
          <div class="header-right">
            ${logoHtml}
            ${businessName ? `<div class="business-name-right">${escapeHtml(businessName)}</div>` : ''}
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 2: Logo left, INVOICE right (Borcelle style)
    case 'logo_left_invoice_right':
      return `
      <section class="section">
        <div class="header header--logo-left-invoice-right">
          <div class="header-logo-left">
            ${logoHtml}
            ${businessName ? `<div class="business-name-left">${escapeHtml(businessName)}</div>` : ''}
          </div>
          <div class="header-invoice-right">
            <div class="invoice-title-right">INVOICE</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 3: Arrowhead banner (Wardiere style)
    case 'arrowhead_banner':
      return `
      <section class="section">
        <div class="header header--arrowhead-banner">
          <div class="header-arrowhead-content">
            <div class="header-logo-arrowhead">
              ${logoHtml}
              ${businessName ? `<div class="business-name-arrowhead">${escapeHtml(businessName)}</div>` : ''}
            </div>
            <div class="invoice-banner-arrowhead">
              <div class="invoice-title-banner">INVOICE</div>
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 4: Logo left with invoice details (Vibrant style)
    case 'logo_left_invoice_details':
      return `
      <section class="section">
        <div class="header header--logo-details">
          <div class="header-logo-details-left">
            ${logoHtml}
            <div class="invoice-title-details">Invoice</div>
            <div class="header-meta-details">
              <div><strong>INVOICE NO.</strong> ${escapeHtml(invoice.invoice_number || '')}</div>
              <div><strong>DATE:</strong> ${escapeHtml(invoice.issue_date || '')}</div>
            </div>
          </div>
          <div class="header-billed-to-right">
            <div class="billed-to-label">Billed to:</div>
            <div class="billed-to-name">${escapeHtml(customer?.name || 'Customer')}</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 5: Gradient wave header (Blue gradient style)
    case 'gradient_wave_header':
      return `
      <section class="section">
        <div class="header header--gradient-wave">
          <div class="gradient-wave-content">
            <div class="invoice-title-gradient">INVOICE</div>
            <div class="invoice-number-gradient">NO: ${escapeHtml(invoice.invoice_number || '')}</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Image 1: Invoice title right-aligned (upper-middle)
    case 'invoice_title_right_aligned':
      return `
      <section class="section">
        <div class="header header--invoice-title-right">
          <div class="invoice-title-right-aligned">INVOICE</div>
        </div>
      </section>
      `.trim();
    
    // Image 2: Invoice left, logo right
    case 'invoice_left_logo_right':
      return `
      <section class="section">
        <div class="header header--invoice-left-logo-right">
          <div class="header-left-invoice">
            <div class="invoice-title-left-large">Invoice</div>
          </div>
          <div class="header-right-logo">
            ${logoHtml}
            <div class="header-meta-right">
              <div>Invoice #${escapeHtml(invoice.invoice_number || '00000')}</div>
              <div>Due ${escapeHtml(invoice.due_date || '1 January 2022')}</div>
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Image 3: Dark header with logo left, INVOICE right
    case 'dark_header_logo_left_invoice_right':
      return `
      <section class="section">
        <div class="header header--dark-header">
          <div class="header-dark-left">
            ${logoHtml}
            ${businessName ? `<div class="business-name-white">${escapeHtml(businessName)}</div>` : ''}
            ${store?.description ? `<div class="business-tagline-white">${escapeHtml(store.description)}</div>` : ''}
          </div>
          <div class="header-dark-right">
            <div class="invoice-title-white">INVOICE</div>
          </div>
        </div>
      </section>
      `.trim();
    
    case 'bold_geometric':
    case 'decorative_top':
      return `
      <section class="section">
        <div class="header header--decorative">
          <div class="header-left">
            ${logoHtml}
            ${businessName ? `<div class="business-name">${escapeHtml(businessName)}</div>` : ''}
          </div>
          <div class="header-right">
            <div class="invoice-title-large">INVOICE</div>
            <div class="header-meta-compact">
              <div><strong>Invoice #</strong> ${escapeHtml(invoice.invoice_number || '')}</div>
              <div><strong>Date:</strong> ${escapeHtml(invoice.issue_date || '')}</div>
              ${invoice.due_date ? `<div><strong>Due:</strong> ${escapeHtml(invoice.due_date)}</div>` : ''}
              ${invoice.total ? `<div><strong>TOTAL DUE:</strong> ${escapeHtml(String(invoice.total))}</div>` : ''}
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    case 'logo_left_title_right':
      return `
      <section class="section">
        <div class="header header--split-invoice">
          <div class="header-logo-area">
            ${logoHtml}
            ${businessName ? `<div class="business-name-small">${escapeHtml(businessName)}</div>` : ''}
          </div>
          <div class="header-invoice-area">
            <div class="invoice-title">INVOICE</div>
            <div class="header-meta-compact">
              <div><strong>Invoice No:</strong> ${escapeHtml(invoice.invoice_number || '')}</div>
              <div><strong>Invoice Date:</strong> ${escapeHtml(invoice.issue_date || '')}</div>
              ${invoice.due_date ? `<div><strong>Due Date:</strong> ${escapeHtml(invoice.due_date)}</div>` : ''}
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    case 'curved_header':
      return `
      <section class="section">
        <div class="header header--curved">
          <div class="header-center">
            ${logoHtml}
            ${businessName ? `<div class="business-name">${escapeHtml(businessName)}</div>` : ''}
            <div class="header-meta-curved">
              <div><strong>Invoice #</strong> ${escapeHtml(invoice.invoice_number || '')}</div>
              <div><strong>Issue Date:</strong> ${escapeHtml(invoice.issue_date || '')}</div>
              ${invoice.due_date ? `<div><strong>Due Date:</strong> ${escapeHtml(invoice.due_date)}</div>` : ''}
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    case 'minimal_with_stripe':
    case 'classic_header':
    case 'diagonal_header':
    default:
      const variantClass = (() => {
        switch (variant) {
          case 'centered':
            return 'header header--centered';
          case 'minimal':
          case 'minimal_with_stripe':
            return 'header header--minimal';
          case 'split':
            return 'header header--split';
          default:
            return 'header';
        }
      })();
      
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
}

function renderCustomerBlock(config = {}, { customer = {}, invoice, store }) {
  if (!config || !config.block) {
    return '';
  }

  const showLabel = config.show_label !== false;
  const variant = config.variant || 'left';

  // Safely access customer properties
  const customerName = (customer && customer.name) ? customer.name : 'Customer';
  const customerEmail = (customer && customer.email) ? customer.email : null;
  const customerPhone = (customer && customer.phone) ? customer.phone : null;
  const customerAddress = [customer?.address, customer?.city, customer?.state, customer?.country]
    .filter(Boolean)
    .join(', ');

  // Different customer info layouts based on variant
  switch (variant) {
    // Template 1: BILL TO and PAYMENT INFORMATION side by side
    case 'bill_to_payment_two_column':
      const paymentNotes = invoice?.notes || '';
      return `
      <section class="section">
        <div class="two-column">
          <div class="customer-card">
            <div class="customer-label">BILL TO:</div>
            <div class="customer-name">${escapeHtml(customerName)}</div>
            ${customerAddress ? `<div class="customer-detail">${escapeHtml(customerAddress)}</div>` : ''}
          </div>
          <div class="payment-info-card">
            <div class="payment-label">PAYMENT INFORMATION:</div>
            ${paymentNotes ? `<div class="payment-notes">${escapeHtml(paymentNotes)}</div>` : ''}
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 2: Issued To and Invoice No side by side
    case 'issued_to_invoice_no':
      return `
      <section class="section">
        <div class="two-column">
          <div class="customer-card">
            <div class="customer-label">Issued To:</div>
            <div class="customer-name">${escapeHtml(customerName)}</div>
            ${customerAddress ? `<div class="customer-detail">${escapeHtml(customerAddress)}</div>` : ''}
            ${customerEmail ? `<div class="customer-detail">${escapeHtml(customerEmail)}</div>` : ''}
            ${customerPhone ? `<div class="customer-detail">${escapeHtml(customerPhone)}</div>` : ''}
          </div>
          <div class="invoice-info-card">
            <div><strong>Invoice No:</strong> ${escapeHtml(invoice?.invoice_number || '')}</div>
            <div><strong>Date:</strong> ${escapeHtml(invoice?.issue_date || '')}</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 3: Bill To and Invoice info side by side
    case 'bill_to_invoice_side_by_side':
      return `
      <section class="section">
        <div class="two-column">
          <div class="customer-card">
            <div class="customer-label">Bill To :</div>
            <div class="customer-name">${escapeHtml(customerName)}</div>
            ${customerAddress ? `<div class="customer-detail">${escapeHtml(customerAddress)}</div>` : ''}
            ${customerEmail ? `<div class="customer-detail">${escapeHtml(customerEmail)}</div>` : ''}
          </div>
          <div class="invoice-info-card">
            <div><strong>No :</strong> ${escapeHtml(invoice?.invoice_number || '')}</div>
            <div><strong>Date :</strong> ${escapeHtml(invoice?.issue_date || '')}</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 4: Billed to on right
    case 'billed_to_right':
      return `
      <section class="section">
        <div class="two-column">
          <div></div>
          <div class="customer-card">
            <div class="customer-label">Billed to:</div>
            <div class="customer-name">${escapeHtml(customerName)}</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 5: Bill To and From two columns
    case 'bill_from_two_column':
      const storeName = store?.name || 'Business';
      const storeAddressFull = [store?.address, store?.city, store?.state]
        .filter(Boolean)
        .join(', ');
      return `
      <section class="section">
        <div class="two-column">
          <div class="customer-card">
            <div class="customer-label">Bill To:</div>
            <div class="customer-name">${escapeHtml(customerName)}</div>
            ${customerPhone ? `<div class="customer-detail">${escapeHtml(customerPhone)}</div>` : ''}
            ${customerAddress ? `<div class="customer-detail">${escapeHtml(customerAddress)}</div>` : ''}
          </div>
          <div class="customer-card">
            <div class="customer-label">From:</div>
            <div class="customer-name">${escapeHtml(storeName)}</div>
            ${store?.phone ? `<div class="customer-detail">${escapeHtml(store.phone)}</div>` : ''}
            ${storeAddressFull ? `<div class="customer-detail">${escapeHtml(storeAddressFull)}</div>` : ''}
          </div>
        </div>
      </section>
      `.trim();
    
    // Image 1: Invoice TO left, Total Due right
    case 'invoice_to_left_total_right':
      return `
      <section class="section">
        <div class="two-column">
          <div class="customer-card">
            <div class="customer-label">INVOICE TO:</div>
            <div class="customer-name customer-name-underline">${escapeHtml(customerName)}</div>
            ${customerAddress ? `<div class="customer-detail">${escapeHtml(customerAddress)}</div>` : ''}
          </div>
          <div class="invoice-total-due">
            <div class="total-due-label">TOTAL DUE:</div>
            <div class="total-due-amount">USD: $ ${Number(invoice?.total || 0).toLocaleString()}</div>
          </div>
        </div>
        <div class="invoice-meta-left" style="margin-top: 12px;">
          <div>Date: ${escapeHtml(invoice?.issue_date || '')}</div>
          <div>Invoice No: ${escapeHtml(invoice?.invoice_number || '')}</div>
        </div>
      </section>
      `.trim();
    
    // Image 2: Invoice to left, metadata right
    case 'invoice_to_left_metadata_right':
      return `
      <section class="section">
        <div class="two-column">
          <div class="customer-card">
            <div class="customer-label">Invoice to</div>
            <div class="customer-name">${escapeHtml(customerName)}</div>
            ${store?.name ? `<div class="customer-detail">${escapeHtml(store.name)}</div>` : ''}
            ${customerEmail ? `<div class="customer-detail">${escapeHtml(customerEmail)}</div>` : ''}
          </div>
          <div></div>
        </div>
      </section>
      `.trim();
    
    // Image 3: Invoice TO left, Date/No right, Total Due far right
    case 'invoice_to_left_date_no_right_total_far_right':
      return `
      <section class="section">
        <div class="three-column">
          <div class="customer-card">
            <div class="customer-label">INVOICE TO:</div>
            <div class="customer-name">${escapeHtml(customerName)}</div>
          </div>
          <div class="invoice-meta-right">
            <div>Date: ${escapeHtml(invoice?.issue_date || '')}</div>
            <div>Invoice No: ${escapeHtml(invoice?.invoice_number || '')}</div>
          </div>
          <div class="invoice-total-due-far">
            <div class="total-due-label">TOTAL DUE:</div>
            <div class="total-due-amount">USD: $ ${Number(invoice?.total || 0).toLocaleString()}</div>
          </div>
        </div>
      </section>
      `.trim();
    
    default:
      const wrapperClass =
        variant === 'two_column'
          ? 'two-column'
          : variant === 'right'
          ? 'two-column'
          : '';

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
}

function renderItemsBlock(config = {}, { items, currency, tokens = {} }) {
  const variant = config.variant || 'bordered';
  const tableClass = [
    'items-table',
    variant === 'bordered' || variant === 'blue_header_bordered' || config.show_borders ? 'items-table--bordered' : '',
    variant === 'minimal' || variant === 'minimal_clean' ? 'items-table--minimal' : '',
    variant === 'accent_header' || variant === 'accent_header_bold' ? 'items-table--accent_header' : '',
    variant === 'blue_header' || variant === 'blue_header_bordered' || variant === 'blue_header_zebra' ? 'items-table--blue_header' : '',
    variant === 'zebra_stripes' || variant === 'blue_header_zebra' ? 'items-table--zebra_stripes' : '',
    variant === 'highlighted' ? 'items-table--highlighted' : '',
    variant === 'colorful_alternating_headers' ? 'items-table--colorful_headers' : ''
  ]
    .filter(Boolean)
    .join(' ');

  // Determine column headers based on variant
  let headers = `
    <th>Description</th>
    <th class="col-qty">Qty</th>
    <th class="col-price">Unit Price</th>
    <th class="col-total">Total</th>
  `;
  
  if (variant === 'colorful_alternating_headers') {
    // Template 4: Alternating colored headers
    headers = `
      <th class="col-desc-yellow">DESCRIPTION</th>
      <th class="col-price-dark">PRICE</th>
      <th class="col-qty-dark">QTY</th>
      <th class="col-total-dark">AMOUNT</th>
    `;
  } else if (variant === 'blue_header' || variant === 'blue_header_bordered' || variant === 'blue_header_zebra') {
    headers = `
      <th>ITEM</th>
      <th>DESCRIPTION</th>
      <th class="col-price">RATE</th>
      <th class="col-total">AMOUNT</th>
    `;
  }

  const rows = items.map((item, index) => {
    const rowClass = config.stripe_rows && index % 2 === 1 ? 'row-striped' : '';
    return `
      <tr class="${rowClass}">
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
          ${headers}
        </tr>
      </thead>
      <tbody>
        ${rows.join('\n')}
      </tbody>
    </table>
  </section>
  `.trim();
}

function renderTotalsBlock(config = {}, { invoice, currency, tokens = {} }) {
  const variant = config.variant || 'right';
  const subtotal = Number(invoice.subtotal || 0);
  const tax = Number(invoice.tax_amount || 0);
  const discount = Number(invoice.discount_amount || 0);
  const total = Number(invoice.total || subtotal + tax - discount);
  const primary = tokens.primary || '#1E40AF';
  const accent = tokens.accent || '#F59E0B';

  // Different totals layouts based on variant
  switch (variant) {
    // Template 1: Blue total box (Hanover style)
    case 'blue_total_box':
      return `
      <section class="section">
        <div class="totals" style="justify-content: flex-end;">
          <div class="totals-card totals-card--blue-box">
            <div class="totals-row">
              <span>Sub Total:</span>
              <span>${currency} ${subtotal.toFixed(2)}</span>
            </div>
            <div class="totals-row">
              <span>Sales Tax:</span>
              <span>${currency} ${tax.toFixed(2)}</span>
            </div>
            <div class="totals-row total totals-row--blue-box">
              <span>TOTAL:</span>
              <span>${currency} ${total.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 2: Subtotal and Total bar
    case 'subtotal_total_bar':
      return `
      <section class="section">
        <div class="totals" style="justify-content: flex-end;">
          <div class="totals-card">
            <div class="totals-row">
              <span>Sub-total:</span>
              <span>${currency} ${subtotal.toFixed(2)}</span>
            </div>
            <div class="totals-row">
              <span>Tax:</span>
              <span>${currency} ${tax.toFixed(2)}</span>
            </div>
            <div class="totals-bar">
              <div class="totals-bar-label">SUBTOTAL</div>
              <div class="totals-bar-total">TOTAL</div>
            </div>
            <div class="totals-row total">
              <span></span>
              <span>${currency} ${total.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 3: Right aligned with discount
    case 'right_aligned_with_discount':
      return `
      <section class="section">
        <div class="totals" style="justify-content: flex-end;">
          <div class="totals-card">
            <div class="totals-row">
              <span>Subtotal:</span>
              <span>${currency} ${subtotal.toFixed(2)}</span>
            </div>
            <div class="totals-row">
              <span>Discount:</span>
              <span>${discount > 0 ? `${discount}%` : '0%'}</span>
            </div>
            <div class="totals-row">
              <span>Total Amount:</span>
              <span>${currency} ${total.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 4: Grand Total button style
    case 'grand_total_button':
      return `
      <section class="section">
        <div class="totals" style="justify-content: flex-end;">
          <div class="totals-card">
            <div class="grand-total-button">GRAND TOTAL</div>
            <div class="grand-total-amount">${currency} ${total.toFixed(2)}</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 5: Blue subtotal box
    case 'blue_subtotal_box':
      return `
      <section class="section">
        <div class="totals" style="justify-content: flex-end;">
          <div class="totals-card totals-card--blue-subtotal">
            <div class="totals-row">
              <span>Sub Total</span>
              <span>${currency} ${subtotal.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Image 1: Blue total box right-aligned
    case 'blue_total_box_right':
      return `
      <section class="section">
        <div class="totals" style="justify-content: flex-end;">
          <div class="totals-card totals-card--blue-box">
            <div class="totals-row">
              <span>Sub-total:</span>
              <span>${currency} ${subtotal.toFixed(2)}</span>
            </div>
            <div class="totals-row">
              <span>Tax:</span>
              <span>${currency} ${tax.toFixed(2)}</span>
            </div>
            <div class="totals-row total totals-row--blue-box">
              <span>Total:</span>
              <span>${currency} ${total.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Image 2: Total left, amount right
    case 'total_left_amount_right':
      return `
      <section class="section">
        <div class="totals" style="justify-content: space-between; border-top: 1px solid ${border}; padding-top: 12px;">
          <div style="font-weight: 600; font-size: 14px;">TOTAL</div>
          <div style="font-weight: 700; font-size: 18px;">${currency} ${total.toFixed(2)}</div>
        </div>
      </section>
      `.trim();
    
    // Image 3: Subtotal, Tax, Total box right
    case 'subtotal_tax_total_box_right':
      return `
      <section class="section">
        <div class="totals" style="justify-content: flex-end;">
          <div class="totals-card">
            <div class="totals-row">
              <span>Sub-total:</span>
              <span>${currency} ${subtotal.toFixed(2)}</span>
            </div>
            <div class="totals-row">
              <span>Tax:</span>
              <span>${currency} ${tax.toFixed(2)}</span>
            </div>
            <div class="totals-card totals-card--dark-box">
              <div class="totals-row total" style="color: #ffffff;">
                <span>Total:</span>
                <span>${currency} ${total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
      `.trim();
    
    default:
      // Determine totals card class based on variant
      let totalsCardClass = 'totals-card';
      if (variant === 'bold_box') {
        totalsCardClass = 'totals-card totals-card--bold';
      } else if (variant === 'accent_box') {
        totalsCardClass = 'totals-card totals-card--accent';
      }

      // Determine alignment
      const alignment = variant === 'left' ? 'flex-start' : 
                        variant === 'two_column' ? 'space-between' : 
                        'flex-end';

      const totalsHtml = `
        <div class="${totalsCardClass}">
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
      `;

      // Special variant with "Thank You" message
      if (variant === 'right_with_thankyou') {
        return `
        <section class="section">
          <div class="totals" style="justify-content: ${alignment};">
            <div style="flex: 1;"></div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 12px;">
              ${totalsHtml}
              <div class="thank-you-large" style="font-size: 24px; margin-top: 8px;">THANK YOU!</div>
            </div>
          </div>
        </section>
        `.trim();
      }

      return `
      <section class="section">
        <div class="totals" style="justify-content: ${alignment};">
          ${variant === 'two_column' ? '<div></div>' : ''}
          ${totalsHtml}
        </div>
      </section>
      `.trim();
  }
}

function renderPaymentBlock(config = {}, { invoice, store }) {
  const variant = config.variant || 'minimal';
  const notes = invoice?.notes || '';
  const businessPhone = store?.phone || '';
  const businessEmail = store?.email || '';
  const businessAddress = [store?.address, store?.city, store?.state]
    .filter(Boolean)
    .join(', ');

  switch (variant) {
    // Template 1: Terms and Conditions
    case 'terms_conditions':
      return `
      <section class="section">
        <div class="payment-box payment-box--terms">
          <div class="payment-label">TERM AND CONDITIONS:</div>
          <div class="payment-notes">${escapeHtml(notes || 'Payment is due 30 days from the invoice date')}</div>
        </div>
      </section>
      `.trim();
    
    // Template 2: Bank and Notes two columns
    case 'bank_notes_two_column':
      return `
      <section class="section">
        <div class="two-column">
          <div class="payment-box">
            <div class="payment-label">BANK DETAILS</div>
            ${notes ? `<div class="payment-notes">${escapeHtml(notes)}</div>` : ''}
          </div>
          <div class="payment-box">
            <div class="payment-label">NOTES:</div>
            <div class="payment-notes">Lorem ipsum dolor sit amet...</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 3: Left aligned payment instructions
    case 'left_aligned':
      return `
      <section class="section">
        <div class="payment-box payment-box--left">
          <div class="payment-label">Payment Instructions:</div>
          <div class="payment-notes">${escapeHtml(notes)}</div>
        </div>
      </section>
      `.trim();
    
    // Template 4: Contact info footer
    case 'contact_info_footer':
      return `
      <section class="section">
        <div class="payment-box payment-box--contact">
          <div class="payment-label">Payment Instructions:</div>
          <div class="payment-notes">${escapeHtml(notes)}</div>
        </div>
      </section>
      `.trim();
    
    // Template 5: Notes and Payment left
    case 'notes_payment_left':
      return `
      <section class="section">
        <div class="two-column">
          <div>
            <div class="payment-label">Note:</div>
            <div class="payment-notes" style="min-height: 60px;"></div>
            <div class="payment-label" style="margin-top: 16px;">Payment Information:</div>
            <div class="payment-notes">${escapeHtml(notes)}</div>
          </div>
          <div></div>
        </div>
      </section>
      `.trim();
    
    // Image 1: Payment Method left
    case 'payment_method_left':
      return `
      <section class="section">
        <div class="two-column">
          <div>
            <div class="payment-label">Payment Method</div>
            <div class="payment-notes">${escapeHtml(notes)}</div>
          </div>
          <div></div>
        </div>
      </section>
      `.trim();
    
    // Image 2: Payment box left, Thank you right
    case 'payment_box_left_thankyou_right':
      return `
      <section class="section">
        <div class="two-column">
          <div class="payment-box payment-box--gray">
            <div class="payment-label">Pay to: ${escapeHtml(store?.name || 'Bank')}</div>
            ${notes ? `<div class="payment-notes">${escapeHtml(notes)}</div>` : ''}
          </div>
          <div style="text-align: right; padding-top: 16px;">
            <div style="font-size: 14px; color: ${tokens.text || '#1F2937'}; font-style: italic;">Thank you for your business!</div>
          </div>
        </div>
      </section>
      `.trim();
    
    // Image 3: Payment Method and Terms left, Signature right
    case 'payment_terms_left_signature_right':
      return `
      <section class="section">
        <div class="two-column">
          <div>
            <div class="payment-label" style="margin-bottom: 8px;">Payment Method</div>
            <div class="payment-notes" style="margin-bottom: 16px;">${escapeHtml(notes)}</div>
            <div class="payment-label" style="margin-bottom: 8px;">Terms and Conditions</div>
            <div class="payment-notes" style="font-size: 11px;">Please send payment within 30 days of receiving this invoice. There will be 10% Interest charge per month on late invoice.</div>
          </div>
          <div style="text-align: right;">
            <div style="margin-bottom: 40px;"></div>
            <div style="border-top: 1px solid ${border}; padding-top: 4px; margin-bottom: 4px; width: 200px; margin-left: auto;"></div>
            <div style="font-size: 12px; color: ${text};">Administrator</div>
          </div>
        </div>
      </section>
      `.trim();
    
    default:
      return `
      <section class="section">
        <div class="payment-box">
          <div class="payment-label">Payment Instructions</div>
          <div class="payment-notes">${escapeHtml(notes)}</div>
        </div>
      </section>
      `.trim();
  }
}

function renderFooterBlock(config = {}, { invoice, store }) {
  const variant = config.variant || 'centered';
  const business = store?.name || 'MycroShop Invoice';
  const businessPhone = store?.phone || '';
  const businessEmail = store?.email || '';
  const businessAddress = [store?.address, store?.city, store?.state, store?.country]
    .filter(Boolean)
    .join(', ');

  switch (variant) {
    // Template 1: Minimal (no footer needed for this style)
    case 'minimal':
      return '';
    
    // Template 2: Minimal (no footer)
    case 'minimal_centered':
      return `
      <section class="section">
        <div class="footer footer--minimal">
          <div>Thank you for your business.</div>
        </div>
      </section>
      `.trim();
    
    // Template 3: Authorized signature
    case 'authorized_signature':
      return `
      <section class="section">
        <div class="footer footer--authorized">
          <div class="authorized-signed">Authorized Signed</div>
        </div>
      </section>
      `.trim();
    
    // Template 4: Contact grid footer
    case 'contact_grid':
      return `
      <section class="section">
        <div class="footer footer--contact-grid">
          <div class="footer-contact-grid">
            ${businessPhone ? `<div class="footer-grid-item"><strong>M:</strong> ${escapeHtml(businessPhone)}</div>` : ''}
            ${businessEmail ? `<div class="footer-grid-item"><strong>E:</strong> ${escapeHtml(businessEmail)}</div>` : ''}
            ${businessAddress ? `<div class="footer-grid-item"><strong>L:</strong> ${escapeHtml(businessAddress)}</div>` : ''}
            ${store?.website ? `<div class="footer-grid-item"><strong>W:</strong> ${escapeHtml(store.website)}</div>` : ''}
          </div>
        </div>
      </section>
      `.trim();
    
    // Template 5: Thank You large
    case 'thank_you_large':
      return `
      <section class="section">
        <div class="footer footer--thank-you-large">
          <div class="thank-you-large-footer">Thank You!</div>
        </div>
      </section>
      `.trim();
    
    case 'band_with_contact':
    case 'accent_band':
      return `
      <section class="section">
        <div class="footer footer--band">
          <div class="footer-band-content">
            ${businessEmail ? `<div class="footer-contact-item"><span class="footer-icon">✉</span> ${escapeHtml(businessEmail)}</div>` : ''}
            ${businessPhone ? `<div class="footer-contact-item"><span class="footer-icon">☎</span> ${escapeHtml(businessPhone)}</div>` : ''}
            ${businessAddress ? `<div class="footer-contact-item">${escapeHtml(businessAddress)}</div>` : ''}
          </div>
        </div>
      </section>
      `.trim();
    
    case 'signature_area':
      return `
      <section class="section">
        <div class="footer footer--signature">
          <div class="signature-area">
            <div class="signature-line"></div>
            <div class="signature-label">Administrator</div>
          </div>
          <div class="thank-you-large">THANK YOU!</div>
        </div>
        ${businessAddress || businessEmail || businessPhone ? `
        <div class="footer footer--contact">
          ${businessPhone ? `${escapeHtml(businessPhone)}` : ''}
          ${businessEmail ? `${businessPhone ? ' ' : ''}${escapeHtml(businessEmail)}` : ''}
          ${businessAddress ? `${businessPhone || businessEmail ? ' ' : ''}${escapeHtml(businessAddress)}` : ''}
        </div>
        ` : ''}
      </section>
      `.trim();
    
    case 'centered_contact':
    case 'elegant_centered':
      return `
      <section class="section">
        <div class="footer footer--centered-elegant">
          <div class="thank-you">THANK YOU FOR YOUR BUSINESS!</div>
          <div class="footer-contact-elegant">
            ${businessPhone ? `${escapeHtml(businessPhone)}` : ''}
            ${businessEmail ? `${businessPhone ? ' • ' : ''}${escapeHtml(businessEmail)}` : ''}
            ${businessAddress ? `${businessPhone || businessEmail ? ' • ' : ''}${escapeHtml(businessAddress)}` : ''}
          </div>
        </div>
      </section>
      `.trim();
    
    default:
      const cls = variant === 'left' ? 'footer footer--left' : 'footer';
      return `
      <section class="section">
        <div class="${cls}">
          <div>Thank you for your business.</div>
          <div>${escapeHtml(business)}</div>
        </div>
      </section>
      `.trim();
  }
}

module.exports = {
  renderInvoiceHtml
};


