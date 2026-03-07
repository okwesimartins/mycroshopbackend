const jwt = require('jsonwebtoken');
const { getTenantById } = require('../config/tenant');

/**
 * Verify JWT token and extract tenant information
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];

    // Option 1: API key authentication (for AI sales agent and server-to-server calls)
    const aiAgentApiKey = process.env.AI_AGENT_API_KEY;
    if (aiAgentApiKey && apiKeyHeader && apiKeyHeader === aiAgentApiKey) {
      // Resolve endpoints get tenant_id from phone_number_id; don't require tenant_id in request
      const path = (req.baseUrl || '') + (req.path || '');
      const isResolveEndpoint = /resolve-tenant|resolve-phone-number-id/.test(path);
      if (isResolveEndpoint) {
        req.user = { id: null, email: null, role: 'ai_agent', is_ai_agent: true };
        return next();
      }

      const tenantIdFromRequest = req.body?.tenant_id || req.query?.tenant_id;
      const tenantId = tenantIdFromRequest ? parseInt(tenantIdFromRequest, 10) : null;

      if (!tenantId || Number.isNaN(tenantId)) {
        return res.status(400).json({
          success: false,
          message: 'tenant_id is required for API key authentication'
        });
      }

      // Treat this as an AI agent user associated with the provided tenant
      req.user = {
        id: null,
        email: null,
        role: 'ai_agent',
        tenantId,
        is_ai_agent: true
      };

      return next();
    }

    // Option 2: Regular JWT authentication
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Platform admins don't have tenant_id
    if (decoded.role === 'platform_admin' || decoded.is_platform_admin) {
      req.user = {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role,
        is_platform_admin: true
      };
      req.tenant = null; // Platform admins don't have tenants
      return next();
    }

    // Regular users must have tenant
    if (!decoded.tenantId) {
      return res.status(403).json({
        success: false,
        message: 'Invalid token: tenant required'
      });
    }

    // Verify tenant exists and is active
    const tenant = await getTenantById(decoded.tenantId);
    if (!tenant || tenant.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Invalid or inactive tenant'
      });
    }

    // Attach user and tenant info to request
    req.user = {
      id: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      tenantId: decoded.tenantId
    };
    req.tenant = tenant;

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Authentication error'
    });
  }
}

/**
 * Check if user has required role
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }

    next();
  };
}

module.exports = {
  authenticate,
  authorize
};

