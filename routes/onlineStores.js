const express = require('express');
const router = express.Router();
const onlineStoreController = require('../controllers/onlineStoreController');
const { authenticate, authorize } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for product image uploads
const productImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../uploads/products');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'product-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadProductImageMulter = multer({
  storage: productImageStorage,
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
}).single('product_image');

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Check online store setup status
router.get('/check-setup', onlineStoreController.checkOnlineStoreSetup);

// Create/initialize online store
router.post('/setup', onlineStoreController.setupOnlineStore);

// Get online store by ID
router.get('/:id', onlineStoreController.getOnlineStoreById);

// Update storefront (Step 1)
router.put('/:id/storefront', onlineStoreController.updateStorefront);

// Update store information (Step 2)
router.put('/:id/information', onlineStoreController.updateStoreInformation);

// Update store appearance (Step 3)
router.put('/:id/appearance', onlineStoreController.updateStoreAppearance);

// Upload store image (logo, banner, background)
router.post('/:id/image', onlineStoreController.uploadStoreImage);

// Publish/unpublish store
router.patch('/:id/publish', onlineStoreController.publishOnlineStore);

// Create product directly for online store (free users only - auto-published)
// Configure multer for variation option images
const variationOptionImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../uploads/product-variations');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'variation-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadVariationOptionImagesMulter = multer({
  storage: variationOptionImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
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
}).any(); // Accept any field name matching pattern

// Dynamic multer middleware for product image and variation option images
const productImageMulterMiddleware = (req, res, next) => {
  // Use dynamic storage to save product_image to /uploads/products/ 
  // and variation_option_image_* to /uploads/product-variations/
  const dynamicStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      let uploadPath;
      if (file.fieldname === 'product_image') {
        uploadPath = path.join(__dirname, '../uploads/products');
      } else if (file.fieldname.startsWith('variation_option_image_')) {
        uploadPath = path.join(__dirname, '../uploads/product-variations');
      } else {
        uploadPath = path.join(__dirname, '../uploads/products'); // Default
      }
      
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      if (file.fieldname === 'product_image') {
        cb(null, 'product-' + uniqueSuffix + path.extname(file.originalname));
      } else {
        cb(null, 'variation-' + uniqueSuffix + path.extname(file.originalname));
      }
    }
  });

  const combinedMulter = multer({
    storage: dynamicStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
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
  }).any();
  
  combinedMulter(req, res, (err) => {
    if (err) return next(err);
    next();
  });
};

// Create product directly for online store (free users only - auto-published)
router.post('/:id/products', productImageMulterMiddleware, onlineStoreController.createOnlineStoreProduct);

// Update product for online store (free users only)
router.put('/:id/products/:product_id', productImageMulterMiddleware, onlineStoreController.updateOnlineStoreProduct);

// Publish product to online store (free users only)
router.post('/:id/products/:product_id/publish', onlineStoreController.publishOnlineStoreProduct);

// Remove/Delete product from online store (free users only)
// Query param: ?unpublish_only=true (optional - if true, only unpublishes, doesn't delete product)
router.delete('/:id/products/:product_id', onlineStoreController.removeOnlineStoreProduct);

module.exports = router;

