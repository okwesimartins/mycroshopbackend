/**
 * Invoice HTML Template Library
 * Exact HTML/CSS templates with dynamic colors and logos based on user's brand
 */

/**
 * Get HTML template by ID
 * @param {string} templateId - Template identifier
 * @param {Object} data - Invoice data with logoUrl and colors
 * @returns {string} Complete HTML string
 */
function getInvoiceTemplate(templateId, data) {
  const {
    invoice,
    customer = {},
    store = {},
    items = [],
    logoUrl = null,
    colors = {}
  } = data;

  // Extract color tokens from user's logo colors or use defaults
  const primary = colors.primary || '#151b3f'; // Dark blue/navy
  const secondary = colors.secondary || '#64748b'; // Gray
  const accent = colors.accent || '#f2c94c'; // Yellow/gold
  const text = colors.text || '#111827'; // Dark gray/black
  const background = '#ffffff';
  const border = colors.border || '#e5e7eb';
  const tableHeader = primary;
  const tableRowAlt = '#f3f4f6';

  // Currency symbol
  const currency = invoice?.currency_symbol || (invoice?.currency === 'USD' ? '$' : invoice?.currency === 'GBP' ? '£' : invoice?.currency === 'EUR' ? '€' : invoice?.currency === 'NGN' ? '₦' : '$');

  // Business info
  const businessName = store?.name || 'Company Name';
  const businessTagline = store?.description || 'Creative Company';
  const customerName = customer?.name || 'Customer';
  const customerAddress = [customer?.address, customer?.city, customer?.state, customer?.country].filter(Boolean).join(', ');
  const customerEmail = customer?.email || '';
  const customerPhone = customer?.phone || '';

  // Invoice totals
  const subtotal = Number(invoice?.subtotal || 0);
  const tax = Number(invoice?.tax_amount || 0);
  const invoiceTotal = Number(invoice?.total || 0);
  const discount = Number(invoice?.discount_amount || 0);

  // Logo HTML - use actual logo or placeholder
  const logoHtml = logoUrl 
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" style="width:44px;height:44px;object-fit:contain;border-radius:50%;border:2px solid ${text};" />`
    : `<div style="width:44px;height:44px;border-radius:50%;border:2px solid ${text};display:grid;place-items:center;background:${primary}20;">
         <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
           <path d="M6 20c1.5-5.5 3.5-8 6-8s4.5 2.5 6 8" stroke="${text}" stroke-width="2" stroke-linecap="round"/>
           <path d="M8 7c0 2 1.8 3.5 4 3.5S16 9 16 7c0-2-1.8-3.5-4-3.5S8 5 8 7Z" stroke="${text}" stroke-width="2"/>
           <path d="M5 5h14" stroke="${text}" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </div>`;

  // Generate items rows
  const itemsRows = items.map(item => `
    <tr>
      <td>${escapeHtml(item.item_name || 'Item')}</td>
      <td class="col-qty">${Number(item.quantity || 0).toLocaleString()}</td>
      <td class="col-price">${currency} ${Number(item.unit_price || 0).toFixed(2)}</td>
      <td class="col-total">${currency} ${Number(item.total || 0).toFixed(2)}</td>
    </tr>
  `).join('');

  // Payment notes
  const notes = invoice?.notes || '';
  const paymentNotes = notes.split('\n').filter(line => line.trim()).join('<br>') || `Bank Name: ${escapeHtml(store?.name || 'Bank Name')}<br>Account No: 1234567890`;

  switch (templateId) {
    case 'template_1':
    case 'thyx_geometric':
      return getTemplate1({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, currency, subtotal, tax, invoiceTotal, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes });
    
    case 'template_2':
    case 'salford_yellow':
      return getTemplate2({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, customerEmail, customerPhone, currency, subtotal, tax, invoiceTotal, discount, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes });
    
    case 'template_3':
    case 'salford_olive':
      return getTemplate3({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, customerPhone, currency, subtotal, tax, invoiceTotal, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes });
    
    case 'template_4':
    case 'studio_shodwe':
      return getTemplate4({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, customerEmail, customerPhone, currency, subtotal, tax, invoiceTotal, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes });
    
    default:
      return getTemplate1({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, currency, subtotal, tax, invoiceTotal, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes });
  }
}

/**
 * Template 1: THYX Style - Dark blue with yellow accent, geometric header
 * Exact HTML from user's first template
 */
function getTemplate1({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, currency, subtotal, tax, invoiceTotal, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${escapeHtml(invoice?.invoice_number || '')}</title>
  <style>
    :root{
      --navy:${primary};
      --yellow:${accent};
      --ink:${text};
      --muted:#6b7280;
      --line:${border};
      --row:${tableRowAlt};
    }

    *{box-sizing:border-box}
    body{
      margin:0;
      padding:32px;
      background:#f6f7fb;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color:var(--ink);
    }

    /* Page */
    .invoice-page{
      width: 820px;
      max-width: 100%;
      margin: 0 auto;
      background:#fff;
      border:1px solid #d7dbe3;
      border-radius:10px;
      overflow:hidden;
    }

    /* Top header */
    .header{
      position:relative;
      padding:28px 34px 18px;
      min-height:120px;
      background:#fff;
    }

    /* Dark shape on the right with diagonal edge */
    .header-shape{
      position:absolute;
      top:0;
      right:0;
      height:120px;
      width:58%;
      background:var(--navy);
      /* diagonal edge */
      clip-path: polygon(26% 0, 100% 0, 100% 100%, 0 100%, 0 62%);
      border-top-right-radius: 10px;
    }

    /* Small yellow bar inside the shape */
    .header-shape .accent{
      position:absolute;
      left:0;
      bottom:20px;
      height:6px;
      width:140px;
      background:var(--yellow);
    }

    .header-shape .title{
      position:absolute;
      right:44px;
      top:34px;
      color:#fff;
      font-weight:800;
      letter-spacing:.04em;
      font-size:28px;
    }

    /* Brand area (left) */
    .brand{
      position:relative;
      z-index:2;
      display:flex;
      align-items:center;
      gap:12px;
      max-width: 320px;
    }

    .logo{
      width:44px;
      height:44px;
      border-radius:50%;
      border:2px solid var(--ink);
      display:grid;
      place-items:center;
    }

    /* simple "W" mark */
    .logo svg{display:block}

    .brand-name{
      font-weight:900;
      font-size:28px;
      letter-spacing:.02em;
      line-height:1;
    }
    .brand-tag{
      font-size:10px;
      letter-spacing:.14em;
      text-transform:uppercase;
      color:var(--muted);
      margin-top:4px;
      font-weight:700;
    }

    /* Content */
    .content{
      padding:18px 34px 26px;
    }

    .meta{
      display:grid;
      grid-template-columns: 1.4fr 1fr 1fr;
      gap:18px;
      align-items:end;
      margin-top:6px;
      margin-bottom:14px;
    }

    .meta .label{
      font-size:11px;
      color:var(--muted);
      font-weight:800;
      letter-spacing:.04em;
      text-transform:uppercase;
      margin-bottom:4px;
    }

    .meta .big{
      font-size:18px;
      font-weight:900;
      letter-spacing:.01em;
    }

    .meta .right{
      text-align:right;
    }

    .meta .due{
      font-size:16px;
      font-weight:900;
    }

    /* Table */
    table{
      width:100%;
      border-collapse:separate;
      border-spacing:0;
      font-size:13px;
      margin-top:10px;
    }

    thead th{
      background:var(--navy);
      color:#fff;
      padding:10px 12px;
      text-align:left;
      font-weight:800;
      font-size:12px;
    }
    thead th + th{border-left:3px solid #fff;} /* white dividers like the image */

    tbody td{
      padding:10px 12px;
      border-bottom:1px solid var(--line);
    }

    tbody tr:nth-child(even) td{
      background:var(--row);
    }

    .col-qty, .col-price, .col-total{
      text-align:right;
      white-space:nowrap;
      width: 14%;
    }

    .col-desc{width:58%}

    /* Bottom area */
    .bottom{
      display:grid;
      grid-template-columns: 1.3fr .9fr;
      gap:18px;
      margin-top:18px;
      align-items:start;
    }

    .payment h4{
      margin:0 0 6px;
      font-size:12px;
      color:var(--muted);
      text-transform:uppercase;
      letter-spacing:.05em;
    }
    .payment p{
      margin:2px 0;
      font-size:12px;
      color:#374151;
    }

    .summary{
      margin-left:auto;
      width: 100%;
      max-width: 260px;
      font-size:12px;
    }

    .summary-row{
      display:flex;
      justify-content:space-between;
      padding:6px 0;
      border-bottom:1px solid var(--line);
      color:#111827;
      font-weight:700;
    }
    .summary-row span:first-child{
      color:#374151;
      font-weight:700;
    }

    .grand{
      display:flex;
      justify-content:flex-end;
      margin-top:10px;
    }
    .grand .box{
      background:var(--navy);
      color:#fff;
      font-weight:900;
      padding:10px 16px;
      border-radius:2px;
      min-width:140px;
      text-align:right;
      letter-spacing:.02em;
    }

    /* Footer bar */
    .footer-bar{
      height:70px;
      background:var(--navy);
    }

    /* Print friendly */
    @media print{
      body{background:#fff; padding:0}
      .invoice-page{border:none; border-radius:0}
    }
  </style>
</head>

<body>
  <div class="invoice-page">
    <div class="header">
      <div class="header-shape" aria-hidden="true">
        <div class="accent"></div>
        <div class="title">INVOICE</div>
      </div>

      <div class="brand">
        ${logoHtml}
        <div>
          <div class="brand-name">${escapeHtml(businessName)}</div>
          <div class="brand-tag">${escapeHtml(businessTagline)}</div>
        </div>
      </div>
    </div>

    <div class="content">
      <div class="meta">
        <div>
          <div class="label">Invoice to :</div>
          <div class="big">${escapeHtml(customerName)}</div>
        </div>

        <div class="right">
          <div class="label">Date :</div>
          <div style="font-weight:800;">${escapeHtml(invoice?.issue_date || '')}</div>
        </div>

        <div class="right">
          <div class="label">Total due :</div>
          <div class="due">${currency} ${invoiceTotal.toLocaleString()}</div>
        </div>
      </div>

      <table class="items">
        <thead>
          <tr>
            <th class="col-desc">Description</th>
            <th class="col-qty">Qty</th>
            <th class="col-price">Price</th>
            <th class="col-total">Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>

      <div class="bottom">
        <div class="payment">
          <h4>Payment Method</h4>
          <p>${paymentNotes}</p>
        </div>

        <div class="summary">
          <div class="summary-row"><span>Sub-total :</span><span>${currency} ${subtotal.toLocaleString()}</span></div>
          <div class="summary-row"><span>Tax :</span><span>${currency} ${tax.toLocaleString()}</span></div>
          <div class="grand">
            <div class="box">${currency} ${invoiceTotal.toLocaleString()}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="footer-bar" aria-hidden="true"></div>
  </div>
</body>
</html>`;
}

/**
 * Template 2: Salford & Co. Style - Yellow and navy with top strip
 * Exact HTML from user's second template
 */
function getTemplate2({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, customerEmail, customerPhone, currency, subtotal, tax, invoiceTotal, discount, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes }) {
  // Extract payment details from notes
  const paymentLines = paymentNotes.split('<br>');
  const accountNo = paymentLines.find(l => l.toLowerCase().includes('account'))?.split(':')[1]?.trim() || '123-456-7890';
  const accountName = customerName;
  const branchName = businessName;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${escapeHtml(invoice?.invoice_number || '')}</title>
  <style>
    :root{
      --navy:${primary};
      --yellow:${accent};
      --ink:${text};
      --muted:#6b7280;
      --line:${border};
      --soft:${tableRowAlt};
    }

    *{box-sizing:border-box}
    body{
      margin:0;
      padding:32px;
      background:#f5f6fb;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color:var(--ink);
    }

    /* Page */
    .page{
      width: 860px;
      max-width: 100%;
      margin: 0 auto;
      background:#fff;
      border:1px solid #d7dbe3;
      border-radius:14px;
      overflow:hidden;
    }

    /* Top thin yellow strip */
    .top-strip{
      height:14px;
      background:var(--yellow);
      position:relative;
    }
    .top-strip:after{
      content:"";
      position:absolute;
      left:50%;
      top:0;
      transform:translateX(-50%);
      width:0;height:0;
      border-left:18px solid transparent;
      border-right:18px solid transparent;
      border-top:14px solid ${accent}dd;
      opacity:.9;
    }

    /* Header navy area */
    .header{
      background:var(--navy);
      color:#fff;
      padding:22px 30px 18px;
      position:relative;
    }

    .header-grid{
      display:grid;
      grid-template-columns: 1.2fr 1fr;
      gap:18px;
      align-items:start;
    }

    .brand{
      display:flex;
      gap:12px;
      align-items:flex-start;
    }

    .logo{
      width:42px;
      height:42px;
      border-radius:10px;
      background:rgba(255,255,255,.08);
      display:grid;
      place-items:center;
    }

    /* Simple A-like mark */
    .logo svg{display:block}

    .brand-name{
      font-weight:900;
      letter-spacing:.01em;
      line-height:1.1;
      font-size:18px;
    }
    .brand-sub{
      margin-top:4px;
      font-size:11px;
      color:rgba(255,255,255,.75);
      line-height:1.3;
    }

    .invoice-title{
      text-align:right;
    }
    .invoice-title .title{
      font-size:30px;
      font-weight:900;
      letter-spacing:.06em;
      color:var(--yellow);
      margin-bottom:6px;
    }
    .invoice-meta{
      font-size:11px;
      line-height:1.55;
      color:rgba(255,255,255,.85);
    }
    .invoice-meta b{color:#fff}

    /* Address band */
    .address-band{
      background:var(--yellow);
      color:#111827;
      padding:10px 30px;
      font-size:12px;
      font-weight:800;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      position:relative;
    }
    .address-band .left{
      display:flex;
      align-items:center;
      gap:8px;
      min-width:0;
    }
    .pin{
      width:18px;height:18px;
      border-radius:50%;
      background:rgba(0,0,0,.12);
      display:grid;
      place-items:center;
      font-size:12px;
    }

    /* Three yellow slashes on the right (inside navy header area in the image) */
    .slashes{
      position:absolute;
      right:22px;
      top:50%;
      transform:translateY(-50%);
      display:flex;
      gap:6px;
      pointer-events:none;
    }
    .slashes span{
      width:7px;
      height:26px;
      background:rgba(16,31,74,.9);
      border-radius:2px;
      transform:skewX(-20deg);
      box-shadow:0 0 0 1px rgba(0,0,0,.03);
    }

    /* Body */
    .content{
      padding:18px 30px 22px;
    }

    .two-col{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap:18px;
      margin-top:6px;
    }

    .card{
      padding:10px 12px;
      border:1px solid var(--line);
      border-radius:10px;
      background:#fff;
    }

    .k-title{
      font-size:11px;
      font-weight:900;
      letter-spacing:.05em;
      text-transform:uppercase;
      color:#374151;
      margin-bottom:8px;
    }

    .kv{
      display:grid;
      grid-template-columns: 90px 1fr;
      gap:6px 10px;
      font-size:12px;
      color:#111827;
      align-items:center;
    }
    .kv .k{color:var(--muted); font-weight:700}
    .kv .v{font-weight:800}

    /* Table */
    table{
      width:100%;
      border-collapse:separate;
      border-spacing:0;
      margin-top:14px;
      font-size:12px;
    }
    thead th{
      background:var(--navy);
      color:#fff;
      padding:9px 10px;
      text-align:left;
      font-weight:900;
      font-size:11px;
      letter-spacing:.03em;
    }
    thead th:first-child{border-top-left-radius:8px}
    thead th:last-child{border-top-right-radius:8px}
    tbody td{
      padding:9px 10px;
      border-bottom:1px solid var(--line);
      background:#fff;
    }
    tbody tr:nth-child(even) td{background:var(--soft)}
    .num{text-align:right; white-space:nowrap;}

    /* Bottom area */
    .bottom{
      display:grid;
      grid-template-columns: 1.1fr .9fr;
      gap:18px;
      margin-top:16px;
      align-items:start;
    }

    .terms p{
      margin:0 0 8px;
      font-size:11px;
      color:#374151;
      line-height:1.45;
    }
    .thanks{
      margin-top:10px;
      font-weight:900;
      font-size:11px;
      letter-spacing:.04em;
    }
    .contact-mini{
      margin-top:8px;
      font-size:11px;
      color:#374151;
      line-height:1.55;
    }

    .totals{
      border:1px solid var(--line);
      border-radius:10px;
      overflow:hidden;
    }
    .totals .row{
      display:flex;
      justify-content:space-between;
      padding:9px 12px;
      font-size:12px;
      background:#fff;
      border-bottom:1px solid var(--line);
      font-weight:800;
    }
    .totals .row span:first-child{color:#374151}
    .totals .row:last-child{border-bottom:none}
    .totals .row.total{
      background:var(--navy);
      color:#fff;
      font-weight:900;
    }

    /* Signature row */
    .signature{
      margin-top:14px;
      display:flex;
      justify-content:flex-end;
      font-size:11px;
      color:#374151;
    }
    .signature b{color:#111827}

    /* Bottom strips */
    .footer{
      position:relative;
      height:18px;
      background:var(--yellow);
    }
    .footer:before{
      content:"";
      position:absolute;
      left:0;
      top:-18px;
      height:18px;
      width:100%;
      background:transparent;
      /* small navy tabs like the image */
      background:
        linear-gradient(90deg, transparent 0 72%, var(--navy) 72% 74%, transparent 74% 76%, var(--navy) 76% 78%, transparent 78% 100%);
      opacity:.95;
    }

    @media print{
      body{background:#fff; padding:0}
      .page{border:none}
    }
  </style>
</head>

<body>
  <div class="page">
    <div class="top-strip"></div>

    <div class="header">
      <div class="header-grid">
        <div class="brand">
          ${logoHtml}
          <div>
            <div class="brand-name">${escapeHtml(businessName)}</div>
            <div class="brand-sub">
              Invoice To<br>
              <b>${escapeHtml(customerName)}</b><br>
              ${escapeHtml(businessTagline)}
            </div>
          </div>
        </div>

        <div class="invoice-title">
          <div class="title">INVOICE</div>
          <div class="invoice-meta">
            Invoice No: <b>#${escapeHtml(invoice?.invoice_number || '')}</b><br>
            Due Date: <b>${escapeHtml(invoice?.due_date || '')}</b><br>
            Invoice Date: <b>${escapeHtml(invoice?.issue_date || '')}</b>
          </div>
        </div>
      </div>
    </div>

    <div class="address-band">
      <div class="left">
        <div class="pin">📍</div>
        <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${escapeHtml(customerAddress || '123 Anywhere St., Any City, ST 12345')}
        </div>
      </div>
      <div class="slashes" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>

    <div class="content">
      <div class="two-col">
        <div class="card">
          <div class="k-title">Contact</div>
          <div class="kv">
            <div class="k">Phone:</div><div class="v">${escapeHtml(customerPhone || '+123-456-7890')}</div>
            <div class="k">Email:</div><div class="v">${escapeHtml(customerEmail || 'hello@realyfreestate.com')}</div>
            <div class="k">Address:</div><div class="v">${escapeHtml(customerAddress || '123 Anywhere St., Any City')}</div>
          </div>
        </div>

        <div class="card">
          <div class="k-title">Payment Method</div>
          <div class="kv">
            <div class="k">Account No:</div><div class="v">${escapeHtml(accountNo)}</div>
            <div class="k">Account Name:</div><div class="v">${escapeHtml(accountName)}</div>
            <div class="k">Branch Name:</div><div class="v">${escapeHtml(branchName)}</div>
          </div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style="width:46%;">Description</th>
            <th class="num" style="width:18%;">Subtotal</th>
            <th class="num" style="width:12%;">Qty</th>
            <th class="num" style="width:24%;">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>

      <div class="bottom">
        <div class="terms">
          <div class="k-title">Term and Conditions</div>
          <p>
            Please send payment within 30 days of receiving this invoice. There will be a 10% interest charge per month on late invoice.
          </p>
          <div class="thanks">THANK YOU FOR YOUR BUSINESS</div>

          <div class="contact-mini">
            📞 ${escapeHtml(customerPhone || '+123-456-7890')}<br>
            🌐 ${escapeHtml(store?.website || 'www.realyfreestate.com')}<br>
            📍 ${escapeHtml(customerAddress || '123 Anywhere St., Any City, ST 12345')}
          </div>
        </div>

        <div>
          <div class="totals">
            <div class="row"><span>Sub-total:</span><span>${currency} ${subtotal.toFixed(2)}</span></div>
            <div class="row"><span>Discount:</span><span>${currency} ${discount.toFixed(2)}</span></div>
            <div class="row"><span>Tax (${subtotal > 0 ? Math.round((tax/subtotal)*100) : 10}%):</span><span>${currency} ${tax.toFixed(2)}</span></div>
            <div class="row total"><span>Total:</span><span>${currency} ${invoiceTotal.toFixed(2)}</span></div>
          </div>

          <div class="signature">
            <div>
              <b>${escapeHtml(customerName || 'Marceline Anderson')}</b><br>
              Administrator
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="footer"></div>
  </div>
</body>
</html>`;
}

/**
 * Template 3: Salford & Co. Olive Style - Dark gray with olive green
 * Exact HTML from user's third template
 */
function getTemplate3({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, customerPhone, currency, subtotal, tax, invoiceTotal, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes }) {
  // Use olive green as accent if available, otherwise use accent color
  const olive = accent || '#9bb42f';
  const dark = primary || '#2f2f2f';

  // Extract payment details
  const paymentLines = paymentNotes.split('<br>');
  const bankName = paymentLines.find(l => l.toLowerCase().includes('bank'))?.split(':')[1]?.trim() || `${businessName} Bank`;
  const accountName = paymentLines.find(l => l.toLowerCase().includes('account name'))?.split(':')[1]?.trim() || customerName;
  const accountNumber = paymentLines.find(l => l.toLowerCase().includes('account no') || l.toLowerCase().includes('account number'))?.split(':')[1]?.trim() || '123456789';

  // Generate numbered items rows
  const numberedItemsRows = items.map((item, index) => `
    <tr>
      <td class="no">${index + 1}</td>
      <td class="desc">${escapeHtml(item.item_name || 'ITEM/SERVICE')}<br><span class="muted">${escapeHtml(item.description || 'Description here')}</span></td>
      <td class="num">${currency} ${Number(item.unit_price || 0).toFixed(2)}</td>
      <td class="num">${Number(item.quantity || 0).toLocaleString()}</td>
      <td class="num">${currency} ${Number(item.total || 0).toFixed(2)}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${escapeHtml(invoice?.invoice_number || '')}</title>
  <style>
    :root{
      --dark:${dark};
      --olive:${olive};
      --ink:${text};
      --muted:#6b7280;
      --line:${border};
      --soft:${tableRowAlt};
    }

    *{box-sizing:border-box}
    body{
      margin:0;
      padding:32px;
      background:#f5f6fb;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color:var(--ink);
    }

    .page{
      width: 860px;
      max-width: 100%;
      margin: 0 auto;
      background:#fff;
      border:1px solid #d7dbe3;
      border-radius:16px;
      overflow:hidden;
      position:relative;
    }

    /* Top rounded bands */
    .top-band{
      position:relative;
      height:86px;
      background:#fff;
    }

    .brand-pill{
      position:absolute;
      left:22px;
      top:16px;
      width: 360px;
      height:62px;
      background:var(--dark);
      border-radius:18px;
      display:flex;
      align-items:center;
      gap:12px;
      padding:14px 16px;
      color:#fff;
    }

    .leaf{
      width:34px;
      height:34px;
      border-radius:10px;
      background:rgba(255,255,255,.08);
      display:grid;
      place-items:center;
      flex:0 0 auto;
    }
    .leaf svg{display:block}

    .brand-text .name{
      font-weight:900;
      letter-spacing:.03em;
      font-size:14px;
      line-height:1.1;
    }
    .brand-text .tag{
      font-size:9px;
      color:rgba(255,255,255,.65);
      letter-spacing:.12em;
      text-transform:uppercase;
      margin-top:3px;
      font-weight:700;
    }

    .invoice-pill{
      position:absolute;
      right:22px;
      top:10px;
      width: 280px;
      height:70px;
      background:#fff;
      border:1px solid #eef0f4;
      border-radius:18px;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:28px;
      font-weight:900;
      letter-spacing:.06em;
      color:#111827;
      box-shadow: 0 8px 16px rgba(17,24,39,.06);
    }

    .content{
      padding:10px 26px 18px;
    }

    .meta{
      display:grid;
      grid-template-columns: 1.1fr 1fr;
      gap:16px;
      margin-top:6px;
      margin-bottom:14px;
    }

    .meta h4{
      margin:0 0 6px;
      font-size:11px;
      letter-spacing:.06em;
      text-transform:uppercase;
      color:#374151;
      font-weight:900;
    }

    .meta .small{
      font-size:11px;
      color:#374151;
      line-height:1.55;
    }
    .meta .small b{color:#111827}

    .meta-left .invno{
      margin-top:8px;
      font-size:12px;
      color:#111827;
      font-weight:900;
      letter-spacing:.03em;
    }

    .meta-right{
      text-align:left;
      justify-self:end;
      width: 320px;
    }

    /* Table */
    table{
      width:100%;
      border-collapse:separate;
      border-spacing:0;
      font-size:12px;
      margin-top:8px;
      overflow:hidden;
      border-radius:10px;
      border:1px solid #eef0f4;
    }

    thead th{
      background:var(--olive);
      color:#111827;
      padding:9px 10px;
      text-align:left;
      font-weight:900;
      font-size:11px;
      letter-spacing:.03em;
    }

    tbody td{
      padding:9px 10px;
      border-top:1px solid #eef0f4;
      background:#fff;
      color:#111827;
    }
    tbody tr:nth-child(even) td{background:#fafafa}

    .num{text-align:right; white-space:nowrap;}
    .no{width:56px; text-align:center; color:#374151; font-weight:900;}
    .desc{width:44%; font-weight:800; letter-spacing:.01em;}
    .muted{color:var(--muted); font-weight:700}

    /* Totals card */
    .lower{
      display:grid;
      grid-template-columns: 1.2fr .8fr;
      gap:18px;
      margin-top:16px;
      align-items:end;
    }

    .notes h4{
      margin:0 0 6px;
      font-size:11px;
      letter-spacing:.06em;
      text-transform:uppercase;
      color:#374151;
      font-weight:900;
    }

    .notes .grid{
      display:grid;
      grid-template-columns: 92px 1fr;
      gap:6px 10px;
      font-size:11px;
      color:#374151;
      line-height:1.35;
    }
    .notes .grid .k{color:var(--muted); font-weight:800}
    .notes .grid .v{font-weight:800; color:#111827}

    .terms{
      margin-top:10px;
      font-size:10.5px;
      color:#4b5563;
      line-height:1.45;
      max-width: 520px;
    }

    .totals{
      border:1px solid #eef0f4;
      border-radius:10px;
      overflow:hidden;
      width: 100%;
      max-width: 300px;
      margin-left:auto;
      background:#fff;
    }

    .totals .row{
      display:flex;
      justify-content:space-between;
      padding:9px 12px;
      font-size:11px;
      border-bottom:1px solid #eef0f4;
      font-weight:900;
    }
    .totals .row span:first-child{color:#374151}
    .totals .row:last-child{border-bottom:none}
    .totals .due{
      background: #e9efcf;
      border-top:1px solid #dbe5b0;
      font-size:12px;
    }
    .totals .due strong{color:#111827}
    .totals .due .amount{
      font-weight:1000;
      color:#111827;
    }

    /* Signature */
    .sig{
      display:flex;
      justify-content:flex-end;
      gap:16px;
      align-items:flex-end;
      margin-top:10px;
    }
    .sig .scribble{
      width: 120px;
      height: 54px;
      border-bottom:2px solid #d1d5db;
      transform:rotate(-2deg);
      position:relative;
    }
    .sig .scribble:after{
      content:"";
      position:absolute;
      left:10px;
      top:6px;
      width:92px;
      height:32px;
      border:2px solid #111827;
      border-color:#111827 transparent transparent transparent;
      border-radius:80px;
      transform:rotate(-12deg);
      opacity:.9;
    }
    .sig .name{
      font-size:11px;
      color:#374151;
      text-align:right;
      line-height:1.2;
    }
    .sig .name b{color:#111827}

    /* Bottom dark footer */
    .footer{
      margin-top:16px;
      background:var(--dark);
      color:#fff;
      padding:14px 26px;
      text-align:center;
      font-size:11px;
      border-top-left-radius:16px;
      border-top-right-radius:16px;
    }
    .footer .thanks{
      font-weight:900;
      letter-spacing:.06em;
      text-transform:uppercase;
      margin-bottom:8px;
    }
    .footer .meta{
      margin:0;
      display:block;
      font-size:10.5px;
      color:rgba(255,255,255,.75);
    }

    @media print{
      body{background:#fff; padding:0}
      .page{border:none}
    }
  </style>
</head>

<body>
  <div class="page">
    <div class="top-band">
      <div class="brand-pill">
        ${logoHtml}
        <div class="brand-text">
          <div class="name">${escapeHtml(businessName.toUpperCase())}</div>
          <div class="tag">${escapeHtml(businessTagline)}</div>
        </div>
      </div>

      <div class="invoice-pill">INVOICE</div>
    </div>

    <div class="content">
      <div class="meta">
        <div class="meta-left">
          <div class="invno">INVOICE # &nbsp;${escapeHtml(invoice?.invoice_number || '001')}</div>

          <div class="small" style="margin-top:8px;">
            <div><b>INVOICE DATE</b> &nbsp;&nbsp;|&nbsp;&nbsp; ${escapeHtml(invoice?.issue_date || '')}</div>
            <div><b>DUE DATE</b> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp; ${escapeHtml(invoice?.due_date || '')}</div>
          </div>
        </div>

        <div class="meta-right">
          <h4>Bill To</h4>
          <div class="small">
            <b>${escapeHtml(customerName)}</b><br>
            ${escapeHtml(customerAddress || '123 Anywhere St., Any City, ST 12345')}<br>
            ${escapeHtml(customerPhone || '123-456-7890')}
          </div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th class="no">NO</th>
            <th>DESCRIPTION</th>
            <th class="num">PRICE</th>
            <th class="num">QTY</th>
            <th class="num">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          ${numberedItemsRows}
        </tbody>
      </table>

      <div class="lower">
        <div class="notes">
          <h4>Payment Method</h4>
          <div class="grid">
            <div class="k">Bank</div><div class="v">${escapeHtml(bankName)}</div>
            <div class="k">Account Name</div><div class="v">${escapeHtml(accountName)}</div>
            <div class="k">Account Number</div><div class="v">${escapeHtml(accountNumber)}</div>
          </div>

          <h4 style="margin-top:12px;">Term and Conditions</h4>
          <div class="terms">
            Please make the payment by the due date on the receipt below. We accept bank transfer, credit card, or check.
          </div>
        </div>

        <div>
          <div class="totals">
            <div class="row"><span>SUB-TOTAL</span><span>${currency} ${subtotal.toFixed(2)}</span></div>
            <div class="row"><span>TAX (${subtotal > 0 ? Math.round((tax/subtotal)*100) : 10}%)</span><span>${currency} ${tax.toFixed(2)}</span></div>
            <div class="row due"><span><strong>Total Due</strong></span><span class="amount">${currency} ${invoiceTotal.toFixed(2)}</span></div>
          </div>

          <div class="sig">
          
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      <div class="thanks">THANK YOU FOR YOUR BUSINESS</div>
      <div class="meta">
        ${escapeHtml(customerAddress || '123 Anywhere St., Any City')} • ${escapeHtml(customerPhone || '123-456-7890')} • ${escapeHtml(customerEmail || 'hello@reallygreatsite.com')}
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Template 4: Studio Shodwe Style - Red and navy with curved header
 * Exact HTML from user's fourth template
 */
function getTemplate4({ invoice, customer, store, items, logoHtml, businessName, businessTagline, customerName, customerAddress, customerEmail, customerPhone, currency, subtotal, tax, invoiceTotal, primary, accent, text, tableHeader, tableRowAlt, border, itemsRows, paymentNotes }) {
  // Use red as accent, navy as primary
  const navy = primary || '#0f2b46';
  const navy2 = '#0b2238';
  const red = accent || '#e3212b';

  // Extract payment details
  const paymentLines = paymentNotes.split('<br>');
  const bankName = paymentLines.find(l => l.toLowerCase().includes('bank'))?.split(':')[1]?.trim() || 'Reallygreatsite';
  const accountNo = paymentLines.find(l => l.toLowerCase().includes('account no') || l.toLowerCase().includes('account number'))?.split(':')[1]?.trim() || '1234567890';

  // Generate items rows for this template format
  const itemRows = items.map((item, index) => `
    <div class="row">
      <div class="desc">Item ${String(index + 1).padStart(2, '0')}</div>
      <div class="num">${Number(item.quantity || 0).toLocaleString()}</div>
      <div class="num">${currency} ${Number(item.unit_price || 0).toFixed(2)}</div>
      <div class="num money">${currency} ${Number(item.total || 0).toFixed(2)}</div>
    </div>
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Invoice ${escapeHtml(invoice?.invoice_number || '')}</title>

  <style>
    :root{
      --navy:${navy};
      --navy2:${navy2};
      --red:${red};
      --ink:${text};
      --muted:#6b7280;
      --line:#e7ebf3;
      --soft:#f6f8fc;
    }

    *{box-sizing:border-box}
    body{
      margin:0;
      padding:32px;
      background:#f4f6fb;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color:var(--ink);
    }

    /* PAGE */
    .page{
      width:860px;
      max-width:100%;
      margin:0 auto;
      background:#fff;
      border:1px solid #d7dbe3;
      border-radius:16px;
      overflow:hidden;
    }

    /* =======================
       HEADER (matches image)
       ======================= */
    .header-row{
      position:relative;
      height:112px;              /* navy block height */
      display:flex;
      overflow:visible;          /* allow red curve to hang down */
    }

    /* top-left navy block */
    .brandbar{
      width:290px;
      height:112px;
      background:var(--navy);
      color:#fff;
      padding:22px 22px;
      display:flex;
      align-items:flex-start;
      gap:12px;
    }
    .brandbar .logo{
      width:36px;height:36px;
      border-radius:50%;
      background:rgba(255,255,255,.10);
      display:grid;
      place-items:center;
      flex:0 0 auto;
      margin-top:1px;
    }
    .brandbar .name{
      margin-top:6px;
      font-weight:900;
      letter-spacing:.06em;
      text-transform:uppercase;
      font-size:11px;
      line-height:1.15;
      opacity:.95;
    }

    /* top-right red block with big rounded bottom */
    .redbar{
      flex:1;
      background:var(--red);
      height:148px;                 /* taller so the curve drops into white */
      padding:20px 26px 18px 34px;
      position:relative;
      border-bottom-left-radius:58px;
      border-bottom-right-radius:58px;
    }

    .redbar h1{
      margin:0;
      font-size:44px;
      font-weight:1000;
      letter-spacing:.05em;
      line-height:1;
      color:#fff;
    }

    .redbar .underline{
      height:3px;
      width:92px;
      background:#fff;
      border-radius:999px;
      margin:12px 0 14px;
      opacity:.95;
    }

    .meta-grid{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap:10px 26px;
      max-width: 390px;
      color:#fff;
      font-size:11px;
      opacity:.95;
    }
    .meta-grid .k{
      font-weight:900;
      letter-spacing:.06em;
      text-transform:uppercase;
      font-size:10px;
      opacity:.9;
    }
    .meta-grid .v{
      margin-top:2px;
      font-weight:800;
      opacity:.95;
      white-space:nowrap;
    }

    /* GRAND TOTAL pill INSIDE the red bar (not floating outside) */
    .grand-pill{
      position:absolute;
      right:26px;
      bottom:18px;
      background:var(--navy);
      color:#fff;
      border-radius:999px;
      padding:10px 18px;
      min-width:240px;
      text-align:center;
      box-shadow:0 10px 20px rgba(15,23,42,.18);
    }
    /* the thin red vertical line at the far right of the pill */
    .grand-pill::after{
      content:"";
      position:absolute;
      right:12px;
      top:50%;
      transform:translateY(-50%);
      width:3px;
      height:30px;
      background:var(--red);
      border-radius:2px;
      opacity:.95;
    }
    .grand-pill .k{
      font-size:10px;
      font-weight:900;
      letter-spacing:.06em;
      text-transform:uppercase;
      opacity:.85;
    }
    .grand-pill .v{
      margin-top:4px;
      font-size:13px;
      font-weight:1000;
      letter-spacing:.02em;
    }

    /* =======================
       BODY
       ======================= */
    .content{
      padding:28px 26px 0; /* extra top padding so content doesn't collide with red curve */
    }

    .invoice-to{
      max-width: 360px;
      font-size:11px;
    }
    .invoice-to .label{
      font-weight:900;
      letter-spacing:.06em;
      text-transform:uppercase;
      font-size:10px;
      color:var(--navy);
    }
    .invoice-to .who{
      margin-top:6px;
      font-size:18px;
      font-weight:900;
      color:var(--red);
      line-height:1.2;
    }
    .invoice-to .muted{
      margin-top:8px;
      color:#6b7280;
      line-height:1.65;
      font-weight:700;
    }

    /* table head pill */
    .thead{
      margin-top:18px;
      display:grid;
      grid-template-columns: 1fr 110px 110px 120px;
      border-radius:999px;
      overflow:hidden;
      background:var(--navy);
    }
    .thead div{
      padding:10px 14px;
      color:#fff;
      font-size:11px;
      font-weight:900;
      letter-spacing:.05em;
      text-transform:uppercase;
      text-align:center;
    }
    .thead div:first-child{text-align:left;}
    .thead .total{background:var(--red);}

    .rows{
      margin-top:10px;
      border:1px solid #eef1f6;
      border-radius:10px;
      overflow:hidden;
    }
    .row{
      display:grid;
      grid-template-columns: 1fr 110px 110px 120px;
      padding:10px 14px;
      border-top:1px solid #eef1f6;
      font-size:12px;
      background:#fff;
      align-items:center;
    }
    .row:first-child{border-top:none;}
    .row:nth-child(even){background:#f8fafc;}
    .row .desc{color:#6b7280; font-weight:800;}
    .row .num{text-align:center; font-weight:900; color:#111827; white-space:nowrap;}
    .row .money{text-align:right;}

    .mid{
      display:grid;
      grid-template-columns: 1.25fr .75fr;
      gap:18px;
      padding:18px 0 22px;
      align-items:start;
    }

    .bullets{
      font-size:11px;
      color:#374151;
    }
    .bullet{
      display:flex;
      gap:10px;
      margin:10px 0;
      line-height:1.45;
    }
    .dot{
      width:8px;height:8px;border-radius:50%;
      background:var(--red);
      margin-top:5px;
      flex:0 0 auto;
    }
    .bullets h4{
      margin:0 0 4px;
      font-size:11px;
      font-weight:900;
      letter-spacing:.06em;
      text-transform:uppercase;
      color:#111827;
    }
    .bullets b{font-weight:900; color:#111827;}

    .side{
      display:flex;
      flex-direction:column;
      align-items:flex-end;
      gap:12px;
    }
    .totals{
      width:260px;
      border-radius:12px;
      overflow:hidden;
      background:var(--navy);
      color:#fff;
      box-shadow:0 10px 20px rgba(15,23,42,.12);
    }
    .totals .r{
      display:flex;
      justify-content:space-between;
      padding:10px 14px;
      font-size:11px;
      border-bottom:1px solid rgba(255,255,255,.10);
      font-weight:900;
      opacity:.95;
    }
    .totals .r:last-child{border-bottom:none;}
    .totals .total{
      background:var(--red);
      font-weight:1000;
      letter-spacing:.03em;
    }

    .thankyou{
      width:260px;
      text-align:left;
      color:#1f2937;
      font-size:28px;
      font-weight:300;
      font-family: "Brush Script MT","Segoe Script","Snell Roundhand",cursive;
      margin-top:2px;
    }

    /* bottom navy footer */
    .footer{
      background:var(--navy);
      color:#fff;
      padding:14px 22px;
      display:flex;
      justify-content:space-between;
      flex-wrap:wrap;
      gap:10px;
      font-size:11px;
      margin-top:4px;
    }
    .footer .item{
      display:flex;
      align-items:center;
      gap:8px;
      opacity:.92;
    }
    .ficon{
      width:18px;height:18px;border-radius:50%;
      background:rgba(227,33,43,.95);
      display:grid;
      place-items:center;
      font-size:11px;
    }

    @media print{
      body{background:#fff;padding:0}
      .page{border:none}
    }
  </style>
</head>

<body>
  <div class="page">

    <!-- HEADER -->
    <div class="header-row">
      <div class="brandbar">
        ${logoHtml}
        <div class="name">${escapeHtml(businessName.toUpperCase())}</div>
      </div>

      <div class="redbar">
        <h1>INVOICE</h1>
        <div class="underline"></div>

        <div class="meta-grid">
          <div>
            <div class="k">Invoice No</div>
            <div class="v">${escapeHtml(invoice?.invoice_number || 'INV-1234567890')}</div>
          </div>
          <div>
            <div class="k">Invoice Date</div>
            <div class="v">${escapeHtml(invoice?.issue_date || '')}</div>
          </div>
        </div>

        <div class="grand-pill">
          <div class="k">Grand Total</div>
          <div class="v">${currency} ${invoiceTotal.toLocaleString()}</div>
        </div>
      </div>
    </div>

    <!-- BODY -->
    <div class="content">
      <div class="invoice-to">
        <div class="label">Invoice to:</div>
        <div class="who">${escapeHtml(customerName)}</div>
        <div class="muted">
          Phone: ${escapeHtml(customerPhone || '+123-456-7890')}<br>
          Email: ${escapeHtml(customerEmail || 'hello@reallygreatsite.com')}
        </div>
      </div>

      <div class="thead">
        <div>Item Description</div>
        <div>Qty</div>
        <div>Price</div>
        <div class="total">Total</div>
      </div>

      <div class="rows">
        ${itemRows}
      </div>

      <div class="mid">
        <div class="bullets">
          <div class="bullet">
            <span class="dot"></span>
            <div>
              <h4>Payment Method:</h4>
              <div><b>Bank Name:</b> ${escapeHtml(bankName)}</div>
              <div><b>Account No:</b> ${escapeHtml(accountNo)}</div>
            </div>
          </div>

          <div class="bullet">
            <span class="dot"></span>
            <div>
              <h4>Term &amp; Conditions:</h4>
              <div>
                Please send payment within 30 days of receiving this invoice.
                There will be a 10% interest charge per month on late invoice.
              </div>
            </div>
          </div>
        </div>

        <div class="side">
          <div class="totals">
            <div class="r"><span>Subtotal</span><span>${currency} ${subtotal.toLocaleString()}</span></div>
            <div class="r"><span>Tax</span><span>${currency} ${tax.toLocaleString()}</span></div>
            <div class="r total"><span>TOTAL</span><span>${currency} ${invoiceTotal.toLocaleString()}</span></div>
          </div>

          <div class="thankyou">Thank You</div>
        </div>
      </div>
    </div>

    <div class="footer">
      <div class="item"><span class="ficon">📞</span><span>${escapeHtml(customerPhone || '+123-456-7890')}</span></div>
      <div class="item"><span class="ficon">🌐</span><span>${escapeHtml(store?.website || 'reallygreatsite.com')}</span></div>
      <div class="item"><span class="ficon">✉</span><span>${escapeHtml(customerEmail || 'hello@reallygreatsite.com')}</span></div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML to prevent XSS
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
 * Get all available template IDs
 */
function getAvailableTemplates() {
  return [
    { id: 'template_1', name: 'THYX Geometric', description: 'Dark blue with yellow accent, geometric header' },
    { id: 'template_2', name: 'Salford Yellow', description: 'Yellow and navy with top strip' },
    { id: 'template_3', name: 'Salford Olive', description: 'Dark gray with olive green accents' },
    { id: 'template_4', name: 'Studio Shodwe', description: 'Red and navy with curved header' }
  ];
}

module.exports = {
  getInvoiceTemplate,
  getAvailableTemplates
};
