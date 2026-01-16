/**
 * Email Service
 * Handles sending transactional emails (order confirmations, booking confirmations, etc.)
 */

const nodemailer = require('nodemailer');
const path = require('path');

// Create reusable transporter
let transporter = null;

/**
 * Initialize email transporter
 */
function initializeTransporter() {
  if (transporter) {
    return transporter;
  }

  // Use environment variables for email configuration
  // Support for Gmail, SendGrid, SMTP, etc.
  const emailConfig = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    }
  };

  // If using Gmail with OAuth2
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
    transporter = nodemailer.createTransport(emailConfig);
  }

  return transporter;
}

/**
 * Get full URL for logo/image
 */
function getFullImageUrl(relativePath) {
  if (!relativePath) return null;
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
    return relativePath;
  }
  // In email context, use base URL from env
  const baseUrl = process.env.BASE_URL || process.env.SMTP_BASE_URL || 'http://localhost:3000';
  return `${baseUrl}${relativePath}`;
}

/**
 * Generate order confirmation email HTML
 */
function generateOrderConfirmationEmail(data) {
  const {
    tenant,
    order,
    customerName,
    customerEmail,
    items = [],
    logoUrl
  } = data;

  const logoHtml = logoUrl 
    ? `<img src="${logoUrl}" alt="${tenant.name}" style="max-width: 150px; height: auto; margin-bottom: 20px;" />`
    : `<h1 style="color: #2563EB; margin: 0 0 20px 0;">${tenant.name || 'MycroShop'}</h1>`;

  const itemsHtml = items.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #E5E7EB;">${escapeHtml(item.product_name || item.name || 'N/A')}</td>
      <td style="padding: 12px; border-bottom: 1px solid #E5E7EB; text-align: center;">${item.quantity || 1}</td>
      <td style="padding: 12px; border-bottom: 1px solid #E5E7EB; text-align: right;">${formatCurrency(item.unit_price || 0)}</td>
      <td style="padding: 12px; border-bottom: 1px solid #E5E7EB; text-align: right;">${formatCurrency((item.unit_price || 0) * (item.quantity || 1))}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Order Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F9FAFB;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F9FAFB;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #667EEA 0%, #764BA2 100%); border-radius: 8px 8px 0 0;">
              ${logoHtml}
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="color: #111827; margin: 0 0 10px 0; font-size: 24px; font-weight: 600;">Order Confirmation</h2>
              <p style="color: #6B7280; margin: 0 0 30px 0; font-size: 16px;">Thank you for your order, ${escapeHtml(customerName)}!</p>
              
              <!-- Order Details -->
              <div style="background-color: #F9FAFB; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
                <p style="margin: 0 0 10px 0; color: #374151; font-weight: 600;">Order Number: <span style="color: #2563EB;">${escapeHtml(order.order_number || 'N/A')}</span></p>
                <p style="margin: 0 0 10px 0; color: #374151;">Order Date: ${formatDate(order.created_at || new Date())}</p>
                <p style="margin: 0; color: #374151;">Status: <span style="color: #059669; font-weight: 600;">${escapeHtml(order.status || 'Pending')}</span></p>
              </div>

              <!-- Items Table -->
              <h3 style="color: #111827; margin: 0 0 20px 0; font-size: 18px; font-weight: 600;">Order Items</h3>
              <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                <thead>
                  <tr style="background-color: #F3F4F6;">
                    <th style="padding: 12px; text-align: left; border-bottom: 2px solid #E5E7EB; color: #374151; font-weight: 600;">Product</th>
                    <th style="padding: 12px; text-align: center; border-bottom: 2px solid #E5E7EB; color: #374151; font-weight: 600;">Quantity</th>
                    <th style="padding: 12px; text-align: right; border-bottom: 2px solid #E5E7EB; color: #374151; font-weight: 600;">Price</th>
                    <th style="padding: 12px; text-align: right; border-bottom: 2px solid #E5E7EB; color: #374151; font-weight: 600;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml}
                </tbody>
              </table>

              <!-- Order Summary -->
              <div style="background-color: #F9FAFB; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
                <table role="presentation" style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; color: #6B7280;">Subtotal:</td>
                    <td style="padding: 8px 0; text-align: right; color: #111827; font-weight: 600;">${formatCurrency(order.subtotal || 0)}</td>
                  </tr>
                  ${order.tax_amount > 0 ? `
                  <tr>
                    <td style="padding: 8px 0; color: #6B7280;">Tax:</td>
                    <td style="padding: 8px 0; text-align: right; color: #111827; font-weight: 600;">${formatCurrency(order.tax_amount || 0)}</td>
                  </tr>
                  ` : ''}
                  ${order.shipping_amount > 0 ? `
                  <tr>
                    <td style="padding: 8px 0; color: #6B7280;">Shipping:</td>
                    <td style="padding: 8px 0; text-align: right; color: #111827; font-weight: 600;">${formatCurrency(order.shipping_amount || 0)}</td>
                  </tr>
                  ` : ''}
                  ${order.discount_amount > 0 ? `
                  <tr>
                    <td style="padding: 8px 0; color: #6B7280;">Discount:</td>
                    <td style="padding: 8px 0; text-align: right; color: #059669; font-weight: 600;">-${formatCurrency(order.discount_amount || 0)}</td>
                  </tr>
                  ` : ''}
                  <tr style="border-top: 2px solid #E5E7EB;">
                    <td style="padding: 12px 0 0; color: #111827; font-size: 18px; font-weight: 700;">Total:</td>
                    <td style="padding: 12px 0 0; text-align: right; color: #2563EB; font-size: 18px; font-weight: 700;">${formatCurrency(order.total || 0)}</td>
                  </tr>
                </table>
              </div>

              ${order.customer_address ? `
              <!-- Delivery Address -->
              <div style="background-color: #F9FAFB; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
                <h3 style="color: #111827; margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Delivery Address</h3>
                <p style="margin: 0; color: #6B7280; line-height: 1.6;">
                  ${escapeHtml(order.customer_address || '')}<br>
                  ${order.city ? escapeHtml(order.city) + ', ' : ''}${order.state ? escapeHtml(order.state) : ''}<br>
                  ${order.country ? escapeHtml(order.country) : ''}
                </p>
              </div>
              ` : ''}

              <p style="color: #6B7280; margin: 0; font-size: 14px; line-height: 1.6;">
                We'll send you another email when your order ships. If you have any questions, please contact us.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #F9FAFB; border-radius: 0 0 8px 8px; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #6B7280; font-size: 14px;">Thank you for shopping with us!</p>
              <p style="margin: 0; color: #9CA3AF; font-size: 12px;">© ${new Date().getFullYear()} ${escapeHtml(tenant.name || 'MycroShop')}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * Generate booking confirmation email HTML
 */
function generateBookingConfirmationEmail(data) {
  const {
    tenant,
    booking,
    customerName,
    customerEmail,
    logoUrl
  } = data;

  const logoHtml = logoUrl 
    ? `<img src="${logoUrl}" alt="${tenant.name}" style="max-width: 150px; height: auto; margin-bottom: 20px;" />`
    : `<h1 style="color: #2563EB; margin: 0 0 20px 0;">${tenant.name || 'MycroShop'}</h1>`;

  const locationInfo = booking.location_type === 'online' && booking.meeting_link
    ? `<p style="margin: 10px 0 0; color: #2563EB;"><a href="${escapeHtml(booking.meeting_link)}" style="color: #2563EB; text-decoration: none;">Join Meeting</a></p>`
    : booking.Store && booking.Store.address
    ? `<p style="margin: 10px 0 0; color: #6B7280;">${escapeHtml(booking.Store.address)}${booking.Store.city ? ', ' + escapeHtml(booking.Store.city) : ''}${booking.Store.state ? ', ' + escapeHtml(booking.Store.state) : ''}</p>`
    : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Booking Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #F9FAFB;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #F9FAFB;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #667EEA 0%, #764BA2 100%); border-radius: 8px 8px 0 0;">
              ${logoHtml}
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="color: #111827; margin: 0 0 10px 0; font-size: 24px; font-weight: 600;">Booking Confirmation</h2>
              <p style="color: #6B7280; margin: 0 0 30px 0; font-size: 16px;">Your booking has been confirmed, ${escapeHtml(customerName)}!</p>
              
              <!-- Booking Details -->
              <div style="background-color: #F9FAFB; padding: 20px; border-radius: 6px; margin-bottom: 30px;">
                <h3 style="color: #111827; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">${escapeHtml(booking.service_title || booking.StoreService?.service_title || 'Service')}</h3>
                
                <div style="margin-bottom: 15px;">
                  <p style="margin: 0 0 5px 0; color: #6B7280; font-size: 14px; font-weight: 600;">Date & Time</p>
                  <p style="margin: 0; color: #111827; font-size: 16px; font-weight: 600;">${formatDateTime(booking.scheduled_at)}</p>
                </div>

                <div style="margin-bottom: 15px;">
                  <p style="margin: 0 0 5px 0; color: #6B7280; font-size: 14px; font-weight: 600;">Duration</p>
                  <p style="margin: 0; color: #111827; font-size: 16px;">${booking.duration_minutes || booking.StoreService?.duration_minutes || 60} minutes</p>
                </div>

                ${booking.Store ? `
                <div style="margin-bottom: 15px;">
                  <p style="margin: 0 0 5px 0; color: #6B7280; font-size: 14px; font-weight: 600;">Location</p>
                  <p style="margin: 0; color: #111827; font-size: 16px; font-weight: 600;">${escapeHtml(booking.Store.name || '')}</p>
                  ${locationInfo}
                </div>
                ` : ''}

                ${booking.StoreService && booking.StoreService.price > 0 ? `
                <div style="margin-bottom: 15px;">
                  <p style="margin: 0 0 5px 0; color: #6B7280; font-size: 14px; font-weight: 600;">Price</p>
                  <p style="margin: 0; color: #111827; font-size: 16px; font-weight: 600;">${formatCurrency(booking.StoreService.price || 0)}</p>
                </div>
                ` : ''}

                <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #E5E7EB;">
                  <p style="margin: 0; color: #374151;">Status: <span style="color: #059669; font-weight: 600;">${escapeHtml(booking.status || 'Confirmed')}</span></p>
                </div>
              </div>

              ${booking.notes ? `
              <div style="background-color: #FEF3C7; padding: 15px; border-radius: 6px; margin-bottom: 30px; border-left: 4px solid #F59E0B;">
                <p style="margin: 0; color: #92400E; font-size: 14px;"><strong>Note:</strong> ${escapeHtml(booking.notes)}</p>
              </div>
              ` : ''}

              <p style="color: #6B7280; margin: 0; font-size: 14px; line-height: 1.6;">
                We look forward to serving you! If you need to reschedule or cancel, please contact us as soon as possible.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #F9FAFB; border-radius: 0 0 8px 8px; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #6B7280; font-size: 14px;">Thank you for choosing us!</p>
              <p style="margin: 0; color: #9CA3AF; font-size: 12px;">© ${new Date().getFullYear()} ${escapeHtml(tenant.name || 'MycroShop')}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * Send order confirmation email
 */
async function sendOrderConfirmationEmail(data) {
  try {
    const { tenant, order, customerEmail, customerName, items = [] } = data;

    if (!customerEmail) {
      console.warn('No customer email provided for order confirmation');
      return;
    }

    // Get logo URL
    const logoUrl = tenant.logo_url ? getFullImageUrl(tenant.logo_url) : null;

    const transporter = initializeTransporter();
    if (!transporter) {
      throw new Error('Email transporter not configured. Please set SMTP environment variables.');
    }

    const html = generateOrderConfirmationEmail({
      tenant,
      order,
      customerName,
      customerEmail,
      items,
      logoUrl
    });

    const mailOptions = {
      from: `"${tenant.name || 'MycroShop'}" <${process.env.SMTP_USER || 'noreply@mycroshop.com'}>`,
      to: customerEmail,
      subject: `Order Confirmation - ${order.order_number || 'Your Order'}`,
      html
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Order confirmation email sent:', info.messageId);
    return info;
  } catch (error) {
    console.error('Error sending order confirmation email:', error);
    throw error;
  }
}

/**
 * Send booking confirmation email
 */
async function sendBookingConfirmationEmail(data) {
  try {
    const { tenant, booking, customerEmail, customerName } = data;

    if (!customerEmail) {
      console.warn('No customer email provided for booking confirmation');
      return;
    }

    // Get logo URL
    const logoUrl = tenant.logo_url ? getFullImageUrl(tenant.logo_url) : null;

    const transporter = initializeTransporter();
    if (!transporter) {
      throw new Error('Email transporter not configured. Please set SMTP environment variables.');
    }

    const html = generateBookingConfirmationEmail({
      tenant,
      booking,
      customerName,
      customerEmail,
      logoUrl
    });

    const mailOptions = {
      from: `"${tenant.name || 'MycroShop'}" <${process.env.SMTP_USER || 'noreply@mycroshop.com'}>`,
      to: customerEmail,
      subject: `Booking Confirmation - ${booking.service_title || booking.StoreService?.service_title || 'Your Booking'}`,
      html
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Booking confirmation email sent:', info.messageId);
    return info;
  } catch (error) {
    console.error('Error sending booking confirmation email:', error);
    throw error;
  }
}

// Helper functions
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

function formatCurrency(amount) {
  const num = parseFloat(amount) || 0;
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN'
  }).format(num);
}

function formatDate(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatDateTime(dateTime) {
  if (!dateTime) return 'N/A';
  const d = new Date(dateTime);
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

module.exports = {
  sendOrderConfirmationEmail,
  sendBookingConfirmationEmail,
  initializeTransporter
};

