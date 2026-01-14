const crypto = require('crypto');
const { createPaystackSubaccount } = require('../services/paystackSubaccountService');

/**
 * Get payment gateway configuration
 */
async function getPaymentGateways(req, res) {
  try {
    const gateways = await req.db.models.PaymentGateway.findAll({
      where: { tenant_id: req.user.tenantId },
      attributes: ['id', 'gateway_name', 'is_active', 'is_default', 'public_key', 'test_mode', 'created_at'],
      order: [['is_default', 'DESC'], ['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: { gateways }
    });
  } catch (error) {
    console.error('Error getting payment gateways:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get payment gateways'
    });
  }
}

/**
 * Add payment gateway configuration
 */
async function addPaymentGateway(req, res) {
  try {
    const {
      gateway_name,
      public_key,
      secret_key,
      webhook_secret,
      test_mode = false,
      is_default = false
    } = req.body;

    if (!gateway_name || !public_key || !secret_key) {
      return res.status(400).json({
        success: false,
        message: 'gateway_name, public_key, and secret_key are required'
      });
    }

    const validGateways = ['paystack', 'flutterwave', 'stripe', 'other'];
    if (!validGateways.includes(gateway_name)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid gateway name. Must be: paystack, flutterwave, stripe, or other'
      });
    }

    // Encrypt secret key (simple encryption - in production use stronger encryption)
    const encryptedSecretKey = encryptSecretKey(secret_key);

    // If setting as default, unset other defaults
    if (is_default) {
      await req.db.models.PaymentGateway.update(
        { is_default: false },
        { where: { tenant_id: req.user.tenantId } }
      );
    }

    // Create payment gateway
    const gateway = await req.db.models.PaymentGateway.create({
      tenant_id: req.user.tenantId,
      gateway_name,
      public_key,
      secret_key: encryptedSecretKey,
      webhook_secret: webhook_secret || null,
      test_mode: test_mode || false,
      is_default: is_default || false,
      is_active: true
    });

    // If Paystack, create subaccount and link to online store
    let subaccountDetails = null;
    if (gateway_name === 'paystack') {
      try {
        // Get user's online store
        const onlineStore = await req.db.models.OnlineStore.findOne({
          where: { tenant_id: req.user.tenantId },
          order: [['created_at', 'DESC']] // Get most recent online store
        });

        if (onlineStore) {
          console.log(`Creating Paystack subaccount for online store: ${onlineStore.id} (${onlineStore.store_name})`);

          // Create Paystack subaccount
          // Use MycroShop account details for settlement
          subaccountDetails = await createPaystackSubaccount({
            secretKey: secret_key, // Use unencrypted key for API call
            businessName: onlineStore.store_name || 'MycroShop Store',
            settlementBank: '101', // Providus Bank
            accountNumber: '1307737031', // MycroShop account
            testMode: test_mode
          });

          // Save subaccount code to online store
          await onlineStore.update({
            paystack_subaccount_code: subaccountDetails.subaccount_code
          });

          console.log(`✅ Paystack subaccount created and linked to online store ${onlineStore.id}`);
          console.log(`   Subaccount Code: ${subaccountDetails.subaccount_code}`);
          console.log(`   Account Name: ${subaccountDetails.account_name}`);
        } else {
          console.warn('No online store found for user. Subaccount created but not linked.');
        }
      } catch (subaccountError) {
        console.error('Error creating Paystack subaccount:', subaccountError);
        // Don't fail gateway creation if subaccount creation fails
        // Gateway is still created, user can manually configure subaccount later
      }
    }

    res.status(201).json({
      success: true,
      message: 'Payment gateway added successfully',
      data: {
        gateway: {
          id: gateway.id,
          gateway_name: gateway.gateway_name,
          public_key: gateway.public_key,
          is_active: gateway.is_active,
          is_default: gateway.is_default,
          test_mode: gateway.test_mode
        },
        ...(subaccountDetails && {
          subaccount: {
            subaccount_code: subaccountDetails.subaccount_code,
            account_name: subaccountDetails.account_name,
            settlement_bank: subaccountDetails.settlement_bank,
            account_number: subaccountDetails.account_number,
            active: subaccountDetails.active
          }
        })
      }
    });
  } catch (error) {
    console.error('Error adding payment gateway:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * Update payment gateway
 */
async function updatePaymentGateway(req, res) {
  try {
    const { id } = req.params;
    const {
      public_key,
      secret_key,
      webhook_secret,
      test_mode,
      is_active,
      is_default
    } = req.body;

    const gateway = await req.db.models.PaymentGateway.findOne({
      where: { id, tenant_id: req.user.tenantId }
    });

    if (!gateway) {
      return res.status(404).json({
        success: false,
        message: 'Payment gateway not found'
      });
    }

    // If setting as default, unset other defaults
    if (is_default) {
      await req.db.models.PaymentGateway.update(
        { is_default: false },
        { where: { tenant_id: req.user.tenantId, id: { [require('sequelize').Op.ne]: id } } }
      );
    }

    const updateData = {};
    if (public_key !== undefined) updateData.public_key = public_key;
    if (secret_key !== undefined) updateData.secret_key = encryptSecretKey(secret_key);
    if (webhook_secret !== undefined) updateData.webhook_secret = webhook_secret;
    if (test_mode !== undefined) updateData.test_mode = test_mode;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (is_default !== undefined) updateData.is_default = is_default;

    await gateway.update(updateData);

    res.json({
      success: true,
      message: 'Payment gateway updated successfully',
      data: {
        gateway: {
          id: gateway.id,
          gateway_name: gateway.gateway_name,
          public_key: gateway.public_key,
          is_active: gateway.is_active,
          is_default: gateway.is_default,
          test_mode: gateway.test_mode
        }
      }
    });
  } catch (error) {
    console.error('Error updating payment gateway:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update payment gateway'
    });
  }
}

/**
 * Delete payment gateway
 */
async function deletePaymentGateway(req, res) {
  try {
    const { id } = req.params;

    const gateway = await req.db.models.PaymentGateway.findOne({
      where: { id, tenant_id: req.user.tenantId }
    });

    if (!gateway) {
      return res.status(404).json({
        success: false,
        message: 'Payment gateway not found'
      });
    }

    await gateway.destroy();

    res.json({
      success: true,
      message: 'Payment gateway deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting payment gateway:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete payment gateway'
    });
  }
}

/**
 * Encrypt secret key (simple encryption - use stronger in production)
 */
function encryptSecretKey(secretKey) {
  // In production, use proper encryption like AES-256-GCM
  // For now, using a simple base64 encoding (NOT secure for production)
  // TODO: Implement proper encryption with crypto.createCipheriv()
  const algorithm = 'aes-256-cbc';
  const key = Buffer.from(process.env.ENCRYPTION_KEY || 'default-key-32-characters-long!!', 'utf8');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(secretKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt secret key
 */
function decryptSecretKey(encryptedKey) {
  try {
    const algorithm = 'aes-256-cbc';
    const key = Buffer.from(process.env.ENCRYPTION_KEY || 'default-key-32-characters-long!!', 'utf8');
    const parts = encryptedKey.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Error decrypting secret key:', error);
    return null;
  }
}

module.exports = {
  getPaymentGateways,
  addPaymentGateway,
  updatePaymentGateway,
  deletePaymentGateway,
  decryptSecretKey
};

