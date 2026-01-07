/**
 * Receipt generation and printing controller
 */

/**
 * Generate receipt HTML for POS transaction
 */
async function generateReceipt(req, res) {
  try {
    const transaction = await req.db.models.POSTransaction.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Store,
          attributes: ['id', 'name', 'address', 'phone', 'email']
        },
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name']
        },
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone']
        },
        {
          model: req.db.models.POSTransactionItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'barcode']
            }
          ]
        }
      ]
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Get tenant info for receipt header
    const tenantId = req.user.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    try {
      tenant = await getTenantById(tenantId);
    } catch (error) {
      console.warn('Could not fetch tenant info:', error);
    }

    // Generate receipt HTML
    const receiptHTML = generateReceiptHTML(transaction, tenant);

    res.setHeader('Content-Type', 'text/html');
    res.send(receiptHTML);
  } catch (error) {
    console.error('Error generating receipt:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate receipt'
    });
  }
}

/**
 * Generate receipt HTML
 */
function generateReceiptHTML(transaction, tenant) {
  const store = transaction.Store;
  const items = transaction.POSTransactionItems || [];
  const date = new Date(transaction.created_at).toLocaleString();

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Receipt - ${transaction.transaction_number}</title>
  <style>
    @media print {
      @page { margin: 0; size: 80mm auto; }
      body { margin: 0; }
    }
    body {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      width: 80mm;
      margin: 0 auto;
      padding: 10px;
      line-height: 1.4;
    }
    .header {
      text-align: center;
      border-bottom: 1px dashed #000;
      padding-bottom: 10px;
      margin-bottom: 10px;
    }
    .store-name {
      font-size: 16px;
      font-weight: bold;
      margin-bottom: 5px;
    }
    .store-details {
      font-size: 10px;
      margin: 3px 0;
    }
    .transaction-info {
      margin: 10px 0;
      font-size: 11px;
    }
    .items {
      border-top: 1px dashed #000;
      border-bottom: 1px dashed #000;
      padding: 10px 0;
      margin: 10px 0;
    }
    .item-row {
      margin: 5px 0;
      display: flex;
      justify-content: space-between;
    }
    .item-name {
      flex: 1;
    }
    .item-price {
      text-align: right;
      margin-left: 10px;
    }
    .totals {
      margin: 10px 0;
      font-size: 11px;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      margin: 3px 0;
    }
    .total-label {
      font-weight: bold;
    }
    .footer {
      text-align: center;
      margin-top: 20px;
      padding-top: 10px;
      border-top: 1px dashed #000;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="store-name">${tenant ? tenant.name : (store ? store.name : 'Store')}</div>
    ${store && store.address ? `<div class="store-details">${store.address}</div>` : ''}
    ${store && store.phone ? `<div class="store-details">Tel: ${store.phone}</div>` : ''}
    ${store && store.email ? `<div class="store-details">${store.email}</div>` : ''}
  </div>
  
  <div class="transaction-info">
    <div>Receipt #: ${transaction.transaction_number}</div>
    <div>Date: ${date}</div>
    ${transaction.Staff ? `<div>Cashier: ${transaction.Staff.name}</div>` : ''}
    ${transaction.Customer ? `<div>Customer: ${transaction.Customer.name}</div>` : ''}
  </div>
  
  <div class="items">
    ${items.map(item => `
      <div class="item-row">
        <div class="item-name">
          ${item.product_name} x${item.quantity}
          ${item.discount_amount > 0 ? `<br><small>Discount: -₦${item.discount_amount.toFixed(2)}</small>` : ''}
        </div>
        <div class="item-price">₦${item.total.toFixed(2)}</div>
      </div>
    `).join('')}
  </div>
  
  <div class="totals">
    <div class="total-row">
      <span>Subtotal:</span>
      <span>₦${transaction.subtotal.toFixed(2)}</span>
    </div>
    ${transaction.tax_amount > 0 ? `
    <div class="total-row">
      <span>Tax:</span>
      <span>₦${transaction.tax_amount.toFixed(2)}</span>
    </div>
    ` : ''}
    ${transaction.discount_amount > 0 ? `
    <div class="total-row">
      <span>Discount:</span>
      <span>-₦${transaction.discount_amount.toFixed(2)}</span>
    </div>
    ` : ''}
    <div class="total-row">
      <span class="total-label">TOTAL:</span>
      <span class="total-label">₦${transaction.total.toFixed(2)}</span>
    </div>
    <div class="total-row">
      <span>Paid (${transaction.payment_method}):</span>
      <span>₦${transaction.amount_paid.toFixed(2)}</span>
    </div>
    ${transaction.change_amount > 0 ? `
    <div class="total-row">
      <span>Change:</span>
      <span>₦${transaction.change_amount.toFixed(2)}</span>
    </div>
    ` : ''}
  </div>
  
  <div class="footer">
    <div>Thank you for your business!</div>
    <div>${new Date().getFullYear()} ${tenant ? tenant.name : ''}</div>
  </div>
  
  <script>
    window.onload = function() {
      if (window.location.search.includes('print=true')) {
        window.print();
      }
    };
  </script>
</body>
</html>
  `;
}

/**
 * Generate receipt PDF (for download)
 */
async function generateReceiptPDF(req, res) {
  try {
    // For now, return HTML that can be printed to PDF
    // In production, use a library like puppeteer or pdfkit
    const transaction = await req.db.models.POSTransaction.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Store
        },
        {
          model: req.db.models.POSTransactionItem
        }
      ]
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Redirect to HTML receipt with print parameter
    res.redirect(`/api/v1/receipts/${req.params.id}?print=true`);
  } catch (error) {
    console.error('Error generating receipt PDF:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate receipt PDF'
    });
  }
}

module.exports = {
  generateReceipt,
  generateReceiptPDF
};

