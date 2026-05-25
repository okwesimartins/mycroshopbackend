/**
 * Auth Email Service
 * Handles OTP verification emails, welcome emails, and forgot-password emails.
 * Uses the same SMTP config as emailService.js.
 * OTPs are stateless — verified with HMAC-SHA256, never stored in the database.
 */

const nodemailer = require('nodemailer');
const crypto     = require('crypto');

// ─── SMTP transporter ────────────────────────────────────────────────────────

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (process.env.SMTP_SERVICE === 'gmail' && process.env.SMTP_CLIENT_ID) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: process.env.SMTP_USER,
        clientId:     process.env.SMTP_CLIENT_ID,
        clientSecret: process.env.SMTP_CLIENT_SECRET,
        refreshToken: process.env.SMTP_REFRESH_TOKEN
      }
    });
  } else {
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    });
  }

  return _transporter;
}

// ─── OTP helpers ─────────────────────────────────────────────────────────────

const OTP_TTL_MS      = 5 * 60 * 1000; // 5 minutes
const OTP_EXPIRY_MINS = 5;

function getOtpSecretKey() {
  return process.env.OTP_SECRET_KEY || process.env.JWT_SECRET || 'mycroshop-otp-secret';
}

/**
 * Generate a 6-digit OTP, its HMAC hash, and the full encrypted_data string.
 * Returns { otp, encrypted_data } where encrypted_data is "hash.expires".
 */
function generateOtp(email) {
  const otp     = `${Math.floor(100000 + Math.random() * 900000)}`;
  const expires = Date.now() + OTP_TTL_MS;
  const data    = `${email}.${otp}.${expires}`;
  const hash    = crypto.createHmac('sha256', getOtpSecretKey()).update(data).digest('hex');
  return { otp, encrypted_data: `${hash}.${expires}` };
}

/**
 * Validate an OTP against its encrypted_data string.
 * Returns { valid: true } or { valid: false, reason: '...' }
 */
function validateOtp(email, otp, encryptedData) {
  if (!email || !otp || !encryptedData) {
    return { valid: false, reason: 'Missing email, otp, or hash' };
  }

  const parts = encryptedData.split('.');
  if (parts.length < 2) return { valid: false, reason: 'Invalid hash format' };

  // expires is the LAST segment; hash is everything before it
  const expires   = parseInt(parts[parts.length - 1], 10);
  const hashValue = parts.slice(0, parts.length - 1).join('.');

  if (Date.now() > expires) {
    return { valid: false, reason: 'OTP has expired' };
  }

  const data              = `${email}.${otp}.${expires}`;
  const expectedHash      = crypto.createHmac('sha256', getOtpSecretKey()).update(data).digest('hex');
  const isMatch           = crypto.timingSafeEqual(
    Buffer.from(expectedHash, 'hex'),
    Buffer.from(hashValue,     'hex').slice(0, Buffer.from(expectedHash, 'hex').length)
  );

  // Use a safe string comparison
  if (expectedHash !== hashValue) {
    return { valid: false, reason: 'Invalid OTP' };
  }

  return { valid: true };
}

// ─── Email HTML generators ────────────────────────────────────────────────────

/**
 * Generate the OTP email HTML.
 * type: 'signup' | 'forgot_password'
 */
function generateOtpEmailHtml(otpCode, type = 'signup') {
  const isSignup = type !== 'forgot_password';

  const preheader = isSignup
    ? 'Use this one-time password to verify your MycroShop account.'
    : 'Use this one-time password to reset your MycroShop password.';

  const h1 = isSignup ? 'Verify your account' : 'Reset your password';

  const introParagraph = isSignup
    ? 'Use the one-time password below to complete your MycroShop verification. This helps us confirm that this request was made by you and keeps your account secure.'
    : 'Use the one-time password below to reset your MycroShop password. If you did not request a password reset, you can safely ignore this email.';

  const footerNote = isSignup
    ? 'You received this email because a verification code was requested for a MycroShop account.'
    : 'You received this email because a password reset was requested for a MycroShop account.';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>MycroShop OTP Verification</title>
  <style>
    html, body { margin:0!important; padding:0!important; width:100%!important; background:#f3f6fb; }
    body, table, td, p, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { border-collapse:collapse!important; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }
    a { text-decoration:none; }
    @media only screen and (max-width:600px) {
      .wrapper { padding:14px 10px!important; }
      .email-container { width:100%!important; max-width:100%!important; border-radius:16px!important; }
      .content { padding:28px 22px 30px 22px!important; }
      .footer { padding:26px 22px!important; }
      .title { font-size:25px!important; line-height:33px!important; }
      .text { font-size:15px!important; line-height:25px!important; }
      .otp-code { font-size:30px!important; line-height:40px!important; letter-spacing:6px!important; }
      .otp-box { padding:22px 16px!important; }
      .notice-box { padding:16px!important; }
      .social-link { display:block!important; margin:8px auto!important; width:150px!important; text-align:center!important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#101828;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f6fb;">
    <tr>
      <td align="center" class="wrapper" style="padding:30px 12px;">
        <table role="presentation" class="email-container" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 20px 55px rgba(16,24,40,0.10);">
          <tr>
            <td style="padding:0;background:#1557f5;">
              <img src="https://mycroshop.com/motpbanner.png" alt="Verify your MycroShop account" width="640" style="width:100%;max-width:640px;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td class="content" style="padding:34px 42px 34px 42px;">
              <h1 class="title" style="margin:0 0 14px 0;color:#101828;font-size:28px;line-height:36px;font-weight:700;letter-spacing:-0.3px;">${h1}</h1>
              <p class="text" style="margin:0 0 18px 0;color:#344054;font-size:16px;line-height:28px;">${introParagraph}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 24px 0;">
                <tr>
                  <td class="otp-box" align="center" style="padding:26px 20px;background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;">
                    <p style="margin:0 0 10px 0;color:#1557f5;font-size:13px;line-height:20px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;">Your verification code</p>
                    <p class="otp-code" style="margin:0;color:#101828;font-size:38px;line-height:48px;font-weight:800;letter-spacing:8px;">${otpCode}</p>
                    <p style="margin:12px 0 0 0;color:#667085;font-size:13px;line-height:21px;">This code expires in ${OTP_EXPIRY_MINS} minutes.</p>
                  </td>
                </tr>
              </table>
              <p class="text" style="margin:0 0 18px 0;color:#344054;font-size:16px;line-height:28px;">Enter this code on the MycroShop verification screen to continue. For your security, do not share this code with anyone.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px 0;">
                <tr>
                  <td class="notice-box" style="padding:18px 20px;background:#fffaf0;border:1px solid #fde7b8;border-radius:16px;">
                    <p style="margin:0 0 6px 0;color:#92400e;font-size:14px;line-height:22px;font-weight:700;">Didn't request this code?</p>
                    <p style="margin:0;color:#7a4b11;font-size:14px;line-height:23px;">You can safely ignore this email. Your account will not be affected unless this code is entered.</p>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 4px 0;color:#101828;font-size:16px;line-height:26px;font-weight:700;">Stay secure,</p>
              <p style="margin:0;color:#344054;font-size:15px;line-height:24px;">The MycroShop Team</p>
            </td>
          </tr>
          <tr>
            <td class="footer" style="background:#101828;padding:32px 42px;text-align:center;">
              <p style="margin:0 0 12px 0;color:#ffffff;font-size:17px;line-height:25px;font-weight:700;">Stay connected with MycroShop</p>
              <p style="margin:0 0 20px 0;color:#cbd5e1;font-size:13px;line-height:22px;">Follow us for updates, tips, and simple ideas to help you run your business better.</p>
              <div style="margin-bottom:22px;">
                <a class="social-link" href="https://www.instagram.com/mycroshop?igsh=YzA0dXBqNXk2anc1" target="_blank" style="display:inline-block;color:#ffffff;background:#1557f5;text-decoration:none;font-size:13px;font-weight:700;padding:10px 16px;border-radius:999px;margin:0 5px;">Instagram</a>
                <a class="social-link" href="https://x.com/hellomycroshop?s=21" target="_blank" style="display:inline-block;color:#ffffff;background:#1557f5;text-decoration:none;font-size:13px;font-weight:700;padding:10px 16px;border-radius:999px;margin:0 5px;">X / Twitter</a>
              </div>
              <p style="margin:0 0 8px 0;color:#cbd5e1;font-size:12px;line-height:20px;">Need help? Contact us at <a href="mailto:support@mycroshop.com" style="color:#ffffff;text-decoration:none;font-weight:700;">support@mycroshop.com</a></p>
              <p style="margin:0;color:#94a3b8;font-size:11px;line-height:18px;">${footerNote}</p>
              <p style="margin:10px 0 0 0;color:#64748b;font-size:11px;line-height:18px;">© MycroShop. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Welcome email HTML (sent after successful signup OTP verification).
 */
function generateWelcomeEmailHtml() {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Welcome to MycroShop</title>
  <style>
    html, body { margin:0!important; padding:0!important; width:100%!important; background:#f3f6fb; }
    body, table, td, p, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { border-collapse:collapse!important; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; display:block; }
    a { text-decoration:none; }
    @media only screen and (max-width:600px) {
      .wrapper { padding:14px 10px!important; }
      .email-container { width:100%!important; max-width:100%!important; border-radius:16px!important; }
      .content { padding:28px 22px 30px 22px!important; }
      .footer { padding:26px 22px!important; }
      .title { font-size:26px!important; line-height:34px!important; }
      .section-title { font-size:19px!important; line-height:27px!important; }
      .text { font-size:15px!important; line-height:25px!important; }
      .feature-wrap { padding:22px 18px 10px 18px!important; }
      .feature-col { display:block!important; width:100%!important; padding-right:0!important; padding-left:0!important; padding-bottom:12px!important; }
      .feature-card { margin-bottom:0!important; }
      .feature-text { font-size:14px!important; line-height:22px!important; }
      .step-box { padding:16px 16px!important; }
      .social-link { display:block!important; margin:8px auto!important; width:150px!important; text-align:center!important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#101828;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">Welcome to MycroShop — set up your store, manage orders, and grow with your AI Sales Agent.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f6fb;">
    <tr>
      <td align="center" class="wrapper" style="padding:30px 12px;">
        <table role="presentation" class="email-container" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 20px 55px rgba(16,24,40,0.10);">
          <tr>
            <td style="padding:0;background:#1557f5;">
              <img src="https://mycroshop.com/mwelcomeemail.png" alt="Welcome to MycroShop" width="640" style="width:100%;max-width:640px;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td class="content" style="padding:34px 42px 32px 42px;">
              <h1 class="title" style="margin:0 0 14px 0;color:#101828;font-size:28px;line-height:36px;font-weight:700;letter-spacing:-0.3px;">Welcome to MycroShop</h1>
              <p class="text" style="margin:0 0 18px 0;color:#344054;font-size:16px;line-height:28px;">Your MycroShop account is ready. You now have a simple platform to set up your online store, manage your products, organize orders, and make it easier for customers to buy from your business.</p>
              <p class="text" style="margin:0 0 18px 0;color:#344054;font-size:16px;line-height:28px;">MycroShop is built to help you run your business with more structure. Whether you sell products, offer services, or need a cleaner way to manage customer orders, everything starts from one easy dashboard.</p>
              <p class="text" style="margin:0 0 24px 0;color:#344054;font-size:16px;line-height:28px;">Your next step is to complete your store setup. Add your first product, update your business details, customize your store page, and get your store link ready to share with customers.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #dbe7ff;border-radius:18px;margin:4px 0 28px 0;overflow:hidden;">
                <tr>
                  <td class="feature-wrap" style="padding:24px 24px 12px 24px;">
                    <p style="margin:0 0 6px 0;color:#1557f5;font-size:13px;line-height:20px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;">What you can do with MycroShop</p>
                    <h2 class="section-title" style="margin:0 0 18px 0;color:#101828;font-size:21px;line-height:29px;font-weight:700;letter-spacing:-0.2px;">Everything you need to start, sell, and manage better.</h2>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="feature-col" width="50%" valign="top" style="padding:0 6px 12px 0;">
                          <table role="presentation" class="feature-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:14px;">
                            <tr><td style="padding:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                              <td valign="top" width="38" style="padding-right:12px;"><div style="width:34px;height:34px;border-radius:10px;background:#eaf1ff;color:#1557f5;font-size:13px;line-height:34px;font-weight:700;text-align:center;">01</div></td>
                              <td valign="top"><p style="margin:0 0 4px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">Online store setup</p><p class="feature-text" style="margin:0;color:#475467;font-size:13px;line-height:21px;">Create a clean, professional store for your business.</p></td>
                            </tr></table></td></tr>
                          </table>
                        </td>
                        <td class="feature-col" width="50%" valign="top" style="padding:0 0 12px 6px;">
                          <table role="presentation" class="feature-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:14px;">
                            <tr><td style="padding:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                              <td valign="top" width="38" style="padding-right:12px;"><div style="width:34px;height:34px;border-radius:10px;background:#eaf1ff;color:#1557f5;font-size:13px;line-height:34px;font-weight:700;text-align:center;">02</div></td>
                              <td valign="top"><p style="margin:0 0 4px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">Product management</p><p class="feature-text" style="margin:0;color:#475467;font-size:13px;line-height:21px;">Add, update, and organize your products easily.</p></td>
                            </tr></table></td></tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td class="feature-col" width="50%" valign="top" style="padding:0 6px 12px 0;">
                          <table role="presentation" class="feature-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:14px;">
                            <tr><td style="padding:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                              <td valign="top" width="38" style="padding-right:12px;"><div style="width:34px;height:34px;border-radius:10px;background:#eaf1ff;color:#1557f5;font-size:13px;line-height:34px;font-weight:700;text-align:center;">03</div></td>
                              <td valign="top"><p style="margin:0 0 4px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">Order management</p><p class="feature-text" style="margin:0;color:#475467;font-size:13px;line-height:21px;">Receive and track customer orders more clearly.</p></td>
                            </tr></table></td></tr>
                          </table>
                        </td>
                        <td class="feature-col" width="50%" valign="top" style="padding:0 0 12px 6px;">
                          <table role="presentation" class="feature-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:14px;">
                            <tr><td style="padding:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                              <td valign="top" width="38" style="padding-right:12px;"><div style="width:34px;height:34px;border-radius:10px;background:#eaf1ff;color:#1557f5;font-size:13px;line-height:34px;font-weight:700;text-align:center;">04</div></td>
                              <td valign="top"><p style="margin:0 0 4px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">Shareable store link</p><p class="feature-text" style="margin:0;color:#475467;font-size:13px;line-height:21px;">Send customers one link to view and buy from you.</p></td>
                            </tr></table></td></tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td class="feature-col" width="50%" valign="top" style="padding:0 6px 0 0;">
                          <table role="presentation" class="feature-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #c8d8ff;border-radius:14px;box-shadow:0 8px 20px rgba(21,87,245,0.08);">
                            <tr><td style="padding:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                              <td valign="top" width="38" style="padding-right:12px;"><div style="width:34px;height:34px;border-radius:10px;background:#1557f5;color:#ffffff;font-size:13px;line-height:34px;font-weight:700;text-align:center;">AI</div></td>
                              <td valign="top"><p style="margin:0 0 4px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">AI Sales Agent</p><p class="feature-text" style="margin:0;color:#475467;font-size:13px;line-height:21px;">Help customers with product questions, orders, and buying decisions.</p></td>
                            </tr></table></td></tr>
                          </table>
                        </td>
                        <td class="feature-col" width="50%" valign="top" style="padding:0 0 0 6px;">
                          <table role="presentation" class="feature-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e6edff;border-radius:14px;">
                            <tr><td style="padding:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                              <td valign="top" width="38" style="padding-right:12px;"><div style="width:34px;height:34px;border-radius:10px;background:#eaf1ff;color:#1557f5;font-size:13px;line-height:34px;font-weight:700;text-align:center;">06</div></td>
                              <td valign="top"><p style="margin:0 0 4px 0;color:#101828;font-size:15px;line-height:22px;font-weight:700;">Business organization</p><p class="feature-text" style="margin:0;color:#475467;font-size:13px;line-height:21px;">Keep your products, orders, and operations in one place.</p></td>
                            </tr></table></td></tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="padding:0;">
                    <p style="margin:0 0 8px 0;color:#1557f5;font-size:13px;line-height:20px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;">Your next step</p>
                    <h2 class="section-title" style="margin:0 0 12px 0;color:#101828;font-size:20px;line-height:28px;font-weight:700;letter-spacing:-0.2px;">Set up your store and start selling with confidence.</h2>
                    <p class="text" style="margin:0 0 16px 0;color:#344054;font-size:16px;line-height:28px;">You do not need technical skills to get started. Complete your store setup, add your first product, and prepare your store link so customers can easily discover, trust, and buy from your business.</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fbff;border:1px solid #e1e9ff;border-radius:16px;">
                      <tr>
                        <td class="step-box" style="padding:18px 20px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td valign="top" width="30" style="padding:0 0 10px 0;"><div style="width:22px;height:22px;border-radius:50%;background:#1557f5;color:#ffffff;font-size:12px;line-height:22px;font-weight:700;text-align:center;">1</div></td>
                              <td style="padding:0 0 10px 0;color:#344054;font-size:14px;line-height:22px;">Add your first product or service</td>
                            </tr>
                            <tr>
                              <td valign="top" width="30" style="padding:0 0 10px 0;"><div style="width:22px;height:22px;border-radius:50%;background:#1557f5;color:#ffffff;font-size:12px;line-height:22px;font-weight:700;text-align:center;">2</div></td>
                              <td style="padding:0 0 10px 0;color:#344054;font-size:14px;line-height:22px;">Update your business details and store page</td>
                            </tr>
                            <tr>
                              <td valign="top" width="30" style="padding:0;"><div style="width:22px;height:22px;border-radius:50%;background:#1557f5;color:#ffffff;font-size:12px;line-height:22px;font-weight:700;text-align:center;">3</div></td>
                              <td style="padding:0;color:#344054;font-size:14px;line-height:22px;">Share your store link with customers</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 4px 0;color:#101828;font-size:16px;line-height:26px;font-weight:700;">Welcome to MycroShop.</p>
              <p style="margin:0;color:#344054;font-size:15px;line-height:24px;">The MycroShop Team</p>
            </td>
          </tr>
          <tr>
            <td class="footer" style="background:#101828;padding:32px 42px;text-align:center;">
              <p style="margin:0 0 12px 0;color:#ffffff;font-size:17px;line-height:25px;font-weight:700;">Stay connected with MycroShop</p>
              <p style="margin:0 0 20px 0;color:#cbd5e1;font-size:13px;line-height:22px;">Follow us for updates, tips, and simple ideas to help you run your business better.</p>
              <div style="margin-bottom:22px;">
                <a class="social-link" href="https://www.instagram.com/mycroshop?igsh=YzA0dXBqNXk2anc1" target="_blank" style="display:inline-block;color:#ffffff;background:#1557f5;text-decoration:none;font-size:13px;font-weight:700;padding:10px 16px;border-radius:999px;margin:0 5px;">Instagram</a>
                <a class="social-link" href="https://x.com/hellomycroshop?s=21" target="_blank" style="display:inline-block;color:#ffffff;background:#1557f5;text-decoration:none;font-size:13px;font-weight:700;padding:10px 16px;border-radius:999px;margin:0 5px;">X / Twitter</a>
              </div>
              <p style="margin:0 0 8px 0;color:#cbd5e1;font-size:12px;line-height:20px;">Need help? Contact us at <a href="mailto:support@mycroshop.com" style="color:#ffffff;text-decoration:none;font-weight:700;">support@mycroshop.com</a></p>
              <p style="margin:0;color:#94a3b8;font-size:11px;line-height:18px;">You received this email because you created a MycroShop account.</p>
              <p style="margin:10px 0 0 0;color:#64748b;font-size:11px;line-height:18px;">© MycroShop. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

const FROM_ADDRESS = `"MycroShop" <${process.env.SMTP_USER || 'noreply@mycroshop.com'}>`;

async function sendOtpEmail(email, otp, type = 'signup') {
  const subject = type === 'forgot_password'
    ? 'Reset your MycroShop password'
    : 'Your MycroShop verification code';

  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from:    FROM_ADDRESS,
    to:      email,
    subject,
    html:    generateOtpEmailHtml(otp, type)
  });

  console.log(`OTP email (${type}) sent to ${email}:`, info.messageId);
  return info;
}

async function sendWelcomeEmail(email, businessName) {
  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from:    FROM_ADDRESS,
    to:      email,
    subject: 'Welcome to MycroShop 🎉',
    html:    generateWelcomeEmailHtml()
  });

  console.log(`Welcome email sent to ${email}:`, info.messageId);
  return info;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateOtp,
  validateOtp,
  sendOtpEmail,
  sendWelcomeEmail
};
