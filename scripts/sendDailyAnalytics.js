/**
 * Daily Analytics Cron Script
 * Run via Linux crontab — e.g. every day at 8:00 PM:
 *   0 20 * * * cd /home/user/mycroshopbackend && /opt/cpanel/ea-nodejs18/bin/node scripts/sendDailyAnalytics.js >> /home/user/logs/daily-analytics.log 2>&1
 */

require('dotenv').config();

const { sendDailyAnalyticsToAll } = require('../services/notificationService');
const { mainSequelize } = require('../config/database');

async function run() {
  // Optional: pass a specific date as CLI arg, e.g. node sendDailyAnalytics.js 2025-05-03
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);

  console.log(`[${new Date().toISOString()}] Starting daily analytics for ${date}`);

  try {
    await mainSequelize.authenticate();
    await sendDailyAnalyticsToAll(date);
    console.log(`[${new Date().toISOString()}] Daily analytics completed`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Daily analytics failed:`, err.message);
    process.exit(1);
  } finally {
    await mainSequelize.close().catch(() => {});
    process.exit(0);
  }
}

run();
