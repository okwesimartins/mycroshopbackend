const express = require('express');
const router = express.Router();
const storeServiceController = require('../controllers/storeServiceController');
const { authenticate, authorize } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for service image uploads
const serviceImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../uploads/services');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'service-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadServiceImageMulter = multer({
  storage: serviceImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
}).single('service_image');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Get all services for an online store
router.get('/online/:online_store_id/services', storeServiceController.getOnlineStoreServices);

// Get service by ID
router.get('/services/:id', storeServiceController.getStoreServiceById);

// Create service for online store (works for free users - no physical store required)
// Supports both file upload (service_image) and service_image_url
router.post('/online/:online_store_id/services', authorize('admin', 'manager'), uploadServiceImageMulter, storeServiceController.createOnlineStoreService);

// Upload service image (separate endpoint)
router.post('/services/:service_id/image', authorize('admin', 'manager'), uploadServiceImageMulter, storeServiceController.uploadServiceImage);

// Update service (supports file upload and form-data)
router.put('/services/:id', authorize('admin', 'manager'), uploadServiceImageMulter, storeServiceController.updateStoreService);

// Delete service
router.delete('/services/:id', authorize('admin'), storeServiceController.deleteStoreService);

// Get service availability
router.get('/services/:service_id/availability', storeServiceController.getServiceAvailability);

// Set service availability
router.post('/services/:service_id/availability', authorize('admin', 'manager'), storeServiceController.setServiceAvailability);

module.exports = router;

