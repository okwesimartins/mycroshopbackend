/**
 * Retry Failed Order Emails
 * ─────────────────────────────────────────────────────────────────────────────
 * Queries `order_email_log` in the main DB for emails that failed or are still
 * pending (e.g. the server crashed before sending) and retries them.
 *
 * Limits retries to MAX_ATTEMPTS (default 3) per email.
 * All rendered HTML is stored in the log row — no DB lookups needed for retry.
 *
 * Run via crontab (e.g. every 15 minutes):
 *   *\/15 * * * * cd /home/user/mycroshopbackend && /opt/cpanel/ea-nodejs18/bin/node scripts/retryFailedOrderEmails.js >> /home/user/logs/retry-order-emails.log 2>&1
 */

'use strict';

require('dotenv').config();

const { mainSequelize } = require('../config/database');
const { initializeTransporter } = require('../services/emailService');

const MAX_ATTEMPTS = 3;

async function run() {
  const ts = () => new Date().toISOString();
  console.log(`[${ts()}] retryFailedOrderEmails: starting`);

  try {
    await mainSequelize.authenticate();

    // Fetch emails that need a retry
    const [rows] = await mainSequelize.query(
      `SELECT id, recipient_email, from_address, subject, html_content, attempts
       FROM order_email_log
       WHERE status IN ('pending', 'failed')
         AND attempts < ?
       ORDER BY created_at ASC
       LIMIT 50`,
      { replacements: [MAX_ATTEMPTS] }
    );

    if (rows.length === 0) {
      console.log(`[${ts()}] No pending/failed emails found.`);
      return;
    }

    console.log(`[${ts()}] Found ${rows.length} email(s) to retry.`);

    const transporter = initializeTransporter();

    for (const row of rows) {
      // Bump attempt counter + timestamp before sending (so a crash doesn't
      // leave the row in 'pending' forever)
      await mainSequelize.query(
        `UPDATE order_email_log
         SET attempts = attempts + 1, last_attempted_at = NOW()
         WHERE id = ?`,
        { replacements: [row.id] }
      );

      try {
        const info = await transporter.sendMail({
          from:    row.from_address,
          to:      row.recipient_email,
          subject: row.subject,
          html:    row.html_content
        });

        await mainSequelize.query(
          `UPDATE order_email_log SET status = 'sent' WHERE id = ?`,
          { replacements: [row.id] }
        );

        console.log(`[${ts()}] ✅ Sent log#${row.id} → ${row.recipient_email} (messageId: ${info.messageId})`);
      } catch (sendErr) {
        const errMsg = String(sendErr.message || sendErr).slice(0, 1000);

        // Mark failed; if this was the last allowed attempt, it stays 'failed'
        // permanently until manual intervention or the limit is raised.
        await mainSequelize.query(
          `UPDATE order_email_log
           SET status = 'failed', error_message = ?
           WHERE id = ?`,
          { replacements: [errMsg, row.id] }
        );

        console.error(`[${ts()}] ❌ Failed log#${row.id} → ${row.recipient_email}: ${errMsg}`);
      }
    }

    console.log(`[${ts()}] retryFailedOrderEmails: done`);
  } catch (err) {
    console.error(`[${ts()}] retryFailedOrderEmails: fatal error:`, err.message);
    process.exit(1);
  } finally {
    await mainSequelize.close().catch(() => {});
    process.exit(0);
  }
}

run();
