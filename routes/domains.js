const express = require('express');
const router = express.Router();
const domainController = require('../controllers/domainController');
const { authenticate, authorize } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');

// All routes require authentication and tenant DB/models
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Check domain availability (public check, no purchase)
router.get('/check', domainController.checkDomainAvailability);

// Get domain pricing
router.get('/pricing', domainController.getDomainPricing);

// Checkout - Initialize domain purchase with payment
router.post('/checkout', domainController.checkoutDomain);

// Purchase/Register domain (DEPRECATED - Use /checkout instead)
// This endpoint returns 410 Gone status - kept for backward compatibility
// router.post('/purchase', domainController.purchaseDomain);

// Get all domains for current tenant
router.get('/', domainController.getAllDomains);

// Get domain by ID
router.get('/:id', domainController.getDomainById);

// Link domain to online store
router.post('/:id/link', domainController.linkDomainToStore);

// Unlink domain from online store
router.post('/:id/unlink', domainController.unlinkDomainFromStore);

// Get DNS records for domain
router.get('/:id/dns', domainController.getDNSRecords);

// Update DNS records for domain
router.put('/:id/dns', domainController.updateDNSRecords);

// Provision SSL certificate for domain
router.post('/:id/ssl', domainController.provisionSSL);

// Check SSL status for domain
router.get('/:id/ssl', domainController.checkSSLStatus);

module.exports = router;

