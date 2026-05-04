/**
 * Weekly Analytics Cron Script
 * Run via Linux crontab — every Sunday at 9:00 AM:
 *   0 9 * * 0 cd /home/user/mycroshopbackend && /opt/cpanel/ea-nodejs18/bin/node scripts/sendWeeklyAnalytics.js >> /home/user/logs/weekly-analytics.log 2>&1
 */

require('dotenv').config();

const { sendWeeklyAnalyticsToAll } = require('../services/notificationService');
const { mainSequelize } = require('../config/database');

async function run() {
  console.log(`[${new Date().toISOString()}] Starting weekly analytics`);

  try {
    await mainSequelize.authenticate();
    await sendWeeklyAnalyticsToAll();
    console.log(`[${new Date().toISOString()}] Weekly analytics completed`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Weekly analytics failed:`, err.message);
    process.exit(1);
  } finally {
    await mainSequelize.close().catch(() => {});
    process.exit(0);
  }
}

run();
