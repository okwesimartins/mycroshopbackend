const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { attachTenantDb } = require('../middleware/tenant');
const { initializeTenantModels } = require('../middleware/models');
const inventoryController = require('../controllers/inventoryController');
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

// Configure multer for variation option images (multiple files)
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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
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
}).any(); // Accept any field name matching variation_option_image_* pattern

// All routes require authentication and tenant DB
router.use(authenticate);
router.use(attachTenantDb);
router.use(initializeTenantModels);

// Middleware to route free users to basic inventory, enterprise to full inventory
async function routeInventoryByPlan(req, res, next) {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenantId);
    
    if (tenant && tenant.subscription_plan === 'free') {
      // Free users get basic inventory
      return inventoryController.getBasicInventoryForFreeUsers(req, res);
    } else {
      // Enterprise users get full inventory
      return inventoryController.getAllProducts(req, res);
    }
  } catch (error) {
    console.error('Error routing inventory:', error);
    // Fallback to enterprise inventory
    return inventoryController.getAllProducts(req, res);
  }
}

// Get all products (automatically routes free users to basic inventory, enterprise to full inventory)
router.get('/', routeInventoryByPlan);

// Middleware to restrict routes to enterprise users only
async function requireEnterprise(req, res, next) {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const { getTenantById } = require('../config/tenant');
    const tenant = await getTenantById(tenantId);
    
    if (tenant && tenant.subscription_plan === 'free') {
      return res.status(403).json({
        success: false,
        message: 'This feature is only available for enterprise users. Free users should use the online store routes for product management.'
      });
    }
    
    next();
  } catch (error) {
    console.error('Error checking subscription plan:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify subscription plan'
    });
  }
}

// Get low stock products (Enterprise only - MUST come before /:id to avoid route conflicts)
router.get('/alerts/low-stock', requireEnterprise, inventoryController.getLowStockProducts);

// Get product categories (Available for all users - MUST come before /:id to avoid route conflicts)
router.get('/categories', inventoryController.getProductCategories);

// Barcode scanning endpoints for inventory management (Enterprise only - MUST come before /:id)
router.get('/lookup/barcode', requireEnterprise, inventoryController.lookupProductByBarcode);
router.put('/stock/by-barcode', requireEnterprise, inventoryController.updateStockByBarcode);
router.post('/stock/bulk-update', requireEnterprise, inventoryController.bulkUpdateStock);

// Get product stock summary (MUST come before /:id to avoid route conflicts)
router.get('/:id/stock-summary', inventoryController.getProductStockSummary);

// Get product by ID (parameterized routes should come last)
router.get('/:id', inventoryController.getProductById);

// Create product (Enterprise only - with file upload support for product image and variation option images)
router.post('/',
  requireEnterprise,
  (req, res, next) => {
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
  },
  [
    body('name').notEmpty().withMessage('Product name is required'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number')
  ],
  inventoryController.createProduct
);

// Update product (Enterprise only - with file upload support)
// Note: Free users should use PUT /api/v1/online-stores/:id/products/:product_id
router.put('/:id', requireEnterprise, uploadProductImageMulter, inventoryController.updateProduct);

// Delete product (Enterprise only)
// Note: Free users should use DELETE /api/v1/online-stores/:id/products/:product_id
router.delete('/:id', requireEnterprise, authorize('admin', 'manager'), inventoryController.deleteProduct);

// Add product to additional stores (Enterprise only - multi-store feature)
router.post('/:product_id/stores', requireEnterprise, inventoryController.addProductToStores);

// Remove product from store (Enterprise only - multi-store feature)
router.delete('/:product_id/stores/:store_id', requireEnterprise, inventoryController.removeProductFromStore);

module.exports = router;

