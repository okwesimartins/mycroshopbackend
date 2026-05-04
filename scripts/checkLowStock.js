// Low Stock Check Cron Script
// Run via Linux crontab — every 2 hours:
//   0 */2 * * * cd /home/user/mycroshopbackend && /opt/cpanel/ea-nodejs18/bin/node scripts/checkLowStock.js >> /home/user/logs/low-stock.log 2>&1

require('dotenv').config();

const { checkAllTenantsLowStock } = require('../services/notificationService');
const { mainSequelize } = require('../config/database');

async function run() {
  console.log(`[${new Date().toISOString()}] Starting low stock check`);

  try {
    await mainSequelize.authenticate();
    await checkAllTenantsLowStock();
    console.log(`[${new Date().toISOString()}] Low stock check completed`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Low stock check failed:`, err.message);
    process.exit(1);
  } finally {
    await mainSequelize.close().catch(() => {});
    process.exit(0);
  }
}

run();
