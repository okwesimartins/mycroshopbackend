const express = require('express');
const router = express.Router();
const storeServiceController = require('../controllers/storeServiceController');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

// Get all store services
router.get('/', storeServiceController.getAllStoreServices);

// Get store service by ID
router.get('/:id', storeServiceController.getStoreServiceById);

// Get service availability
router.get('/:service_id/availability', storeServiceController.getServiceAvailability);

// Configure multer for service image uploads
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// Create store service (admin/manager only) - supports file upload and form-data
router.post('/', authorize('admin', 'manager'), uploadServiceImageMulter, storeServiceController.createStoreService);

// Set service availability (admin/manager only)
router.post('/:service_id/availability', authorize('admin', 'manager'), storeServiceController.setServiceAvailability);

// Link existing service to online store (admin/manager only)
router.post('/:service_id/link-online-store', authorize('admin', 'manager'), storeServiceController.linkServiceToOnlineStore);

// Update store service (admin/manager only) - supports file upload and form-data
router.put('/:id', authorize('admin', 'manager'), uploadServiceImageMulter, storeServiceController.updateStoreService);

// Delete store service (admin only)
router.delete('/:id', authorize('admin'), storeServiceController.deleteStoreService);

module.exports = router;

