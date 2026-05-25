/**
 * Email Service
 * Handles sending transactional emails with branded HTML templates.
 * All order emails are logged to `order_email_log` in the main DB for retry.
 */

const nodemailer = require('nodemailer');

// ─── Transporter ────────────────────────────────────────────────────────────

let transporter = null;

function initializeTransporter() {
  if (transporter) return transporter;

  if (process.env.SMTP_SERVICE === 'gmail' && process.env.SMTP_CLIENT_ID) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: process.env.SMTP_USER,
        clientId: process.env.SMTP_CLIENT_ID,
        clientSecret: process.env.SMTP_CLIENT_SECRET,
        refreshToken: process.env.SMTP_REFRESH_TOKEN
      }
    });
  } else {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    });
  }

  return transporter;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

function formatCurrency(amount) {
  const num = parseFloat(amount) || 0;
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(num);
}

function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDateTime(dateTime) {
  if (!dateTime) return 'N/A';
  return new Date(dateTime).toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function getFullImageUrl(relativePath) {
  if (!relativePath) return null;
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) return relativePath;
  const baseUrl = process.env.BASE_URL || process.env.SMTP_BASE_URL || 'http://localhost:3000';
  return `${baseUrl}${relativePath}`;
}

/**
 * Replace {{VARIABLE}} placeholders in a template string.
 */
function fillVars(html, vars) {
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    const val = vars[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

/**
 * Expand {{#LOOP_NAME}}...{{/LOOP_NAME}} blocks with an array of rows.
 * Each row is an object whose keys map to {{KEY}} placeholders inside the block.
 */
function fillLoop(html, loopName, rows) {
  const re = new RegExp(`\\{\\{#${loopName}\\}\\}([\\s\\S]*?)\\{\\{\\/${loopName}\\}\\}`, 'g');
  return html.replace(re, (_match, body) =>
    rows.map(row => fillVars(body, row)).join('')
  );
}

/**
 * Build item rows for order confirmation / shipped emails.
 * `items` — array of OnlineStoreOrderItem (plain JS objects).
 */
function buildItemRows(items) {
  return items.map(item => {
    const variant = [item.variation_name, item.variation_option_value]
      .filter(Boolean).join(': ') || '';
    const imageUrl = item.image_url ||
      (item.Product && item.Product.image_url ? getFullImageUrl(item.Product.image_url) : null) ||
      'https://placehold.co/56x56/f8fbff/1557f5?text=Item';

    return {
      ITEM_IMAGE_URL: imageUrl,
      ITEM_NAME: escapeHtml(item.product_name || item.name || 'Product'),
      ITEM_VARIANT: escapeHtml(variant),
      ITEM_QUANTITY: String(item.quantity || 1),
      ITEM_TOTAL: formatCurrency(item.total || (item.unit_price * item.quantity)),
      ITEM_UNIT_PRICE: formatCurrency(item.unit_price || 0)
    };
  });
}

/** Construct vendor store URL from available data. */
function buildStoreUrl(order, tenant) {
  const username = order?.OnlineStore?.username;
  const storeDomain = (process.env.STORE_BASE_DOMAIN || 'mycroshop.com').replace(/^https?:\/\//, '');
  if (username) return `https://${username}.${storeDomain}`;
  if (tenant?.website) return tenant.website;
  return `https://${(tenant?.subdomain || 'store')}.${storeDomain}`;
}

// ─── Email Log (main DB) ─────────────────────────────────────────────────────

/** Insert a row into order_email_log and return its ID. Returns null on failure. */
async function logOrderEmail({ tenantId, orderId, emailType, recipientEmail, fromAddress, subject, htmlContent }) {
  try {
    const { mainSequelize } = require('../config/database');
    const [result] = await mainSequelize.query(
      `INSERT INTO order_email_log
         (tenant_id, order_id, email_type, recipient_email, from_address, subject, html_content, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NOW())`,
      { replacements: [tenantId || null, orderId || null, emailType, recipientEmail, fromAddress, subject, htmlContent] }
    );
    return result; // insertId
  } catch (err) {
    console.error('[emailLog] Failed to log order email:', err.message);
    return null;
  }
}

async function markEmailSent(logId) {
  if (!logId) return;
  try {
    const { mainSequelize } = require('../config/database');
    await mainSequelize.query(
      `UPDATE order_email_log SET status = 'sent', attempts = attempts + 1, last_attempted_at = NOW() WHERE id = ?`,
      { replacements: [logId] }
    );
  } catch (err) {
    console.error('[emailLog] markEmailSent failed:', err.message);
  }
}

async function markEmailFailed(logId, errorMsg) {
  if (!logId) return;
  try {
    const { mainSequelize } = require('../config/database');
    await mainSequelize.query(
      `UPDATE order_email_log
       SET status = 'failed', attempts = attempts + 1, last_attempted_at = NOW(), error_message = ?
       WHERE id = ?`,
      { replacements: [String(errorMsg || '').slice(0, 1000), logId] }
    );
  } catch (err) {
    console.error('[emailLog] markEmailFailed failed:', err.message);
  }
}

// ─── Template: Order Confirmation ────────────────────────────────────────────

const ORDER_CONFIRMATION_TEMPLATE = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Order Confirmation</title>
  <style>
    html, body { margin:0!important; padding:0!important; width:100%!important; background:#f3f6fb; }
    body, table, td, p, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { border-collapse:collapse!important; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }
    a { text-decoration:none; }
    @media only screen and (max-width:600px){
      .wrapper{padding:14px 10px!important;} .email-container{width:100%!important;max-width:100%!important;border-radius:16px!important;}
      .content{padding:28px 22px 30px 22px!important;} .footer{padding:24px 22px!important;}
      .title{font-size:25px!important;line-height:33px!important;} .section-title{font-size:19px!important;line-height:27px!important;}
      .text{font-size:15px!important;line-height:25px!important;}
      .info-col,.summary-col,.support-col{display:block!important;width:100%!important;padding-right:0!important;padding-left:0!important;padding-bottom:12px!important;}
      .item-heading{display:none!important;} .item-row td{display:block!important;width:100%!important;text-align:left!important;padding-left:0!important;padding-right:0!important;}
      .item-row .item-image-cell{padding-bottom:10px!important;} .item-row .item-qty-mobile,.item-row .item-price-mobile{padding-top:6px!important;}
      .status-col{display:block!important;width:100%!important;padding-bottom:12px!important;} .item-thumb{width:58px!important;height:58px!important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#101828;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">Your order has been received. See your items, delivery details, and payment summary.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f6fb;">
    <tr><td align="center" class="wrapper" style="padding:30px 12px;">
      <table role="presentation" class="email-container" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 20px 55px rgba(16,24,40,0.10);">
        <!-- Header Banner -->
        <tr><td style="padding:0;background:#1557f5;">
          <img src="https://mycroshop.com/morderconfirm.png" alt="Order confirmed" width="640" style="width:100%;max-width:640px;height:auto;border:0;" />
        </td></tr>
        <!-- Main Content -->
        <tr><td class="content" style="padding:34px 42px 34px 42px;">
          <h1 class="title" style="margin:0 0 12px 0;color:#101828;font-size:28px;line-height:36px;font-weight:700;letter-spacing:-0.3px;">Your order has been received</h1>
          <p class="text" style="margin:0 0 18px 0;color:#344054;font-size:16px;line-height:28px;">Hi {{CUSTOMER_NAME}}, your order from <strong>{{VENDOR_NAME}}</strong> has been placed successfully. The vendor has received your order details and will begin processing it shortly.</p>
          <p class="text" style="margin:0 0 24px 0;color:#344054;font-size:16px;line-height:28px;">You will receive another notification once your order is out for delivery. Below is a summary of your order for your records.</p>
          <!-- Order Overview -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
            <tr>
              <td class="info-col" width="33.33%" valign="top" style="padding:0 6px 0 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Order number</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">{{ORDER_NUMBER}}</p>
                </td></tr></table>
              </td>
              <td class="info-col" width="33.33%" valign="top" style="padding:0 3px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Order date</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">{{ORDER_DATE}}</p>
                </td></tr></table>
              </td>
              <td class="info-col" width="33.33%" valign="top" style="padding:0 0 0 6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Status</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">{{ORDER_STATUS}}</p>
                </td></tr></table>
              </td>
            </tr>
          </table>
          <!-- Status Notice -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;margin:0 0 26px 0;">
            <tr><td style="padding:20px 22px;">
              <p style="margin:0 0 12px 0;color:#101828;font-size:16px;line-height:24px;font-weight:700;">What happens next?</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="status-col" width="33.33%" valign="top" align="center" style="padding:0 6px;">
                    <div style="width:34px;height:34px;margin:0 auto 8px auto;border-radius:50%;background:#1557f5;color:#ffffff;font-size:18px;line-height:34px;font-weight:700;text-align:center;">&#10003;</div>
                    <p style="margin:0;color:#1557f5;font-size:13px;line-height:19px;font-weight:700;">Order received</p>
                  </td>
                  <td class="status-col" width="33.33%" valign="top" align="center" style="padding:0 6px;">
                    <div style="width:34px;height:34px;margin:0 auto 8px auto;border-radius:50%;background:#eaf1ff;color:#1557f5;font-size:15px;line-height:34px;font-weight:700;text-align:center;">2</div>
                    <p style="margin:0;color:#344054;font-size:13px;line-height:19px;font-weight:700;">Vendor processes order</p>
                  </td>
                  <td class="status-col" width="33.33%" valign="top" align="center" style="padding:0 6px;">
                    <div style="width:34px;height:34px;margin:0 auto 8px auto;border-radius:50%;background:#f2f4f7;color:#667085;font-size:15px;line-height:34px;font-weight:700;text-align:center;">3</div>
                    <p style="margin:0;color:#667085;font-size:13px;line-height:19px;font-weight:700;">Delivery update</p>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0 0;color:#475467;font-size:14px;line-height:24px;">Once your order is out for delivery, you will be notified with the next update from the vendor.</p>
            </td></tr>
          </table>
          <!-- Ordered Items -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px 0;"><tr><td>
            <h2 class="section-title" style="margin:0 0 14px 0;color:#101828;font-size:21px;line-height:29px;font-weight:700;letter-spacing:-0.2px;">Items ordered</h2>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:18px;overflow:hidden;">
              <tr class="item-heading">
                <td style="padding:14px 18px;background:#f8fbff;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.35px;">Image</td>
                <td style="padding:14px 10px;background:#f8fbff;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.35px;">Item</td>
                <td align="center" style="padding:14px 10px;background:#f8fbff;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.35px;">Qty</td>
                <td align="right" style="padding:14px 18px;background:#f8fbff;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.35px;">Amount</td>
              </tr>
              {{#ORDER_ITEMS}}
              <tr class="item-row">
                <td class="item-image-cell" valign="top" width="78" style="padding:16px 0 16px 18px;border-top:1px solid #e6edff;">
                  <img class="item-thumb" src="{{ITEM_IMAGE_URL}}" alt="{{ITEM_NAME}}" width="56" height="56" style="width:56px;height:56px;border-radius:12px;object-fit:cover;background:#f8fbff;border:1px solid #e6edff;" />
                </td>
                <td valign="top" style="padding:16px 10px;border-top:1px solid #e6edff;">
                  <p style="margin:0 0 4px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">{{ITEM_NAME}}</p>
                  <p style="margin:0;color:#667085;font-size:13px;line-height:20px;">{{ITEM_VARIANT}}</p>
                </td>
                <td class="item-qty-mobile" valign="top" align="center" width="64" style="padding:16px 10px;border-top:1px solid #e6edff;color:#344054;font-size:14px;line-height:22px;font-weight:700;">{{ITEM_QUANTITY}}</td>
                <td class="item-price-mobile" valign="top" align="right" width="110" style="padding:16px 18px 16px 10px;border-top:1px solid #e6edff;">
                  <p style="margin:0 0 4px 0;color:#101828;font-size:14px;line-height:22px;font-weight:700;">{{ITEM_TOTAL}}</p>
                  <p style="margin:0;color:#667085;font-size:12px;line-height:18px;">{{ITEM_UNIT_PRICE}} each</p>
                </td>
              </tr>
              {{/ORDER_ITEMS}}
            </table>
          </td></tr></table>
          <!-- Delivery and Payment Summary -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px 0;">
            <tr>
              <td class="summary-col" width="50%" valign="top" style="padding:0 6px 0 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;"><tr><td style="padding:20px;">
                  <p style="margin:0 0 12px 0;color:#101828;font-size:16px;line-height:24px;font-weight:700;">Delivery details</p>
                  <p style="margin:0 0 8px 0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Recipient:</strong> {{RECIPIENT_NAME}}</p>
                  <p style="margin:0 0 8px 0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Phone:</strong> {{RECIPIENT_PHONE}}</p>
                  <p style="margin:0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Address:</strong> {{DELIVERY_ADDRESS}}</p>
                </td></tr></table>
              </td>
              <td class="summary-col" width="50%" valign="top" style="padding:0 0 0 6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:18px;"><tr><td style="padding:20px;">
                  <p style="margin:0 0 12px 0;color:#101828;font-size:16px;line-height:24px;font-weight:700;">Payment summary</p>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr><td style="padding:0 0 8px 0;color:#667085;font-size:13px;line-height:20px;">Subtotal</td><td align="right" style="padding:0 0 8px 0;color:#344054;font-size:13px;line-height:20px;font-weight:700;">{{SUBTOTAL}}</td></tr>
                    <tr><td style="padding:0 0 8px 0;color:#667085;font-size:13px;line-height:20px;">Delivery</td><td align="right" style="padding:0 0 8px 0;color:#344054;font-size:13px;line-height:20px;font-weight:700;">{{DELIVERY_FEE}}</td></tr>
                    <tr><td style="padding:0 0 12px 0;color:#667085;font-size:13px;line-height:20px;">Discount</td><td align="right" style="padding:0 0 12px 0;color:#344054;font-size:13px;line-height:20px;font-weight:700;">{{DISCOUNT}}</td></tr>
                    <tr><td style="padding:12px 0 0 0;border-top:1px solid #e6edff;color:#101828;font-size:15px;line-height:22px;font-weight:700;">Total</td><td align="right" style="padding:12px 0 0 0;border-top:1px solid #e6edff;color:#1557f5;font-size:16px;line-height:22px;font-weight:800;">{{ORDER_TOTAL}}</td></tr>
                  </table>
                </td></tr></table>
              </td>
            </tr>
          </table>
          <!-- Vendor Contact -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;margin:0 0 24px 0;">
            <tr><td style="padding:20px 22px;">
              <p style="margin:0 0 16px 0;color:#475467;font-size:14px;line-height:24px;">For questions about delivery time, pickup arrangement, product availability, or changes to your order, please contact the vendor directly.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="support-col" width="50%" valign="top" style="padding:0 8px 0 0;">
                    <p style="margin:0 0 8px 0;color:#344054;font-size:14px;line-height:22px;"><strong>Phone:</strong> {{VENDOR_PHONE}}</p>
                    <p style="margin:0;color:#344054;font-size:14px;line-height:22px;"><strong>Email:</strong> <a href="mailto:{{VENDOR_EMAIL}}" style="color:#1557f5;font-weight:700;">{{VENDOR_EMAIL}}</a></p>
                  </td>
                  <td class="support-col" width="50%" valign="top" style="padding:0 0 0 8px;">
                    <p style="margin:0 0 8px 0;color:#344054;font-size:14px;line-height:22px;"><strong>Store:</strong> <a href="{{VENDOR_STORE_LINK}}" target="_blank" style="color:#1557f5;font-weight:700;">Visit store</a></p>
                    <p style="margin:0;color:#344054;font-size:14px;line-height:22px;"><strong>Location:</strong> {{VENDOR_LOCATION}}</p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
          <p style="margin:0 0 4px 0;color:#101828;font-size:16px;line-height:26px;font-weight:700;">Thank you for your order.</p>
          <p style="margin:0;color:#344054;font-size:15px;line-height:24px;">{{VENDOR_NAME}}</p>
        </td></tr>
        <!-- Footer -->
        <tr><td class="footer" style="background:#101828;padding:26px 42px;text-align:center;">
          <p style="margin:0;color:#ffffff;font-size:14px;line-height:22px;font-weight:700;">Powered by MycroShop</p>
          <p style="margin:8px 0 0 0;color:#94a3b8;font-size:11px;line-height:18px;">This store uses MycroShop to manage products, orders, and customer updates.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

// ─── Template: Order Shipped / Out for Delivery ───────────────────────────────

const ORDER_SHIPPED_TEMPLATE = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Your order is out for delivery</title>
  <style>
    html, body { margin:0!important; padding:0!important; width:100%!important; background:#f3f6fb; }
    body, table, td, p, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { border-collapse:collapse!important; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }
    a { text-decoration:none; }
    @media only screen and (max-width:600px){
      .wrapper{padding:14px 10px!important;} .email-container{width:100%!important;max-width:100%!important;border-radius:16px!important;}
      .content{padding:28px 22px 30px 22px!important;} .footer{padding:24px 22px!important;}
      .title{font-size:25px!important;line-height:33px!important;} .section-title{font-size:19px!important;line-height:27px!important;}
      .text{font-size:15px!important;line-height:25px!important;}
      .info-col,.delivery-col,.support-col{display:block!important;width:100%!important;padding-right:0!important;padding-left:0!important;padding-bottom:12px!important;}
      .status-col{display:block!important;width:100%!important;padding-bottom:12px!important;}
      .item-heading{display:none!important;} .item-row td{display:block!important;width:100%!important;text-align:left!important;padding-left:0!important;padding-right:0!important;}
      .item-row .item-image-cell{padding-bottom:10px!important;} .item-row .item-qty-mobile,.item-row .item-price-mobile{padding-top:6px!important;}
      .item-thumb{width:58px!important;height:58px!important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#101828;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">Your order is now out for delivery. See the items on the way and delivery details.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f6fb;">
    <tr><td align="center" class="wrapper" style="padding:30px 12px;">
      <table role="presentation" class="email-container" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 20px 55px rgba(16,24,40,0.10);">
        <!-- Header Banner -->
        <tr><td style="padding:0;background:#1557f5;">
          <img src="https://mycroshop.com/mdelivery.png" alt="Delivery update" width="640" style="width:100%;max-width:640px;height:auto;border:0;" />
        </td></tr>
        <!-- Main Content -->
        <tr><td class="content" style="padding:34px 42px 34px 42px;">
          <h1 class="title" style="margin:0 0 12px 0;color:#101828;font-size:28px;line-height:36px;font-weight:700;letter-spacing:-0.3px;">Your order is out for delivery</h1>
          <p class="text" style="margin:0 0 18px 0;color:#344054;font-size:16px;line-height:28px;">Hi {{CUSTOMER_NAME}}, your order from <strong>{{VENDOR_NAME}}</strong> is now on the way. Please keep your phone nearby in case the vendor or delivery contact needs to reach you.</p>
          <p class="text" style="margin:0 0 24px 0;color:#344054;font-size:16px;line-height:28px;">The items listed below are currently out for delivery. You will receive another update once the delivery is completed.</p>
          <!-- Delivery Highlight -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;margin:0 0 24px 0;">
            <tr><td style="padding:22px 22px;">
              <p style="margin:0 0 6px 0;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Delivery status</p>
              <h2 class="section-title" style="margin:0 0 8px 0;color:#101828;font-size:21px;line-height:29px;font-weight:700;letter-spacing:-0.2px;">Your order is on the way</h2>
              <p style="margin:0 0 18px 0;color:#475467;font-size:14px;line-height:24px;">The vendor has completed processing and your item is now out for delivery.</p>
              <!-- Status badge -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #c8d8ff;border-radius:16px;margin:0 0 18px 0;">
                <tr><td style="padding:16px 18px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td valign="middle" width="46" style="padding-right:12px;">
                      <div style="width:38px;height:38px;border-radius:50%;background:#1557f5;color:#ffffff;font-size:18px;line-height:38px;font-weight:700;text-align:center;">&#10003;</div>
                    </td>
                    <td valign="middle">
                      <p style="margin:0 0 3px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">Current status: Out for delivery</p>
                      <p style="margin:0;color:#667085;font-size:13px;line-height:20px;">We will notify you once the delivery is completed.</p>
                    </td>
                  </tr></table>
                </td></tr>
              </table>
              <!-- Timeline -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="status-col" width="25%" valign="top" align="center" style="padding:0 4px;">
                    <div style="width:30px;height:30px;margin:0 auto 8px auto;border-radius:50%;background:#1557f5;color:#ffffff;font-size:15px;line-height:30px;font-weight:700;text-align:center;">&#10003;</div>
                    <p style="margin:0;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;">Order placed</p>
                  </td>
                  <td class="status-col" width="25%" valign="top" align="center" style="padding:0 4px;">
                    <div style="width:30px;height:30px;margin:0 auto 8px auto;border-radius:50%;background:#1557f5;color:#ffffff;font-size:15px;line-height:30px;font-weight:700;text-align:center;">&#10003;</div>
                    <p style="margin:0;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;">Processed</p>
                  </td>
                  <td class="status-col" width="25%" valign="top" align="center" style="padding:0 4px;">
                    <div style="width:30px;height:30px;margin:0 auto 8px auto;border-radius:50%;background:#1557f5;color:#ffffff;font-size:13px;line-height:30px;font-weight:700;text-align:center;">3</div>
                    <p style="margin:0;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;">Out for delivery</p>
                  </td>
                  <td class="status-col" width="25%" valign="top" align="center" style="padding:0 4px;">
                    <div style="width:30px;height:30px;margin:0 auto 8px auto;border-radius:50%;background:#eef2f7;color:#667085;font-size:13px;line-height:30px;font-weight:700;text-align:center;">4</div>
                    <p style="margin:0;color:#667085;font-size:12px;line-height:18px;font-weight:700;">Delivered</p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
          <!-- Order Summary Cards -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
            <tr>
              <td class="info-col" width="33.33%" valign="top" style="padding:0 6px 0 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Order number</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">{{ORDER_NUMBER}}</p>
                </td></tr></table>
              </td>
              <td class="info-col" width="33.33%" valign="top" style="padding:0 3px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Delivery date</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">{{DELIVERY_DATE}}</p>
                </td></tr></table>
              </td>
              <td class="info-col" width="33.33%" valign="top" style="padding:0 0 0 6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Status</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">Out for delivery</p>
                </td></tr></table>
              </td>
            </tr>
          </table>
          <!-- Items Out For Delivery -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px 0;"><tr><td>
            <h2 class="section-title" style="margin:0 0 14px 0;color:#101828;font-size:21px;line-height:29px;font-weight:700;letter-spacing:-0.2px;">Items out for delivery</h2>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:18px;overflow:hidden;">
              <tr class="item-heading">
                <td style="padding:14px 18px;background:#f8fbff;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.35px;">Image</td>
                <td style="padding:14px 10px;background:#f8fbff;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.35px;">Item</td>
                <td align="center" style="padding:14px 10px;background:#f8fbff;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.35px;">Qty</td>
                <td align="right" style="padding:14px 18px;background:#f8fbff;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.35px;">Amount</td>
              </tr>
              {{#DELIVERY_ITEMS}}
              <tr class="item-row">
                <td class="item-image-cell" valign="top" width="78" style="padding:16px 0 16px 18px;border-top:1px solid #e6edff;">
                  <img class="item-thumb" src="{{ITEM_IMAGE_URL}}" alt="{{ITEM_NAME}}" width="56" height="56" style="width:56px;height:56px;border-radius:12px;object-fit:cover;background:#f8fbff;border:1px solid #e6edff;" />
                </td>
                <td valign="top" style="padding:16px 10px;border-top:1px solid #e6edff;">
                  <p style="margin:0 0 4px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">{{ITEM_NAME}}</p>
                  <p style="margin:0;color:#667085;font-size:13px;line-height:20px;">{{ITEM_VARIANT}}</p>
                </td>
                <td class="item-qty-mobile" valign="top" align="center" width="64" style="padding:16px 10px;border-top:1px solid #e6edff;color:#344054;font-size:14px;line-height:22px;font-weight:700;">{{ITEM_QUANTITY}}</td>
                <td class="item-price-mobile" valign="top" align="right" width="110" style="padding:16px 18px 16px 10px;border-top:1px solid #e6edff;">
                  <p style="margin:0 0 4px 0;color:#101828;font-size:14px;line-height:22px;font-weight:700;">{{ITEM_TOTAL}}</p>
                  <p style="margin:0;color:#667085;font-size:12px;line-height:18px;">{{ITEM_UNIT_PRICE}} each</p>
                </td>
              </tr>
              {{/DELIVERY_ITEMS}}
            </table>
          </td></tr></table>
          <!-- Delivery and Contact Details -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px 0;">
            <tr>
              <td class="delivery-col" width="50%" valign="top" style="padding:0 6px 0 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;"><tr><td style="padding:20px;">
                  <p style="margin:0 0 12px 0;color:#101828;font-size:16px;line-height:24px;font-weight:700;">Delivery address</p>
                  <p style="margin:0 0 8px 0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Recipient:</strong> {{RECIPIENT_NAME}}</p>
                  <p style="margin:0 0 8px 0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Phone:</strong> {{RECIPIENT_PHONE}}</p>
                  <p style="margin:0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Address:</strong> {{DELIVERY_ADDRESS}}</p>
                </td></tr></table>
              </td>
              <td class="delivery-col" width="50%" valign="top" style="padding:0 0 0 6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:18px;"><tr><td style="padding:20px;">
                  <p style="margin:0 0 12px 0;color:#101828;font-size:16px;line-height:24px;font-weight:700;">Delivery contact</p>
                  <p style="margin:0 0 8px 0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Vendor:</strong> {{VENDOR_NAME}}</p>
                  <p style="margin:0 0 8px 0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Phone:</strong> {{VENDOR_PHONE}}</p>
                  <p style="margin:0;color:#667085;font-size:13px;line-height:20px;"><strong style="color:#344054;">Email:</strong> <a href="mailto:{{VENDOR_EMAIL}}" style="color:#1557f5;font-weight:700;">{{VENDOR_EMAIL}}</a></p>
                </td></tr></table>
              </td>
            </tr>
          </table>
          <!-- Final Note -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:16px;margin:0 0 24px 0;">
            <tr><td style="padding:18px 20px;">
              <p style="margin:0;color:#344054;font-size:14px;line-height:24px;">If you need to update delivery instructions or ask a question about this delivery, please contact <strong>{{VENDOR_NAME}}</strong> using the contact details above.</p>
            </td></tr>
          </table>
          <p style="margin:0 0 4px 0;color:#101828;font-size:16px;line-height:26px;font-weight:700;">Your delivery is on the way.</p>
          <p style="margin:0;color:#344054;font-size:15px;line-height:24px;">{{VENDOR_NAME}}</p>
        </td></tr>
        <!-- Footer -->
        <tr><td class="footer" style="background:#101828;padding:26px 42px;text-align:center;">
          <p style="margin:0;color:#ffffff;font-size:14px;line-height:22px;font-weight:700;">Powered by MycroShop</p>
          <p style="margin:8px 0 0 0;color:#94a3b8;font-size:11px;line-height:18px;">This store uses MycroShop to manage products, orders, and customer updates.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

// ─── Template: Order Completed / Delivered ────────────────────────────────────

const ORDER_COMPLETED_TEMPLATE = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Thank You For Your Patronage</title>
  <style>
    html, body { margin:0!important; padding:0!important; width:100%!important; background:#f3f6fb; }
    body, table, td, p, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { border-collapse:collapse!important; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }
    a { text-decoration:none; }
    @media only screen and (max-width:600px){
      .wrapper{padding:14px 10px!important;} .email-container{width:100%!important;max-width:100%!important;border-radius:16px!important;}
      .content{padding:28px 22px 30px 22px!important;} .footer{padding:24px 22px!important;}
      .title{font-size:25px!important;line-height:33px!important;} .section-title{font-size:19px!important;line-height:27px!important;}
      .text{font-size:15px!important;line-height:25px!important;}
      .card-col,.contact-col{display:block!important;width:100%!important;padding-right:0!important;padding-left:0!important;padding-bottom:12px!important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#101828;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">Thank you for your patronage. Your order has been delivered successfully.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f6fb;">
    <tr><td align="center" class="wrapper" style="padding:30px 12px;">
      <table role="presentation" class="email-container" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 20px 55px rgba(16,24,40,0.10);">
        <!-- Header Banner -->
        <tr><td style="padding:0;background:#1557f5;">
          <img src="https://mycroshop.com/mdeliverycompleted.png" alt="Order delivered successfully" width="640" style="width:100%;max-width:640px;height:auto;border:0;" />
        </td></tr>
        <!-- Main Content -->
        <tr><td class="content" style="padding:34px 42px 34px 42px;">
          <h1 class="title" style="margin:0 0 12px 0;color:#101828;font-size:28px;line-height:36px;font-weight:700;letter-spacing:-0.3px;">Thank you for your patronage</h1>
          <p class="text" style="margin:0 0 18px 0;color:#344054;font-size:16px;line-height:28px;">Hi {{CUSTOMER_NAME}}, your order from <strong>{{VENDOR_NAME}}</strong> has been delivered successfully.</p>
          <p class="text" style="margin:0 0 24px 0;color:#344054;font-size:16px;line-height:28px;">Thank you for trusting us with your purchase. We truly appreciate your support and hope you enjoy your item.</p>
          <!-- Completion Notice -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;margin:0 0 24px 0;">
            <tr><td style="padding:22px 22px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                <td valign="top" width="46" style="padding-right:14px;">
                  <div style="width:38px;height:38px;border-radius:50%;background:#1557f5;color:#ffffff;font-size:20px;line-height:38px;font-weight:700;text-align:center;">&#10003;</div>
                </td>
                <td valign="top">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:12px;line-height:18px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Order completed</p>
                  <h2 class="section-title" style="margin:0 0 8px 0;color:#101828;font-size:21px;line-height:29px;font-weight:700;letter-spacing:-0.2px;">Your delivery has been completed</h2>
                  <p style="margin:0;color:#475467;font-size:14px;line-height:24px;">This confirms that the item linked to order <strong>{{ORDER_NUMBER}}</strong> was delivered on <strong>{{DELIVERED_DATE}}</strong>.</p>
                </td>
              </tr></table>
            </td></tr>
          </table>
          <!-- Summary Cards -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
            <tr>
              <td class="card-col" width="33.33%" valign="top" style="padding:0 6px 0 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Order number</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">{{ORDER_NUMBER}}</p>
                </td></tr></table>
              </td>
              <td class="card-col" width="33.33%" valign="top" style="padding:0 3px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#1557f5;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Delivered on</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">{{DELIVERED_DATE}}</p>
                </td></tr></table>
              </td>
              <td class="card-col" width="33.33%" valign="top" style="padding:0 0 0 6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0fff4;border:1px solid #bbf7d0;border-radius:16px;"><tr><td style="padding:16px;">
                  <p style="margin:0 0 5px 0;color:#16a34a;font-size:11px;line-height:17px;font-weight:700;letter-spacing:0.35px;text-transform:uppercase;">Status</p>
                  <p style="margin:0;color:#101828;font-size:15px;line-height:23px;font-weight:700;">Delivered &#10003;</p>
                </td></tr></table>
              </td>
            </tr>
          </table>
          <!-- Vendor Contact -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;margin:0 0 24px 0;">
            <tr><td style="padding:20px 22px;">
              <p style="margin:0 0 14px 0;color:#101828;font-size:15px;line-height:24px;font-weight:700;">Need help or have feedback?</p>
              <p style="margin:0 0 14px 0;color:#475467;font-size:14px;line-height:24px;">If you have any concerns about your delivery, or simply want to share feedback, reach out to the vendor.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="contact-col" width="50%" valign="top" style="padding:0 8px 0 0;">
                    <p style="margin:0 0 8px 0;color:#344054;font-size:14px;line-height:22px;"><strong>Phone:</strong> {{VENDOR_PHONE}}</p>
                    <p style="margin:0;color:#344054;font-size:14px;line-height:22px;"><strong>Email:</strong> <a href="mailto:{{VENDOR_EMAIL}}" style="color:#1557f5;font-weight:700;">{{VENDOR_EMAIL}}</a></p>
                  </td>
                  <td class="contact-col" width="50%" valign="top" style="padding:0 0 0 8px;">
                    <p style="margin:0 0 8px 0;color:#344054;font-size:14px;line-height:22px;"><strong>Store:</strong> <a href="{{VENDOR_STORE_LINK}}" target="_blank" style="color:#1557f5;font-weight:700;">Visit store</a></p>
                    <p style="margin:0;color:#344054;font-size:14px;line-height:22px;"><strong>Location:</strong> {{VENDOR_LOCATION}}</p>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
          <p style="margin:0 0 4px 0;color:#101828;font-size:16px;line-height:26px;font-weight:700;">We hope to serve you again.</p>
          <p style="margin:0;color:#344054;font-size:15px;line-height:24px;">{{VENDOR_NAME}}</p>
        </td></tr>
        <!-- Footer -->
        <tr><td class="footer" style="background:#101828;padding:26px 42px;text-align:center;">
          <p style="margin:0;color:#ffffff;font-size:14px;line-height:22px;font-weight:700;">Powered by MycroShop</p>
          <p style="margin:8px 0 0 0;color:#94a3b8;font-size:11px;line-height:18px;">This store uses MycroShop to manage products, orders, and customer updates.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

// ─── Generator Functions ──────────────────────────────────────────────────────

/**
 * Render the order confirmation HTML.
 * data: { tenant, order, customerName, items, logoUrl? }
 */
function generateOrderConfirmationEmail(data) {
  const { tenant, order, customerName, items = [] } = data;

  const itemRows = buildItemRows(items);
  let html = fillLoop(ORDER_CONFIRMATION_TEMPLATE, 'ORDER_ITEMS', itemRows);

  const storeUrl = buildStoreUrl(order, tenant);
  const discountAmt = parseFloat(order.discount_amount) || 0;

  html = fillVars(html, {
    CUSTOMER_NAME:    escapeHtml(customerName || order.customer_name || 'Customer'),
    VENDOR_NAME:      escapeHtml(tenant.name || 'Vendor'),
    ORDER_NUMBER:     escapeHtml(order.order_number || 'N/A'),
    ORDER_DATE:       formatDate(order.created_at),
    ORDER_STATUS:     escapeHtml(order.status ? order.status.charAt(0).toUpperCase() + order.status.slice(1) : 'Received'),
    RECIPIENT_NAME:   escapeHtml(order.customer_name || customerName || 'N/A'),
    RECIPIENT_PHONE:  escapeHtml(order.customer_phone || 'N/A'),
    DELIVERY_ADDRESS: escapeHtml(order.customer_address || 'N/A'),
    SUBTOTAL:         formatCurrency(order.subtotal || 0),
    DELIVERY_FEE:     formatCurrency(order.shipping_amount || 0),
    DISCOUNT:         discountAmt > 0 ? `-${formatCurrency(discountAmt)}` : formatCurrency(0),
    ORDER_TOTAL:      formatCurrency(order.total || 0),
    VENDOR_PHONE:     escapeHtml(tenant.phone || 'N/A'),
    VENDOR_EMAIL:     escapeHtml(process.env.SMTP_USER || 'support@mycroshop.com'),
    VENDOR_STORE_LINK: storeUrl,
    VENDOR_LOCATION:  escapeHtml(tenant.address || 'N/A')
  });

  return html;
}

/**
 * Render the order shipped / out-for-delivery HTML.
 * data: { tenant, order, customerName, items, deliveryDate? }
 */
function generateOrderShippedEmail(data) {
  const { tenant, order, customerName, items = [], deliveryDate } = data;

  const itemRows = buildItemRows(items);
  let html = fillLoop(ORDER_SHIPPED_TEMPLATE, 'DELIVERY_ITEMS', itemRows);

  html = fillVars(html, {
    CUSTOMER_NAME:    escapeHtml(customerName || order.customer_name || 'Customer'),
    VENDOR_NAME:      escapeHtml(tenant.name || 'Vendor'),
    ORDER_NUMBER:     escapeHtml(order.order_number || 'N/A'),
    DELIVERY_DATE:    formatDate(deliveryDate || order.updated_at || new Date()),
    RECIPIENT_NAME:   escapeHtml(order.customer_name || customerName || 'N/A'),
    RECIPIENT_PHONE:  escapeHtml(order.customer_phone || 'N/A'),
    DELIVERY_ADDRESS: escapeHtml(order.customer_address || 'N/A'),
    VENDOR_PHONE:     escapeHtml(tenant.phone || 'N/A'),
    VENDOR_EMAIL:     escapeHtml(process.env.SMTP_USER || 'support@mycroshop.com'),
    VENDOR_STORE_LINK: buildStoreUrl(order, tenant)
  });

  return html;
}

/**
 * Render the order completed / delivered HTML.
 * data: { tenant, order, customerName, deliveredDate? }
 */
function generateOrderCompletedEmail(data) {
  const { tenant, order, customerName, deliveredDate } = data;

  let html = fillVars(ORDER_COMPLETED_TEMPLATE, {
    CUSTOMER_NAME:    escapeHtml(customerName || order.customer_name || 'Customer'),
    VENDOR_NAME:      escapeHtml(tenant.name || 'Vendor'),
    ORDER_NUMBER:     escapeHtml(order.order_number || 'N/A'),
    DELIVERED_DATE:   formatDate(deliveredDate || order.updated_at || new Date()),
    VENDOR_PHONE:     escapeHtml(tenant.phone || 'N/A'),
    VENDOR_EMAIL:     escapeHtml(process.env.SMTP_USER || 'support@mycroshop.com'),
    VENDOR_STORE_LINK: buildStoreUrl(order, tenant),
    VENDOR_LOCATION:  escapeHtml(tenant.address || 'N/A')
  });

  return html;
}

// ─── Send Functions (log → send → update log) ────────────────────────────────

/**
 * Send order confirmation email and log to order_email_log.
 * data: { tenant, order, customerEmail, customerName, items }
 */
async function sendOrderConfirmationEmail(data) {
  const { tenant, order, customerEmail, customerName, items = [] } = data;

  if (!customerEmail) {
    console.warn('[email] No customer email for order confirmation — skipping');
    return;
  }

  const html    = generateOrderConfirmationEmail({ tenant, order, customerName, items });
  const subject = `Order Confirmation – ${order.order_number || 'Your Order'}`;
  const from    = `"${tenant.name || 'MycroShop'}" <${process.env.SMTP_USER || 'noreply@mycroshop.com'}>`;

  const logId = await logOrderEmail({
    tenantId:      tenant.id,
    orderId:       order.id,
    emailType:     'confirmation',
    recipientEmail: customerEmail,
    fromAddress:   from,
    subject,
    htmlContent:   html
  });

  try {
    const t = initializeTransporter();
    const info = await t.sendMail({ from, to: customerEmail, subject, html });
    console.log('[email] Order confirmation sent:', info.messageId);
    await markEmailSent(logId);
    return info;
  } catch (err) {
    console.error('[email] Order confirmation failed:', err.message);
    await markEmailFailed(logId, err.message);
    throw err;
  }
}

/**
 * Send order shipped email and log to order_email_log.
 * data: { tenant, order, customerEmail, customerName, items, deliveryDate? }
 */
async function sendOrderShippedEmail(data) {
  const { tenant, order, customerEmail, customerName, items = [], deliveryDate } = data;

  if (!customerEmail) {
    console.warn('[email] No customer email for shipped notification — skipping');
    return;
  }

  const html    = generateOrderShippedEmail({ tenant, order, customerName, items, deliveryDate });
  const subject = `Your Order is Out for Delivery – ${order.order_number || 'Your Order'}`;
  const from    = `"${tenant.name || 'MycroShop'}" <${process.env.SMTP_USER || 'noreply@mycroshop.com'}>`;

  const logId = await logOrderEmail({
    tenantId:      tenant.id,
    orderId:       order.id,
    emailType:     'shipped',
    recipientEmail: customerEmail,
    fromAddress:   from,
    subject,
    htmlContent:   html
  });

  try {
    const t = initializeTransporter();
    const info = await t.sendMail({ from, to: customerEmail, subject, html });
    console.log('[email] Order shipped sent:', info.messageId);
    await markEmailSent(logId);
    return info;
  } catch (err) {
    console.error('[email] Order shipped failed:', err.message);
    await markEmailFailed(logId, err.message);
    throw err;
  }
}

/**
 * Send order completed / delivered email and log to order_email_log.
 * data: { tenant, order, customerEmail, customerName, deliveredDate? }
 */
async function sendOrderCompletedEmail(data) {
  const { tenant, order, customerEmail, customerName, deliveredDate } = data;

  if (!customerEmail) {
    console.warn('[email] No customer email for completed notification — skipping');
    return;
  }

  const html    = generateOrderCompletedEmail({ tenant, order, customerName, deliveredDate });
  const subject = `Order Delivered – Thank You for Your Patronage`;
  const from    = `"${tenant.name || 'MycroShop'}" <${process.env.SMTP_USER || 'noreply@mycroshop.com'}>`;

  const logId = await logOrderEmail({
    tenantId:      tenant.id,
    orderId:       order.id,
    emailType:     'completed',
    recipientEmail: customerEmail,
    fromAddress:   from,
    subject,
    htmlContent:   html
  });

  try {
    const t = initializeTransporter();
    const info = await t.sendMail({ from, to: customerEmail, subject, html });
    console.log('[email] Order completed sent:', info.messageId);
    await markEmailSent(logId);
    return info;
  } catch (err) {
    console.error('[email] Order completed failed:', err.message);
    await markEmailFailed(logId, err.message);
    throw err;
  }
}

// ─── Booking Confirmation (unchanged) ────────────────────────────────────────

function generateBookingConfirmationEmail(data) {
  const { tenant, booking, customerName, logoUrl } = data;

  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${escapeHtml(tenant.name)}" style="max-width:150px;height:auto;margin-bottom:20px;" />`
    : `<h1 style="color:#2563EB;margin:0 0 20px 0;">${escapeHtml(tenant.name || 'MycroShop')}</h1>`;

  const locationInfo = booking.location_type === 'online' && booking.meeting_link
    ? `<p style="margin:10px 0 0;color:#2563EB;"><a href="${escapeHtml(booking.meeting_link)}" style="color:#2563EB;text-decoration:none;">Join Meeting</a></p>`
    : booking.Store && booking.Store.address
    ? `<p style="margin:10px 0 0;color:#6B7280;">${escapeHtml(booking.Store.address)}${booking.Store.city ? ', ' + escapeHtml(booking.Store.city) : ''}${booking.Store.state ? ', ' + escapeHtml(booking.Store.state) : ''}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Booking Confirmation</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#F9FAFB;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F9FAFB;">
    <tr><td style="padding:40px 20px;">
      <table role="presentation" style="max-width:600px;margin:0 auto;background-color:#FFFFFF;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
        <tr><td style="padding:40px 40px 20px;text-align:center;background:linear-gradient(135deg,#667EEA 0%,#764BA2 100%);border-radius:8px 8px 0 0;">${logoHtml}</td></tr>
        <tr><td style="padding:40px;">
          <h2 style="color:#111827;margin:0 0 10px 0;font-size:24px;font-weight:600;">Booking Confirmation</h2>
          <p style="color:#6B7280;margin:0 0 30px 0;font-size:16px;">Your booking has been confirmed, ${escapeHtml(customerName)}!</p>
          <div style="background-color:#F9FAFB;padding:20px;border-radius:6px;margin-bottom:30px;">
            <h3 style="color:#111827;margin:0 0 15px 0;font-size:18px;font-weight:600;">${escapeHtml(booking.service_title || booking.StoreService?.service_title || 'Service')}</h3>
            <p style="margin:0 0 5px 0;color:#6B7280;font-size:14px;font-weight:600;">Date &amp; Time</p>
            <p style="margin:0 0 15px 0;color:#111827;font-size:16px;font-weight:600;">${formatDateTime(booking.scheduled_at)}</p>
            <p style="margin:0 0 5px 0;color:#6B7280;font-size:14px;font-weight:600;">Duration</p>
            <p style="margin:0 0 15px 0;color:#111827;font-size:16px;">${booking.duration_minutes || booking.StoreService?.duration_minutes || 60} minutes</p>
            ${booking.Store ? `<p style="margin:0 0 5px 0;color:#6B7280;font-size:14px;font-weight:600;">Location</p>
            <p style="margin:0;color:#111827;font-size:16px;font-weight:600;">${escapeHtml(booking.Store.name || '')}</p>${locationInfo}` : ''}
            ${booking.StoreService && booking.StoreService.price > 0 ? `<p style="margin:15px 0 5px 0;color:#6B7280;font-size:14px;font-weight:600;">Price</p><p style="margin:0;color:#111827;font-size:16px;font-weight:600;">${formatCurrency(booking.StoreService.price)}</p>` : ''}
            <p style="margin:15px 0 0 0;color:#374151;">Status: <span style="color:#059669;font-weight:600;">${escapeHtml(booking.status || 'Confirmed')}</span></p>
          </div>
          ${booking.notes ? `<div style="background-color:#FEF3C7;padding:15px;border-radius:6px;margin-bottom:30px;border-left:4px solid #F59E0B;"><p style="margin:0;color:#92400E;font-size:14px;"><strong>Note:</strong> ${escapeHtml(booking.notes)}</p></div>` : ''}
          <p style="color:#6B7280;margin:0;font-size:14px;line-height:1.6;">We look forward to serving you!</p>
        </td></tr>
        <tr><td style="padding:30px 40px;background-color:#F9FAFB;border-radius:0 0 8px 8px;text-align:center;">
          <p style="margin:0 0 10px 0;color:#6B7280;font-size:14px;">Thank you for choosing us!</p>
          <p style="margin:0;color:#9CA3AF;font-size:12px;">&copy; ${new Date().getFullYear()} ${escapeHtml(tenant.name || 'MycroShop')}. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendBookingConfirmationEmail(data) {
  try {
    const { tenant, booking, customerEmail, customerName } = data;
    if (!customerEmail) { console.warn('No customer email for booking confirmation'); return; }

    const logoUrl = tenant.logo_url ? getFullImageUrl(tenant.logo_url) : null;
    const t       = initializeTransporter();
    const html    = generateBookingConfirmationEmail({ tenant, booking, customerName, logoUrl });

    const info = await t.sendMail({
      from: `"${tenant.name || 'MycroShop'}" <${process.env.SMTP_USER || 'noreply@mycroshop.com'}>`,
      to:   customerEmail,
      subject: `Booking Confirmation – ${booking.service_title || booking.StoreService?.service_title || 'Your Booking'}`,
      html
    });
    console.log('[email] Booking confirmation sent:', info.messageId);
    return info;
  } catch (err) {
    console.error('[email] Booking confirmation failed:', err);
    throw err;
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Order emails
  sendOrderConfirmationEmail,
  sendOrderShippedEmail,
  sendOrderCompletedEmail,
  // Booking email
  sendBookingConfirmationEmail,
  // Utility
  initializeTransporter,
  // Exposed for cron retry script
  logOrderEmail,
  markEmailSent,
  markEmailFailed
};
