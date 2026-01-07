/**
 * Initialize main database tables
 * Run this script once to set up the main database
 */

require('dotenv').config();
const { mainSequelize, initializeMainDatabase } = require('../config/tenant');

async function init() {
  try {
    console.log('Initializing main database...');
    
    // Test connection
    await mainSequelize.authenticate();
    console.log('✓ Database connection established');

    // Initialize tables
    await initializeMainDatabase();
    console.log('✓ Main database tables initialized');

    console.log('\nMain database setup complete!');
    console.log('You can now register tenants via the API.');
    
    process.exit(0);
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exit(1);
  }
}

init();

