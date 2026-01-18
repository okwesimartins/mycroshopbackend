/**
 * Paystack Subaccount Service
 * Handles creation and management of Paystack subaccounts for split payments
 */

const axios = require('axios');

/**
 * Create Paystack subaccount
 * @param {Object} options - Subaccount creation options
 * @param {string} options.secretKey - Paystack secret key
 * @param {string} options.businessName - Business/store name
 * @param {string} options.settlementBank - Bank code (default: 101 for Providus)
 * @param {string} options.accountNumber - Account number (default: MycroShop account)
 * @param {string} options.percentageCharge - Percentage charge (optional)
 * @param {boolean} options.testMode - Test mode flag
 * @returns {Promise<Object>} - Subaccount details
 */
async function createPaystackSubaccount(options = {}) {
  const {
    secretKey,
    businessName,
    settlementBank = '101', // Providus Bank
    accountNumber = '1307737031', // MycroShop account
    percentageCharge = null,
    testMode = false
  } = options;

  if (!secretKey) {
    throw new Error('Paystack secret key is required');
  }

  if (!businessName) {
    throw new Error('Business name is required');
  }

  const baseUrl = 'https://api.paystack.co';

  try {
    // Prepare subaccount payload
    const payload = {
      business_name: businessName,
      settlement_bank: settlementBank,
      account_number: accountNumber,
      percentage_charge: percentageCharge || undefined
    };

    // Remove undefined fields
    Object.keys(payload).forEach(key => {
      if (payload[key] === undefined) {
        delete payload[key];
      }
    });

    console.log('Creating Paystack subaccount with payload:', {
      business_name: payload.business_name,
      settlement_bank: payload.settlement_bank,
      account_number: payload.account_number,
      has_percentage_charge: !!payload.percentage_charge
    });

    const response = await axios.post(
      `${baseUrl}/subaccount`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const subaccountData = response.data.data;

    return {
      subaccount_id: subaccountData.id || subaccountData.subaccount_id || null, // Paystack subaccount ID
      subaccount_code: subaccountData.subaccount_code,
      business_name: subaccountData.business_name,
      settlement_bank: subaccountData.settlement_bank,
      account_number: subaccountData.account_number,
      account_name: subaccountData.account_name,
      percentage_charge: subaccountData.percentage_charge,
      active: subaccountData.active,
      integration: subaccountData.integration,
      domain: subaccountData.domain,
      split_code: subaccountData.split_code || null
    };
  } catch (error) {
    console.error('Error creating Paystack subaccount:', error.response?.data || error.message);
    
    // Create a detailed error object with Paystack response
    const paystackError = new Error();
    paystackError.name = 'PaystackSubaccountError';
    
    // Handle specific Paystack errors
    if (error.response?.data) {
      const paystackResponse = error.response.data;
      paystackError.message = paystackResponse.message || 'Failed to create Paystack subaccount';
      paystackError.paystackResponse = paystackResponse;
      paystackError.status = error.response.status;
      paystackError.statusText = error.response.statusText;
    } else if (error.request) {
      // Request was made but no response received
      paystackError.message = 'No response from Paystack API. Please check your network connection and API credentials.';
      paystackError.isNetworkError = true;
    } else {
      // Error in setting up the request
      paystackError.message = 'Failed to create Paystack subaccount: ' + error.message;
    }
    
    // Attach original error for debugging
    paystackError.originalError = error;
    
    throw paystackError;
  }
}

/**
 * Get Paystack subaccount details
 * @param {string} subaccountCode - Subaccount code
 * @param {string} secretKey - Paystack secret key
 * @returns {Promise<Object>} - Subaccount details
 */
async function getPaystackSubaccount(subaccountCode, secretKey) {
  const baseUrl = 'https://api.paystack.co';

  try {
    const response = await axios.get(
      `${baseUrl}/subaccount/${subaccountCode}`,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`
        }
      }
    );

    return response.data.data;
  } catch (error) {
    console.error('Error fetching Paystack subaccount:', error.response?.data || error.message);
    throw new Error('Failed to fetch Paystack subaccount: ' + (error.response?.data?.message || error.message));
  }
}

/**
 * Update Paystack subaccount
 * @param {string} subaccountCode - Subaccount code
 * @param {Object} updates - Fields to update
 * @param {string} secretKey - Paystack secret key
 * @returns {Promise<Object>} - Updated subaccount details
 */
async function updatePaystackSubaccount(subaccountCode, updates, secretKey) {
  const baseUrl = 'https://api.paystack.co';

  try {
    const response = await axios.put(
      `${baseUrl}/subaccount/${subaccountCode}`,
      updates,
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.data;
  } catch (error) {
    console.error('Error updating Paystack subaccount:', error.response?.data || error.message);
    throw new Error('Failed to update Paystack subaccount: ' + (error.response?.data?.message || error.message));
  }
}

module.exports = {
  createPaystackSubaccount,
  getPaystackSubaccount,
  updatePaystackSubaccount
};

