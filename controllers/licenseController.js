const { LicenseKey, createLicenseKey } = require('../config/tenant');

/**
 * Generate one or multiple license keys
 */
async function generateLicenseKeys(req, res) {
  try {
    const { quantity = 1, expires_at, purchased_by, purchased_email } = req.body;

    if (quantity < 1 || quantity > 100) {
      return res.status(400).json({
        success: false,
        message: 'Quantity must be between 1 and 100'
      });
    }

    const licenseKeys = [];

    for (let i = 0; i < quantity; i++) {
      const license = await createLicenseKey({
        expires_at: expires_at ? new Date(expires_at) : null,
        purchased_by: purchased_by || null,
        purchased_email: purchased_email || null
      });
      licenseKeys.push(license);
    }

    res.status(201).json({
      success: true,
      message: `${quantity} license key(s) generated successfully`,
      data: {
        licenseKeys: licenseKeys.map(l => ({
          id: l.id,
          license_key: l.license_key,
          status: l.status,
          expires_at: l.expires_at
        }))
      }
    });
  } catch (error) {
    console.error('Error generating license keys:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate license keys'
    });
  }
}

/**
 * Get all license keys
 */
async function getAllLicenseKeys(req, res) {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (status) {
      where.status = status;
    }

    const { count, rows } = await LicenseKey.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        licenseKeys: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting license keys:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get license keys'
    });
  }
}

/**
 * Get license key by ID
 */
async function getLicenseKeyById(req, res) {
  try {
    const license = await LicenseKey.findByPk(req.params.id);

    if (!license) {
      return res.status(404).json({
        success: false,
        message: 'License key not found'
      });
    }

    res.json({
      success: true,
      data: { licenseKey: license }
    });
  } catch (error) {
    console.error('Error getting license key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get license key'
    });
  }
}

/**
 * Update license key status
 */
async function updateLicenseKeyStatus(req, res) {
  try {
    const { status } = req.body;
    
    const validStatuses = ['active', 'used', 'expired', 'revoked'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const license = await LicenseKey.findByPk(req.params.id);
    
    if (!license) {
      return res.status(404).json({
        success: false,
        message: 'License key not found'
      });
    }

    await license.update({ status });

    res.json({
      success: true,
      message: 'License key status updated successfully',
      data: { licenseKey: license }
    });
  } catch (error) {
    console.error('Error updating license key status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update license key status'
    });
  }
}

/**
 * Revoke license key
 */
async function revokeLicenseKey(req, res) {
  try {
    const license = await LicenseKey.findByPk(req.params.id);
    
    if (!license) {
      return res.status(404).json({
        success: false,
        message: 'License key not found'
      });
    }

    await license.update({ status: 'revoked' });

    res.json({
      success: true,
      message: 'License key revoked successfully'
    });
  } catch (error) {
    console.error('Error revoking license key:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to revoke license key'
    });
  }
}

module.exports = {
  generateLicenseKeys,
  getAllLicenseKeys,
  getLicenseKeyById,
  updateLicenseKeyStatus,
  revokeLicenseKey
};

