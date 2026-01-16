const multer = require('multer');
const path = require('path');
const fs = require('fs');
const initModels = require('../models');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../uploads/stores');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'store-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
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
}).fields([
  { name: 'logo', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
  { name: 'background', maxCount: 1 },
  { name: 'image', maxCount: 1 } // Keep for backward compatibility
]);

/**
 * Helper: load an OnlineStore by ID, making sure it belongs to the current tenant.
 * - For free tenants (shared DB), we enforce tenant_id = req.user.tenantId via raw SQL first.
 * - For enterprise tenants (separate DB per tenant), any row in this DB already belongs to the tenant.
 */
async function findTenantOnlineStoreById(req, models, id, includeOptions) {
  if (!req.db) {
    throw new Error('Database connection not available');
  }

  const tenant = req.tenant;
  const tenantId = req.user?.tenantId;
  const isFreePlan = tenant && tenant.subscription_plan === 'free';

  const numericId = Number(id);
  if (!numericId || Number.isNaN(numericId)) {
    return null;
  }

  if (isFreePlan) {
    // Ensure this online_store row belongs to the current tenant in the shared DB
    const [rows] = await req.db.query(
      'SELECT id FROM online_stores WHERE id = ? AND tenant_id = ? LIMIT 1',
      { replacements: [numericId, tenantId] }
    );
    if (!rows || rows.length === 0) {
      return null; // either not found or belongs to another tenant
    }
  }

  // Safe to load with Sequelize (DB is already tenant‑isolated for enterprise,
  // or we verified tenant_id for free)

  return models.OnlineStore.findByPk(numericId, includeOptions || undefined);
}

/**
 * Check if online store exists and setup status
 */
async function checkOnlineStoreSetup(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models fresh for this request and use local reference
    const models = initModels(req.db);

    const onlineStores = await models.OnlineStore.findAll({
      order: [['created_at', 'DESC']]
    });

    const hasOnlineStore = onlineStores.length > 0;
    const latestStore = onlineStores[0] || null;

    res.json({
      success: true,
      data: {
        hasOnlineStore,
        setupCompleted: latestStore?.setup_completed || false,
        isPublished: latestStore?.is_published || false,
        onlineStores: onlineStores.map(store => ({
          id: store.id,
          username: store.username,
          store_name: store.store_name,
          is_published: store.is_published,
          setup_completed: store.setup_completed
        }))
      }
    });
  } catch (error) {
    console.error('Error checking online store setup:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check online store setup'
    });
  }
}

/**
 * Create or initialize online store
 */
async function setupOnlineStore(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    // Initialize models fresh for this request and pull out what we need
    const {
      OnlineStore,
      Store,
      OnlineStoreLocation
    } = initModels(req.db);

    // Each tenant (free or enterprise) is allowed ONLY ONE online store
    const tenantId = req.user.tenantId;
    const isFreePlan = req.tenant && req.tenant.subscription_plan === 'free';
    let existingStoreForTenant = null;

    if (isFreePlan) {
      // Shared free DB: use raw SQL and tenant_id column that exists only here
      const [rows] = await req.db.query(
        'SELECT id FROM online_stores WHERE tenant_id = ? LIMIT 1',
        { replacements: [tenantId] }
      );
      existingStoreForTenant = rows && rows.length > 0 ? rows[0] : null;
    } else {
      // Enterprise DB: one DB per tenant, so any existing row means tenant already has a store
      existingStoreForTenant = await OnlineStore.findOne();
    }

    if (existingStoreForTenant) {
      return res.status(400).json({
        success: false,
        message: 'You already have an online store. Each business can only have one online store that serves all physical locations.'
      });
    }

    const {
      store_id, // Optional - link to physical store (for enterprise users)
      username,
      store_name,
      store_description
    } = req.body;

    if (!username || !store_name) {
      return res.status(400).json({
        success: false,
        message: 'Username and store_name are required'
      });
    }

    // Check if username is already taken (globally unique)
    const existingStore = await OnlineStore.findOne({
      where: { username }
    });

    if (existingStore) {
      return res.status(409).json({
        success: false,
        message: 'Username already taken. Please choose another.'
      });
    }

    // Validate username format (alphanumeric, hyphens, underscores only)
    if (!/^[a-z0-9_-]+$/.test(username.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain lowercase letters, numbers, hyphens, and underscores'
      });
    }

    // If store_id is provided, verify it exists (for enterprise users)
    if (store_id) {
      const physicalStore = await Store.findByPk(store_id);
      if (!physicalStore) {
        return res.status(404).json({
          success: false,
          message: 'Physical store not found'
        });
      }
    }

    const newStoreData = {
      tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
      username: username.toLowerCase(),
      store_name,
      store_description: store_description || null,
      setup_completed: false,
      is_published: false
    };

    const onlineStore = await OnlineStore.create(newStoreData);

    // If store_id provided, link online store to physical store
    if (store_id) {
      await OnlineStoreLocation.create({
        tenant_id: isFreePlan ? tenantId : null, // Set tenant_id for free users (shared DB)
        online_store_id: onlineStore.id,
        store_id,
        is_default: true
      });
    }

    res.status(201).json({
      success: true,
      message: 'Online store created successfully',
      data: {
        onlineStore: {
          id: onlineStore.id,
          username: onlineStore.username,
          store_name: onlineStore.store_name,
          storefront_link: `${process.env.FRONTEND_URL || 'mycroshop.com'}/${onlineStore.username}`
        }
      }
    });
  } catch (error) {
    console.error('Error setting up online store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to setup online store',
      // Expose error message to help diagnose in your environment
      error: error.message
    });
  }
}

/**
 * Get online store by ID
 */
async function getOnlineStoreById(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);

    const onlineStore = await findTenantOnlineStoreById(req, models, req.params.id, {
      include: [
        {
          model: models.OnlineStoreLocation,
          include: [
            {
              model: models.Store
            }
          ]
        }
      ]
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    const normalizedStore = normalizeOnlineStoreData(req, onlineStore);
    res.json({
      success: true,
      data: { onlineStore: normalizedStore }
    });
  } catch (error) {
    console.error('Error getting online store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get online store'
    });
  }
}

/**
 * Update storefront (Step 1)
 */
async function updateStorefront(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const onlineStore = await findTenantOnlineStoreById(req, models, req.params.id);
    
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    const {
      username,
      store_name,
      store_description
    } = req.body;

    // If username is being changed, check if it's available
    if (username && username.toLowerCase() !== onlineStore.username) {
      const existingStore = await models.OnlineStore.findOne({
        where: { username: username.toLowerCase() }
      });

      if (existingStore) {
        return res.status(409).json({
          success: false,
          message: 'Username already taken'
        });
      }

      // Validate username format
      if (!/^[a-z0-9_-]+$/.test(username.toLowerCase())) {
        return res.status(400).json({
          success: false,
          message: 'Username can only contain lowercase letters, numbers, hyphens, and underscores'
        });
      }
    }

    await onlineStore.update({
      ...(username && { username: username.toLowerCase() }),
      ...(store_name !== undefined && { store_name }),
      ...(store_description !== undefined && { store_description })
    });

    await onlineStore.reload();
    const normalizedStore = normalizeOnlineStoreData(req, onlineStore);
    res.json({
      success: true,
      message: 'Storefront updated successfully',
      data: { onlineStore: normalizedStore }
    });
  } catch (error) {
    console.error('Error updating storefront:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update storefront'
    });
  }
}

/**
 * Update store information (Step 2)
 *
 * social_links is stored as JSON on the OnlineStore model.
 * We now support two shapes:
 *  - Array of objects (preferred):
 *      [{ "platform": "facebook", "url": "https://facebook.com/..." }, ...]
 *  - Legacy object shape (for backward compatibility):
 *      { "facebook": "https://...", "instagram": "https://..." }
 *
 * Allowed platforms (from UI): facebook, instagram, x (twitter), linkedin, tiktok
 */
async function updateStoreInformation(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const onlineStore = await findTenantOnlineStoreById(req, models, req.params.id);
    
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    const {
      social_links,
      country,
      state,
      show_location,
      allow_delivery_datetime,
      is_location_based
    } = req.body;

    // Normalise social_links
    let normalisedSocialLinks;
    if (social_links !== undefined) {
      const allowedPlatforms = ['facebook', 'instagram', 'x', 'twitter', 'linkedin', 'tiktok'];

      if (Array.isArray(social_links)) {
        // Handle different array formats
        if (social_links.length > 0 && social_links[0] && typeof social_links[0] === 'object') {
          // Check if it's the new format: [{ platform: "...", url: "..." }]
          if (social_links[0].platform !== undefined || social_links[0].url !== undefined) {
            // New format: array of { platform, url }
            normalisedSocialLinks = social_links
              .filter(item => item && typeof item === 'object' && item.platform && item.url)
              .map(item => ({
                platform: String(item.platform).toLowerCase(),
                url: String(item.url).trim()
              }))
              .filter(item => allowedPlatforms.includes(item.platform) && item.url.length > 0);
          } else {
            // Array containing objects with platform keys: [{ facebook: "...", instagram: "..." }]
            // Flatten the array and merge all objects, then convert to normalized format
            const mergedObject = social_links.reduce((acc, item) => {
              if (item && typeof item === 'object') {
                return { ...acc, ...item };
              }
              return acc;
            }, {});
            
            normalisedSocialLinks = Object.entries(mergedObject)
              .filter(([platform, url]) => url && String(url).trim().length > 0)
              .map(([platform, url]) => ({
                platform: String(platform).toLowerCase(),
                url: String(url).trim()
              }))
              .filter(item => allowedPlatforms.includes(item.platform));
          }
        } else {
          normalisedSocialLinks = [];
        }
      } else if (social_links && typeof social_links === 'object') {
        // Legacy object shape -> convert to array
        normalisedSocialLinks = Object.entries(social_links)
          .filter(([platform, url]) => url && String(url).trim().length > 0)
          .map(([platform, url]) => ({
            platform: String(platform).toLowerCase(),
            url: String(url).trim()
          }))
          .filter(item => allowedPlatforms.includes(item.platform));
      } else if (social_links !== null) {
        return res.status(400).json({
          success: false,
          message: 'social_links must be an array of { platform, url }, an array of objects with platform keys, or an object with platform keys'
        });
      }
    }

    await onlineStore.update({
      ...(normalisedSocialLinks !== undefined && { social_links: normalisedSocialLinks || [] }),
      ...(country !== undefined && { country }),
      ...(state !== undefined && { state }),
      ...(show_location !== undefined && { show_location }),
      ...(allow_delivery_datetime !== undefined && { allow_delivery_datetime }),
      ...(is_location_based !== undefined && { is_location_based })
    });

    await onlineStore.reload();
    const normalizedStore = normalizeOnlineStoreData(req, onlineStore);
    res.json({
      success: true,
      message: 'Store information updated successfully',
      data: { onlineStore: normalizedStore }
    });
  } catch (error) {
    console.error('Error updating store information:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update store information',
      error: error.message
    });
  }
}

/**
 * Update store appearance (Step 3)
 */
async function updateStoreAppearance(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const onlineStore = await findTenantOnlineStoreById(req, models, req.params.id);
    
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    const {
      background_color,
      button_style,
      button_color,
      button_font_color
    } = req.body;

    await onlineStore.update({
      ...(background_color !== undefined && { background_color }),
      ...(button_style !== undefined && { button_style }),
      ...(button_color !== undefined && { button_color }),
      ...(button_font_color !== undefined && { button_font_color })
    });

    await onlineStore.reload();
    const normalizedStore = normalizeOnlineStoreData(req, onlineStore);
    res.json({
      success: true,
      message: 'Store appearance updated successfully',
      data: { onlineStore: normalizedStore }
    });
  } catch (error) {
    console.error('Error updating store appearance:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update store appearance'
    });
  }
}

/**
 * Helper function to generate full URL from relative path
 */
function getFullUrl(req, relativePath) {
  if (!relativePath) return null;
  const protocol = req.protocol || 'https';
  const host = req.get('host') || 'backend.mycroshop.com';
  // Remove leading slash if present to avoid double slashes
  const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `${protocol}://${host}${cleanPath}`;
}

/**
 * Helper function to normalize onlineStore data for API responses
 * - Parses social_links from string to array if needed
 * - Converts image URLs to full URLs
 */
function normalizeOnlineStoreData(req, onlineStore) {
  if (!onlineStore) return onlineStore;
  
  // Convert Sequelize instance to plain object if needed
  const storeData = onlineStore.toJSON ? onlineStore.toJSON() : onlineStore;
  
  // Parse social_links if it's a string
  if (storeData.social_links) {
    if (typeof storeData.social_links === 'string') {
      try {
        storeData.social_links = JSON.parse(storeData.social_links);
      } catch (e) {
        // If parsing fails, set to empty array
        console.error('Error parsing social_links:', e);
        storeData.social_links = [];
      }
    }
    // Ensure it's an array
    if (!Array.isArray(storeData.social_links)) {
      storeData.social_links = [];
    }
  } else {
    storeData.social_links = [];
  }
  
  // Convert image URLs to full URLs
  if (storeData.profile_logo_url) {
    storeData.profile_logo_url = getFullUrl(req, storeData.profile_logo_url);
  }
  if (storeData.banner_image_url) {
    storeData.banner_image_url = getFullUrl(req, storeData.banner_image_url);
  }
  if (storeData.background_image_url) {
    storeData.background_image_url = getFullUrl(req, storeData.background_image_url);
  }
  
  return storeData;
}

/**
 * Upload store image (logo, banner, background)
 * Supports multiple uploads at once or single upload with image_type
 */
async function uploadStoreImage(req, res) {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.message
      });
    }

    try {
      if (!req.db) {
        return res.status(500).json({
          success: false,
          message: 'Database connection not available'
        });
      }

      const models = initModels(req.db);
      const onlineStore = await findTenantOnlineStoreById(req, models, req.params.id);
      
      if (!onlineStore) {
        // Delete uploaded files if store not found
        if (req.files) {
          Object.values(req.files).flat().forEach(file => {
            if (fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
          });
        }
        return res.status(404).json({
          success: false,
          message: 'Online store not found'
        });
      }

      const files = req.files || {};
      const { image_type } = req.body;
      
      // Support new format: multiple files with field names (logo, banner, background)
      if (files.logo || files.banner || files.background) {
        const updates = {};
        const uploadedImages = {};
        
        // Process logo
        if (files.logo && files.logo[0]) {
          const oldImagePath = onlineStore.profile_logo_url 
            ? path.join(__dirname, '../', onlineStore.profile_logo_url) 
            : null;
          if (oldImagePath && fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
          const relativeLogoUrl = `/uploads/stores/${files.logo[0].filename}`;
          updates.profile_logo_url = relativeLogoUrl;
          uploadedImages.logo = getFullUrl(req, relativeLogoUrl);
        }
        
        // Process banner
        if (files.banner && files.banner[0]) {
          const oldImagePath = onlineStore.banner_image_url 
            ? path.join(__dirname, '../', onlineStore.banner_image_url) 
            : null;
          if (oldImagePath && fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
          const relativeBannerUrl = `/uploads/stores/${files.banner[0].filename}`;
          updates.banner_image_url = relativeBannerUrl;
          uploadedImages.banner = getFullUrl(req, relativeBannerUrl);
        }
        
        // Process background
        if (files.background && files.background[0]) {
          const oldImagePath = onlineStore.background_image_url 
            ? path.join(__dirname, '../', onlineStore.background_image_url) 
            : null;
          if (oldImagePath && fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
          const relativeBackgroundUrl = `/uploads/stores/${files.background[0].filename}`;
          updates.background_image_url = relativeBackgroundUrl;
          uploadedImages.background = getFullUrl(req, relativeBackgroundUrl);
        }
        
        if (Object.keys(updates).length === 0) {
          return res.status(400).json({
            success: false,
            message: 'No valid files uploaded'
          });
        }
        
        await onlineStore.update(updates);
        
        // Refresh the onlineStore to get updated values
        await onlineStore.reload();
        
        // Normalize the onlineStore data (parses social_links, converts URLs)
        const normalizedStore = normalizeOnlineStoreData(req, onlineStore);
        
        const uploadedCount = Object.keys(uploadedImages).length;
        const uploadedTypes = Object.keys(uploadedImages).join(', ');
        
        res.json({
          success: true,
          message: `${uploadedCount} image(s) uploaded successfully: ${uploadedTypes}`,
          data: {
            uploaded_images: uploadedImages,
            onlineStore: normalizedStore
          }
        });
      }
      // Support legacy format: single file with image_type field
      else if (files.image && files.image[0]) {
        if (!image_type || !['logo', 'banner', 'background'].includes(image_type)) {
          fs.unlinkSync(files.image[0].path);
          return res.status(400).json({
            success: false,
            message: 'image_type must be one of: logo, banner, background'
          });
        }

        // Delete old image if exists
        const oldImageField = image_type === 'logo' ? 'profile_logo_url' : 
                             image_type === 'banner' ? 'banner_image_url' : 
                             'background_image_url';
        
        if (onlineStore[oldImageField]) {
          const oldImagePath = path.join(__dirname, '../', onlineStore[oldImageField]);
          if (fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
        }

        // Update with new image URL
        const relativeImageUrl = `/uploads/stores/${files.image[0].filename}`;
        await onlineStore.update({
          [oldImageField]: relativeImageUrl
        });

        // Refresh the onlineStore to get updated values
        await onlineStore.reload();
        
        // Normalize the onlineStore data (parses social_links, converts URLs)
        const normalizedStore = normalizeOnlineStoreData(req, onlineStore);

        res.json({
          success: true,
          message: `${image_type} uploaded successfully`,
          data: {
            image_url: getFullUrl(req, relativeImageUrl),
            onlineStore: normalizedStore
          }
        });
      }
      else {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded. Please upload logo, banner, background, or image file.'
        });
      }
    } catch (error) {
      // Delete uploaded files on error
      if (req.files) {
        Object.values(req.files).flat().forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
      console.error('Error uploading store image:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to upload store image',
        error: error.message
      });
    }
  });
}

/**
 * Publish or unpublish online store
 */
async function publishOnlineStore(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const onlineStore = await findTenantOnlineStoreById(req, models, req.params.id);
    
    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    const { is_published } = req.body;

    if (is_published === undefined) {
      return res.status(400).json({
        success: false,
        message: 'is_published is required'
      });
    }

    // If publishing, mark setup as completed
    if (is_published && !onlineStore.setup_completed) {
      await onlineStore.update({
        is_published: true,
        setup_completed: true
      });
    } else {
      await onlineStore.update({
        is_published
      });
    }

    await onlineStore.reload();
    const normalizedStore = normalizeOnlineStoreData(req, onlineStore);
    res.json({
      success: true,
      message: is_published ? 'Store published successfully' : 'Store unpublished successfully',
      data: { onlineStore: normalizedStore }
    });
  } catch (error) {
    console.error('Error publishing online store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to publish online store'
    });
  }
}

/**
 * Get public store preview by username
 * Public route - no authentication required
 * Requires tenant_id as query parameter OR will try to look it up from username
 */
async function getPublicStorePreview(req, res) {
  try {
    const { username } = req.params;
    let { tenant_id } = req.query;

    const { getTenantConnection } = require('../config/database');
    const { getTenantById } = require('../config/tenant');
    const initModels = require('../models');

    // If tenant_id not provided, try to look it up from username in shared database
    if (!tenant_id) {
      try {
        const { getSharedFreeDatabase } = require('../config/database');
        const sharedDb = await getSharedFreeDatabase();
        const sharedModels = initModels(sharedDb);
        
        const onlineStoreInShared = await sharedModels.OnlineStore.findOne({
          where: { username: username.toLowerCase() },
          attributes: ['tenant_id']
        });

        if (onlineStoreInShared && onlineStoreInShared.tenant_id) {
          tenant_id = onlineStoreInShared.tenant_id;
        }
      } catch (lookupError) {
        console.warn('Could not look up tenant_id from username:', lookupError.message);
      }
    }

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id is required. Please provide it as a query parameter: ?tenant_id=123'
      });
    }

    // Get tenant database connection
    const tenant = await getTenantById(tenant_id);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    const sequelize = await getTenantConnection(tenant_id, tenant.subscription_plan || 'enterprise');
    const models = initModels(sequelize);

    const onlineStore = await models.OnlineStore.findOne({
      where: { username: username.toLowerCase(), is_published: true },
      include: [
        {
          model: models.StoreCollection,
          where: { is_visible: true },
          required: false,
          include: [
            {
              model: models.StoreCollectionProduct,
              include: [
                {
                  model: models.Product,
                  where: { is_active: true },
                  required: false
                }
              ],
              order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
            },
            {
              model: models.StoreCollectionService,
              include: [
                {
                  model: models.StoreService,
                  where: { is_active: true },
                  required: false
                }
              ],
              order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
            }
          ],
          order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
        },
        {
          model: models.OnlineStoreLocation,
          include: [{ 
            model: models.Store, 
            attributes: ['id', 'name', 'address', 'city', 'state', 'country'] 
          }]
        }
      ]
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Store not found or not published'
      });
    }

    // Normalize store data (similar to publicStoreController)
    const storeData = onlineStore.toJSON();
    
    // Normalize URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    if (storeData.profile_logo_url) storeData.profile_logo_url = getFullUrl(storeData.profile_logo_url);
    if (storeData.banner_image_url) storeData.banner_image_url = getFullUrl(storeData.banner_image_url);
    if (storeData.background_image_url) storeData.background_image_url = getFullUrl(storeData.background_image_url);

    // Normalize product/service images within collections
    if (storeData.StoreCollections) {
      storeData.StoreCollections.forEach(collection => {
        if (collection.StoreCollectionProducts) {
          collection.StoreCollectionProducts.forEach(cp => {
            if (cp.Product && cp.Product.image_url) {
              cp.Product.image_url = getFullUrl(cp.Product.image_url);
            }
          });
        }
        if (collection.StoreCollectionServices) {
          collection.StoreCollectionServices.forEach(cs => {
            if (cs.StoreService && cs.StoreService.service_image_url) {
              cs.StoreService.service_image_url = getFullUrl(cs.StoreService.service_image_url);
            }
          });
        }
      });
    }

    res.json({
      success: true,
      data: { onlineStore: storeData }
    });
  } catch (error) {
    console.error('Error getting public store preview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store preview',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Create product directly for online store (for free users)
 * Product is automatically published to the online store
 */
async function createOnlineStoreProduct(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { id: online_store_id } = req.params;
    const {
      name,
      sku,
      description,
      price,
      stock,
      category,
      image_url,
      is_published = true, // Auto-publish for free users
      featured = false,
      sort_order,
      variations // Array of variation objects: [{variation_name, variation_type, is_required, options: [{value, display_name, price_adjustment, stock, sku, barcode, image_url, is_default}]}]
    } = req.body;

    // Free users should not have access to advanced inventory management fields:
    // - barcode (inventory tracking)
    // - cost (cost price tracking)
    // - low_stock_threshold (inventory alerts)
    // - expiry_date (inventory expiration tracking)
    // - batch_number (batch/inventory tracking)
    // - unit_of_measure (advanced inventory unit management)
    
    // Remove these fields if they're provided (free users don't have access)
    const { barcode, cost, low_stock_threshold, expiry_date, batch_number, unit_of_measure } = req.body;
    if (barcode || cost !== undefined || low_stock_threshold !== undefined || expiry_date || batch_number || unit_of_measure) {
      return res.status(400).json({
        success: false,
        message: 'Free users do not have access to advanced inventory fields. Fields not available: barcode, cost, low_stock_threshold, expiry_date, batch_number, unit_of_measure'
      });
    }

    // Verify online store belongs to current tenant
    const onlineStore = await findTenantOnlineStoreById(req, models, online_store_id);
    if (!onlineStore) {
      return res.status(403).json({
        success: false,
        message: 'Online store not found or access denied'
      });
    }

    // Get tenant to check subscription plan
    const tenantId = req.user?.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // For free users only - enterprise users should use inventory endpoint
    if (!isFreePlan) {
      return res.status(400).json({
        success: false,
        message: 'This endpoint is for free users only. Enterprise users should use POST /api/v1/inventory to create products, then publish them.'
      });
    }

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Product name is required'
      });
    }

    // Import QueryTypes at the top of the function (before it's used)
    const { QueryTypes } = require('sequelize');

    // Helper function to clean up uploaded files
    const cleanupFiles = () => {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      if (req.files) {
        const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
        files.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
    };

    // Helper function to get full URL
    const getFullUrl = (req, relativePath) => {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    };

    // Parse variations early (from form-data string or array)
    let parsedVariations = [];
    if (variations) {
      if (typeof variations === 'string') {
        try {
          parsedVariations = JSON.parse(variations);
          // Ensure it's an array after parsing
          if (!Array.isArray(parsedVariations)) {
            parsedVariations = [];
          }
        } catch (parseError) {
          console.error('Error parsing variations JSON:', parseError);
          cleanupFiles();
          return res.status(400).json({
            success: false,
            message: 'Invalid variations JSON format. Please ensure variations is a valid JSON array.',
            error: parseError.message
          });
        }
      } else if (Array.isArray(variations)) {
        parsedVariations = variations;
      }
    }

    // Check if variations have options
    const hasVariationOptions = Array.isArray(parsedVariations) && parsedVariations.length > 0 &&
      parsedVariations.some(v => v.options && Array.isArray(v.options) && v.options.length > 0);

    // VALIDATION 1: If no variations, price and stock are REQUIRED
    if (!hasVariationOptions) {
      if (price === undefined || price === null || price === '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Price is required when product has no variations',
          suggestion: 'Provide a price field in your request, or add variations with price in each option.'
        });
      }
      if (stock === undefined || stock === null || stock === '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Stock is required when product has no variations',
          suggestion: 'Provide a stock field in your request, or add variations with stock in each option.'
        });
      }
    }

    // VALIDATION 2: If variations exist, price and stock must NOT be provided (must be null)
    if (hasVariationOptions) {
      if (stock !== undefined && stock !== null && stock !== '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Products with variations cannot have primary stock. Each variation option manages its own stock level.',
          suggestion: 'Remove the "stock" parameter from your request. Stock should only be specified in the variation options (e.g., options[0].stock).'
        });
      }
      if (price !== undefined && price !== null && price !== '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Products with variations cannot have primary price. Each variation option manages its own price level.',
          suggestion: 'Remove the "price" parameter from your request. Price should only be specified in the variation options (e.g., options[0].price).'
        });
      }
    }

    // Handle product image: prioritize uploaded file over image_url
    let finalImageUrl = image_url || null;
    
    // Check for product_image in req.files (when using .any()) or req.file (when using .single())
    if (req.files && Array.isArray(req.files)) {
      const productImageFile = req.files.find(file => file.fieldname === 'product_image');
      if (productImageFile) {
        finalImageUrl = `/uploads/products/${productImageFile.filename}`;
      }
    } else if (req.file && req.file.fieldname === 'product_image') {
      // Fallback for .single() multer
      finalImageUrl = `/uploads/products/${req.file.filename}`;
    } else if (req.files && !Array.isArray(req.files)) {
      // Handle case where req.files is an object (from .fields())
      const files = Object.values(req.files).flat();
      const productImageFile = files.find(file => file.fieldname === 'product_image');
      if (productImageFile) {
        finalImageUrl = `/uploads/products/${productImageFile.filename}`;
      }
    }

    // VALIDATION 3: Main product must have image (URL or file upload)
    if (!finalImageUrl) {
      cleanupFiles();
      return res.status(400).json({
        success: false,
        message: 'Product image is required. Please provide either an image_url or upload a product_image file.',
        suggestion: 'Either add "image_url" field with a URL, or upload a file using the "product_image" field name.'
      });
    }

    // Determine final stock and price values: null if variations exist (they manage their own values)
    let finalStock = null;
    let finalPrice = null;
    if (hasVariationOptions) {
      finalStock = null; // Variations manage their own stock
      finalPrice = null; // Variations manage their own price
    } else {
      // No variations or no options, use provided values (required)
      finalStock = stock !== undefined && stock !== null ? parseInt(stock) : 0;
      finalPrice = price !== undefined && price !== null ? parseFloat(price) : 0;
    }

    // Create product using raw SQL INSERT to have full control over columns
    // Free users' products table only has: tenant_id, name, sku, description, price, stock, category, image_url, is_active, created_at, updated_at
    // Columns NOT available for free users: store_id, barcode, cost_price, low_stock_threshold, expiry_date, batch_number, unit_of_measure
    await req.db.query(
      `INSERT INTO products (tenant_id, name, sku, description, price, stock, category, image_url, is_active, created_at, updated_at) 
       VALUES (:tenantId, :name, :sku, :description, :price, :stock, :category, :imageUrl, :isActive, NOW(), NOW())`,
      {
        replacements: {
          tenantId: tenantId,
          name: name,
          sku: sku || null,
          description: description || null,
          price: finalPrice,
          stock: finalStock,
          category: category || null,
          imageUrl: finalImageUrl,
          isActive: true
        },
        type: QueryTypes.INSERT
      }
    );
    
    // Get the inserted ID using LAST_INSERT_ID() for MySQL
    const idResults = await req.db.query(
      `SELECT LAST_INSERT_ID() as id`,
      {
        type: QueryTypes.SELECT
      }
    );
    
    const productId = idResults && idResults.length > 0 && idResults[0].id ? idResults[0].id : null;
    
    if (!productId) {
      cleanupFiles();
      return res.status(500).json({
        success: false,
        message: 'Failed to create product: Could not retrieve product ID',
        error: 'Product insert succeeded but ID could not be extracted'
      });
    }

    // Automatically create StoreProduct record (publish to online store)
    // Get max sort_order if not provided
    let finalSortOrder = sort_order;
    
    if (finalSortOrder === undefined || finalSortOrder === null) {
      // Use raw query to avoid model field issues (seo_title, etc.)
      const [maxResult] = await req.db.query(
        `SELECT MAX(sort_order) as max_sort_order FROM store_products`,
        {
          type: QueryTypes.SELECT
        }
      );
      const maxSortOrder = maxResult && maxResult.max_sort_order !== null ? maxResult.max_sort_order : 0;
      finalSortOrder = (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) 
        ? 1 
        : (parseInt(maxSortOrder) || 0) + 1;
    } else {
      finalSortOrder = parseInt(finalSortOrder) || 1;
      // Smart sort order rearrangement - use raw query to avoid model field issues
      const existingProductsToShift = await req.db.query(
        `SELECT id, sort_order FROM store_products WHERE sort_order >= :sortOrder ORDER BY sort_order DESC`,
        {
          replacements: { sortOrder: finalSortOrder },
          type: QueryTypes.SELECT
        }
      );

      if (existingProductsToShift && existingProductsToShift.length > 0) {
        for (const existingProduct of existingProductsToShift) {
          await req.db.query(
            `UPDATE store_products SET sort_order = :newSortOrder WHERE id = :id`,
            {
              replacements: { 
                newSortOrder: (parseInt(existingProduct.sort_order) || 0) + 1,
                id: existingProduct.id
              },
              type: QueryTypes.UPDATE
            }
          );
        }
      }
    }

    // Use raw query to insert StoreProduct to avoid model field issues (seo_title, etc.)
    await req.db.query(
      `INSERT INTO store_products (tenant_id, product_id, is_published, featured, sort_order, created_at, updated_at) 
       VALUES (:tenantId, :productId, :isPublished, :featured, :sortOrder, NOW(), NOW())`,
      {
        replacements: {
          tenantId: tenantId,
          productId: productId,
          isPublished: is_published !== false ? 1 : 0,
          featured: featured || 0,
          sortOrder: finalSortOrder
        },
        type: QueryTypes.INSERT
      }
    );
    
    // Get the inserted ID using LAST_INSERT_ID() for MySQL
    const storeProductIdResults = await req.db.query(
      `SELECT LAST_INSERT_ID() as id`,
      {
        type: QueryTypes.SELECT
      }
    );
    
    const storeProductId = storeProductIdResults && storeProductIdResults.length > 0 && storeProductIdResults[0].id 
      ? storeProductIdResults[0].id 
      : null;
    
    if (!storeProductId) {
      // Cleanup product if StoreProduct creation fails
      await req.db.query(`DELETE FROM products WHERE id = :productId`, {
        replacements: { productId: productId },
        type: QueryTypes.DELETE
      });
      cleanupFiles();
      return res.status(500).json({
        success: false,
        message: 'Failed to create store product: Could not retrieve store product ID'
      });
    }

    // VALIDATION: Only ONE variation type per product allowed (keep it simple!)
    if (Array.isArray(parsedVariations) && parsedVariations.length > 1) {
      cleanupFiles();
      return res.status(400).json({
        success: false,
        message: 'A product can only have ONE variation type. Please choose either Color, Size, Material, etc., but not multiple types together.',
        suggestion: 'If you need multiple variations (e.g., Color + Size), create separate products like "T-Shirt - Red" (with sizes) and "T-Shirt - Blue" (with sizes).'
      });
    }

    // Handle product variations if provided
    if (hasVariationOptions && Array.isArray(parsedVariations) && parsedVariations.length > 0) {
      for (let i = 0; i < parsedVariations.length; i++) {
        const variationData = parsedVariations[i];
        if (!variationData.variation_name || !variationData.variation_type) {
          continue; // Skip invalid variations
        }

        // Validate variation options exist
        if (!variationData.options || !Array.isArray(variationData.options) || variationData.options.length === 0) {
          continue; // Skip variations without options
        }

        // Use raw SQL INSERT for variations to ensure only existing columns are used
        await req.db.query(
          `INSERT INTO product_variations (tenant_id, product_id, variation_name, variation_type, is_required, sort_order, created_at) 
           VALUES (:tenantId, :productId, :variationName, :variationType, :isRequired, :sortOrder, NOW())`,
          {
            replacements: {
              tenantId: tenantId,
              productId: productId,
              variationName: variationData.variation_name,
              variationType: variationData.variation_type || 'other',
              isRequired: variationData.is_required ? 1 : 0,
              sortOrder: variationData.sort_order !== undefined ? parseInt(variationData.sort_order) : i
            },
            type: QueryTypes.INSERT
          }
        );
        
        // Get the inserted ID using LAST_INSERT_ID() for MySQL
        const variationIdResults = await req.db.query(
          `SELECT LAST_INSERT_ID() as id`,
          {
            type: QueryTypes.SELECT
          }
        );
        
        const variationId = variationIdResults && variationIdResults.length > 0 && variationIdResults[0].id 
          ? variationIdResults[0].id 
          : null;
        
        if (!variationId) {
          // Cleanup on error
          await req.db.query(`DELETE FROM products WHERE id = :productId`, {
            replacements: { productId: productId },
            type: QueryTypes.DELETE
          });
          await req.db.query(`DELETE FROM store_products WHERE product_id = :productId`, {
            replacements: { productId: productId },
            type: QueryTypes.DELETE
          });
          cleanupFiles();
          return res.status(500).json({
            success: false,
            message: 'Failed to create product variation: Could not retrieve variation ID'
          });
        }

        // Create variation options
        for (let j = 0; j < variationData.options.length; j++) {
          const optionData = variationData.options[j];
          if (!optionData.value) {
            continue; // Skip invalid options
          }

          // Handle image: prioritize uploaded file over image_url
          let variationImageUrl = optionData.image_url || null;
          const variationImageFieldName = `variation_option_image_${i}_${j}`;
          
          // Check if file was uploaded for this variation option
          if (req.files) {
            // Handle both single file, array of files, and object of file arrays
            let files = [];
            if (Array.isArray(req.files)) {
              files = req.files;
            } else if (typeof req.files === 'object') {
              files = Object.values(req.files).flat();
            }
            
            const uploadedFile = files.find(file => 
              file.fieldname === variationImageFieldName || 
              file.fieldname.startsWith(`variation_option_image_${i}_${j}`)
            );
            
            if (uploadedFile) {
              variationImageUrl = `/uploads/product-variations/${uploadedFile.filename}`;
            }
          }

          // VALIDATION 4: Each variation option must have image (URL or file upload)
          if (!variationImageUrl) {
            // Clean up product and variation created so far using raw queries
            await req.db.query(`DELETE FROM product_variation_options WHERE variation_id = :variationId`, {
              replacements: { variationId: variationId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM product_variations WHERE id = :variationId`, {
              replacements: { variationId: variationId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM store_products WHERE product_id = :productId`, {
              replacements: { productId: productId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM products WHERE id = :productId`, {
              replacements: { productId: productId },
              type: QueryTypes.DELETE
            });
            cleanupFiles();
            return res.status(400).json({
              success: false,
              message: `Variation option "${optionData.value}" (position ${j}) is missing an image. Each variation option must have an image.`,
              suggestion: `Either provide "image_url" in options[${j}] or upload a file using field name "variation_option_image_${i}_${j}".`
            });
          }

          // Validate required fields for variation options
          if (optionData.price === undefined || optionData.price === null || optionData.price === '') {
            await req.db.query(`DELETE FROM product_variation_options WHERE variation_id = :variationId`, {
              replacements: { variationId: variationId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM product_variations WHERE id = :variationId`, {
              replacements: { variationId: variationId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM store_products WHERE product_id = :productId`, {
              replacements: { productId: productId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM products WHERE id = :productId`, {
              replacements: { productId: productId },
              type: QueryTypes.DELETE
            });
            cleanupFiles();
            return res.status(400).json({
              success: false,
              message: `Variation option "${optionData.value}" (position ${j}) is missing price. Each variation option must have a price.`,
              suggestion: `Provide "price" in options[${j}].`
            });
          }

          if (optionData.stock === undefined || optionData.stock === null || optionData.stock === '') {
            await req.db.query(`DELETE FROM product_variation_options WHERE variation_id = :variationId`, {
              replacements: { variationId: variationId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM product_variations WHERE id = :variationId`, {
              replacements: { variationId: variationId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM store_products WHERE product_id = :productId`, {
              replacements: { productId: productId },
              type: QueryTypes.DELETE
            });
            await req.db.query(`DELETE FROM products WHERE id = :productId`, {
              replacements: { productId: productId },
              type: QueryTypes.DELETE
            });
            cleanupFiles();
            return res.status(400).json({
              success: false,
              message: `Variation option "${optionData.value}" (position ${j}) is missing stock. Each variation option must have stock quantity.`,
              suggestion: `Provide "stock" in options[${j}].`
            });
          }

          // Calculate price adjustment from base (which is null, so use 0 as base)
          const optionPrice = parseFloat(optionData.price) || 0;
          const priceAdjustment = optionPrice; // Since base price is null, adjustment equals the price

          // Use raw SQL INSERT for variation options to exclude barcode for free users
          await req.db.query(
            `INSERT INTO product_variation_options (tenant_id, variation_id, option_value, option_display_name, price_adjustment, stock, sku, image_url, is_default, is_available, sort_order, created_at) 
             VALUES (:tenantId, :variationId, :optionValue, :optionDisplayName, :priceAdjustment, :stock, :sku, :imageUrl, :isDefault, :isAvailable, :sortOrder, NOW())`,
            {
              replacements: {
                tenantId: tenantId,
                variationId: variationId,
                optionValue: optionData.value,
                optionDisplayName: optionData.display_name || optionData.value,
                priceAdjustment: priceAdjustment,
                stock: parseInt(optionData.stock) || 0,
                sku: optionData.sku || null,
                imageUrl: variationImageUrl,
                isDefault: optionData.is_default ? 1 : 0,
                isAvailable: optionData.is_available !== false ? 1 : 0,
                sortOrder: optionData.sort_order !== undefined ? parseInt(optionData.sort_order) : j
              },
              type: QueryTypes.INSERT
            }
          );
        }
      }
    }

    // Fetch complete product with variations using raw query (only columns that exist for free users)
    // Free users' products table columns: tenant_id, id, name, sku, description, price, stock, category, image_url, is_active, created_at, updated_at
    // Excluded columns: store_id, barcode, cost/cost_price, low_stock_threshold, expiry_date, batch_number, unit_of_measure
    const productRows = await req.db.query(
      `SELECT id, tenant_id, name, sku, description, price, stock, category, image_url, is_active, created_at, updated_at 
       FROM products WHERE id = :productId`,
      {
        replacements: { productId: productId },
        type: QueryTypes.SELECT
      }
    );
    
    const productDataFromDb = productRows && productRows.length > 0 ? productRows[0] : null;
    
    if (!productDataFromDb) {
      cleanupFiles();
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve created product'
      });
    }

    // Fetch variations using raw queries to avoid model field issues (barcode column doesn't exist for free users)
    const fetchedVariations = await req.db.query(
      `SELECT id, tenant_id, product_id, variation_name, variation_type, is_required, sort_order, created_at 
       FROM product_variations 
       WHERE product_id = :productId 
       ORDER BY sort_order ASC`,
      {
        replacements: { productId: productId },
        type: QueryTypes.SELECT
      }
    );

    // Fetch variation options for each variation (excluding barcode for free users)
    const variationsWithOptions = [];
    if (fetchedVariations && fetchedVariations.length > 0) {
      for (const variation of fetchedVariations) {
        const options = await req.db.query(
          `SELECT id, tenant_id, variation_id, option_value, option_display_name, price_adjustment, stock, sku, image_url, is_default, is_available, sort_order, created_at 
           FROM product_variation_options 
           WHERE variation_id = :variationId 
           ORDER BY sort_order ASC`,
          {
            replacements: { variationId: variation.id },
            type: QueryTypes.SELECT
          }
        );
        variationsWithOptions.push({
          ...variation,
          ProductVariationOptions: options || []
        });
      }
    }

    // Fetch StoreProduct separately using raw query to avoid model field issues (seo_title, seo_description, seo_keywords don't exist in DB)
    const storeProductRows = await req.db.query(
      `SELECT id, tenant_id, product_id, is_published, featured, sort_order, created_at, updated_at 
       FROM store_products 
       WHERE id = :storeProductId`,
      {
        replacements: { storeProductId: storeProductId },
        type: QueryTypes.SELECT
      }
    );

    // Merge product data with variations (using raw query results)
    const productData = {
      ...productDataFromDb,
      ProductVariations: variationsWithOptions || []
    };
    
    // Attach StoreProduct to productData
    if (productData && storeProductRows && storeProductRows.length > 0) {
      productData.StoreProduct = storeProductRows[0];
    }

    // Convert image_url to full URL if it's a relative path
    if (productData && productData.image_url && productData.image_url.startsWith('/uploads/')) {
      productData.image_url = getFullUrl(req, productData.image_url);
    }

    // Convert variation option image URLs to full URLs
    if (productData.ProductVariations) {
      productData.ProductVariations = productData.ProductVariations.map(variation => {
        if (variation.ProductVariationOptions) {
          variation.ProductVariationOptions = variation.ProductVariationOptions.map(option => {
            if (option.image_url && option.image_url.startsWith('/uploads/')) {
              option.image_url = getFullUrl(req, option.image_url);
            }
            return option;
          });
        }
        return variation;
      });
    }

    res.status(201).json({
      success: true,
      message: 'Product created and published to online store successfully',
      data: {
        product: productData
      }
    });
  } catch (error) {
    // Delete uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error creating online store product:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        success: false,
        message: 'SKU or barcode already exists'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to create product for online store',
      error: error.message
    });
  }
}

/**
 * Update product for online store (free users only)
 * PUT /api/v1/online-stores/:id/products/:product_id
 */
async function updateOnlineStoreProduct(req, res) {
  try {
    const { QueryTypes } = require('sequelize');
    const { id: online_store_id, product_id } = req.params;
    const { name, sku, description, price, stock, category, image_url, is_active, variations, featured, sort_order } = req.body;
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Get tenant to check subscription plan
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // Verify online store ownership
    const onlineStoreRows = await req.db.query(
      `SELECT id, tenant_id FROM online_stores WHERE id = :onlineStoreId AND tenant_id = :tenantId`,
      {
        replacements: { onlineStoreId: online_store_id, tenantId: tenantId },
        type: QueryTypes.SELECT
      }
    );

    if (!onlineStoreRows || onlineStoreRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found or access denied'
      });
    }

    // Check if product exists and is linked to this online store
    const productRows = await req.db.query(
      `SELECT p.id, p.tenant_id, p.name, p.image_url 
       FROM products p
       INNER JOIN store_products sp ON sp.product_id = p.id
       WHERE p.id = :productId AND p.tenant_id = :tenantId`,
      {
        replacements: { productId: product_id, tenantId: tenantId },
        type: QueryTypes.SELECT
      }
    );

    if (!productRows || productRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or access denied'
      });
    }

    const existingProduct = productRows[0];

    // Helper function to cleanup uploaded files
    const cleanupFiles = () => {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      if (req.files) {
        const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
        files.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
    };

    // Helper function to get full URL
    const getFullUrl = (req, relativePath) => {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    };

    // Parse variations early (from form-data string or array)
    let parsedVariations = [];
    if (variations !== undefined) {
      if (variations) {
        if (typeof variations === 'string') {
          try {
            parsedVariations = JSON.parse(variations);
            if (!Array.isArray(parsedVariations)) {
              parsedVariations = [];
            }
          } catch (parseError) {
            cleanupFiles();
            return res.status(400).json({
              success: false,
              message: 'Invalid variations JSON format',
              error: parseError.message
            });
          }
        } else if (Array.isArray(variations)) {
          parsedVariations = variations;
        }
      }
    }

    // Check if variations have options
    const hasVariationOptions = Array.isArray(parsedVariations) && parsedVariations.length > 0 &&
      parsedVariations.some(v => v.options && Array.isArray(v.options) && v.options.length > 0);

    // VALIDATION 1: If no variations, price and stock are REQUIRED (unless not being updated)
    if (!hasVariationOptions && variations === undefined) {
      // Not updating variations, so price/stock validation only if explicitly provided
      // This allows partial updates
    } else if (!hasVariationOptions && variations !== undefined) {
      // Variations explicitly set to empty/null, so price and stock must be provided
      if (price === undefined || price === null || price === '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Price is required when product has no variations'
        });
      }
      if (stock === undefined || stock === null || stock === '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Stock is required when product has no variations'
        });
      }
    }

    // VALIDATION 2: If variations exist, price and stock must NOT be provided (must be null)
    if (hasVariationOptions) {
      if (stock !== undefined && stock !== null && stock !== '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Products with variations cannot have primary stock'
        });
      }
      if (price !== undefined && price !== null && price !== '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Products with variations cannot have primary price'
        });
      }
    }

    // Handle product image: prioritize uploaded file over image_url
    let finalImageUrl = image_url !== undefined ? image_url : existingProduct.image_url;
    
    if (req.files && Array.isArray(req.files)) {
      const productImageFile = req.files.find(file => file.fieldname === 'product_image');
      if (productImageFile) {
        finalImageUrl = `/uploads/products/${productImageFile.filename}`;
        // Delete old image if exists
        if (existingProduct.image_url && existingProduct.image_url.startsWith('/uploads/products/')) {
          const oldImagePath = path.join(__dirname, '..', existingProduct.image_url);
          if (fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
        }
      }
    } else if (req.file && req.file.fieldname === 'product_image') {
      finalImageUrl = `/uploads/products/${req.file.filename}`;
      // Delete old image if exists
      if (existingProduct.image_url && existingProduct.image_url.startsWith('/uploads/products/')) {
        const oldImagePath = path.join(__dirname, '..', existingProduct.image_url);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
    }

    // VALIDATION 3: Main product must have image (URL or file upload) if being updated
    if (image_url !== undefined || req.file || (req.files && req.files.length > 0)) {
      if (!finalImageUrl) {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Product image is required'
        });
      }
    }

    // Determine final stock and price values
    let finalStock = stock !== undefined ? stock : null;
    let finalPrice = price !== undefined ? price : null;
    
    if (hasVariationOptions) {
      finalStock = null;
      finalPrice = null;
    } else if (variations === undefined) {
      // Not updating variations, keep existing values if not provided
      if (stock === undefined) {
        const existingProductData = await req.db.query(
          `SELECT stock, price FROM products WHERE id = :productId`,
          {
            replacements: { productId: product_id },
            type: QueryTypes.SELECT
          }
        );
        if (existingProductData && existingProductData.length > 0) {
          finalStock = existingProductData[0].stock;
          finalPrice = existingProductData[0].price;
        }
      }
    }

    // Build update query dynamically
    const updateFields = [];
    const updateReplacements = { productId: product_id };

    if (name !== undefined) {
      updateFields.push('name = :name');
      updateReplacements.name = name;
    }
    if (sku !== undefined) {
      updateFields.push('sku = :sku');
      updateReplacements.sku = sku || null;
    }
    if (description !== undefined) {
      updateFields.push('description = :description');
      updateReplacements.description = description || null;
    }
    if (price !== undefined || hasVariationOptions) {
      updateFields.push('price = :price');
      updateReplacements.price = finalPrice;
    }
    if (stock !== undefined || hasVariationOptions) {
      updateFields.push('stock = :stock');
      updateReplacements.stock = finalStock;
    }
    if (category !== undefined) {
      updateFields.push('category = :category');
      updateReplacements.category = category || null;
    }
    if (finalImageUrl !== undefined) {
      updateFields.push('image_url = :imageUrl');
      updateReplacements.imageUrl = finalImageUrl;
    }
    if (is_active !== undefined) {
      updateFields.push('is_active = :isActive');
      updateReplacements.isActive = is_active !== false ? 1 : 0;
    }
    updateFields.push('updated_at = NOW()');

    if (updateFields.length > 1) { // More than just updated_at
      await req.db.query(
        `UPDATE products SET ${updateFields.join(', ')} WHERE id = :productId`,
        {
          replacements: updateReplacements,
          type: QueryTypes.UPDATE
        }
      );
    }

    // Handle variations update if provided
    if (variations !== undefined) {
      // Delete existing variations (cascade will delete options)
      await req.db.query(
        `DELETE FROM product_variations WHERE product_id = :productId`,
        {
          replacements: { productId: product_id },
          type: QueryTypes.DELETE
        }
      );

      // Create new variations if provided
      if (hasVariationOptions && Array.isArray(parsedVariations) && parsedVariations.length > 0) {
        // VALIDATION: Only ONE variation type per product
        if (parsedVariations.length > 1) {
          cleanupFiles();
          return res.status(400).json({
            success: false,
            message: 'A product can only have ONE variation type'
          });
        }

        for (let i = 0; i < parsedVariations.length; i++) {
          const variationData = parsedVariations[i];
          if (!variationData.variation_name || !variationData.variation_type) {
            continue;
          }

          if (!variationData.options || !Array.isArray(variationData.options) || variationData.options.length === 0) {
            continue;
          }

          // Create variation
          await req.db.query(
            `INSERT INTO product_variations (tenant_id, product_id, variation_name, variation_type, is_required, sort_order, created_at) 
             VALUES (:tenantId, :productId, :variationName, :variationType, :isRequired, :sortOrder, NOW())`,
            {
              replacements: {
                tenantId: tenantId,
                productId: product_id,
                variationName: variationData.variation_name,
                variationType: variationData.variation_type || 'other',
                isRequired: variationData.is_required ? 1 : 0,
                sortOrder: variationData.sort_order !== undefined ? parseInt(variationData.sort_order) : i
              },
              type: QueryTypes.INSERT
            }
          );

          const variationIdResults = await req.db.query(
            `SELECT LAST_INSERT_ID() as id`,
            { type: QueryTypes.SELECT }
          );
          const variationId = variationIdResults && variationIdResults.length > 0 && variationIdResults[0].id ? variationIdResults[0].id : null;

          if (!variationId) {
            cleanupFiles();
            return res.status(500).json({
              success: false,
              message: 'Failed to create product variation'
            });
          }

          // Create variation options
          for (let j = 0; j < variationData.options.length; j++) {
            const optionData = variationData.options[j];
            if (!optionData.value) {
              continue;
            }

            // Handle image: prioritize uploaded file over image_url
            let variationImageUrl = optionData.image_url || null;
            const variationImageFieldName = `variation_option_image_${i}_${j}`;
            
            if (req.files) {
              let files = [];
              if (Array.isArray(req.files)) {
                files = req.files;
              } else if (typeof req.files === 'object') {
                files = Object.values(req.files).flat();
              }
              
              const uploadedFile = files.find(file => 
                file.fieldname === variationImageFieldName || 
                file.fieldname.startsWith(`variation_option_image_${i}_${j}`)
              );
              
              if (uploadedFile) {
                variationImageUrl = `/uploads/product-variations/${uploadedFile.filename}`;
              }
            }

            // VALIDATION: Each variation option must have image
            if (!variationImageUrl) {
              cleanupFiles();
              return res.status(400).json({
                success: false,
                message: `Variation option "${optionData.value}" is missing an image`
              });
            }

            // Validate required fields
            if (optionData.price === undefined || optionData.price === null || optionData.price === '') {
              cleanupFiles();
              return res.status(400).json({
                success: false,
                message: `Variation option "${optionData.value}" is missing price`
              });
            }

            if (optionData.stock === undefined || optionData.stock === null || optionData.stock === '') {
              cleanupFiles();
              return res.status(400).json({
                success: false,
                message: `Variation option "${optionData.value}" is missing stock`
              });
            }

            const optionPrice = parseFloat(optionData.price) || 0;
            const priceAdjustment = optionPrice; // Since base price is null, adjustment equals the price

            await req.db.query(
              `INSERT INTO product_variation_options (tenant_id, variation_id, option_value, option_display_name, price_adjustment, stock, sku, image_url, is_default, is_available, sort_order, created_at) 
               VALUES (:tenantId, :variationId, :optionValue, :optionDisplayName, :priceAdjustment, :stock, :sku, :imageUrl, :isDefault, :isAvailable, :sortOrder, NOW())`,
              {
                replacements: {
                  tenantId: tenantId,
                  variationId: variationId,
                  optionValue: optionData.value,
                  optionDisplayName: optionData.display_name || optionData.value,
                  priceAdjustment: priceAdjustment,
                  stock: parseInt(optionData.stock) || 0,
                  sku: optionData.sku || null,
                  imageUrl: variationImageUrl,
                  isDefault: optionData.is_default ? 1 : 0,
                  isAvailable: optionData.is_available !== false ? 1 : 0,
                  sortOrder: optionData.sort_order !== undefined ? parseInt(optionData.sort_order) : j
                },
                type: QueryTypes.INSERT
              }
            );
          }
        }
      }
    }

    // Update StoreProduct if featured or sort_order is provided
    if (featured !== undefined || sort_order !== undefined) {
      const storeProductRows = await req.db.query(
        `SELECT id, sort_order FROM store_products WHERE product_id = :productId`,
        {
          replacements: { productId: product_id },
          type: QueryTypes.SELECT
        }
      );

      if (storeProductRows && storeProductRows.length > 0) {
        const storeProductId = storeProductRows[0].id;
        const oldSortOrder = storeProductRows[0].sort_order;

        // Handle smart sort order rearrangement
        if (sort_order !== undefined) {
          const newSortOrder = parseInt(sort_order) || 1;
          
          if (oldSortOrder !== newSortOrder) {
            // Shift existing products
            const existingProductsToShift = await req.db.query(
              `SELECT id, sort_order FROM store_products 
               WHERE id != :storeProductId AND sort_order >= :sortOrder 
               ORDER BY sort_order DESC`,
              {
                replacements: { storeProductId: storeProductId, sortOrder: newSortOrder },
                type: QueryTypes.SELECT
              }
            );

            if (existingProductsToShift && existingProductsToShift.length > 0) {
              for (const existingProduct of existingProductsToShift) {
                await req.db.query(
                  `UPDATE store_products SET sort_order = :newSortOrder WHERE id = :id`,
                  {
                    replacements: { 
                      newSortOrder: (parseInt(existingProduct.sort_order) || 0) + 1,
                      id: existingProduct.id
                    },
                    type: QueryTypes.UPDATE
                  }
                );
              }
            }
          }

          // Update StoreProduct
          const storeProductUpdateFields = [];
          const storeProductReplacements = { storeProductId: storeProductId };

          if (featured !== undefined) {
            storeProductUpdateFields.push('featured = :featured');
            storeProductReplacements.featured = featured ? 1 : 0;
          }
          if (sort_order !== undefined) {
            storeProductUpdateFields.push('sort_order = :sortOrder');
            storeProductReplacements.sortOrder = newSortOrder;
          }
          storeProductUpdateFields.push('updated_at = NOW()');

          if (storeProductUpdateFields.length > 1) {
            await req.db.query(
              `UPDATE store_products SET ${storeProductUpdateFields.join(', ')} WHERE id = :storeProductId`,
              {
                replacements: storeProductReplacements,
                type: QueryTypes.UPDATE
              }
            );
          }
        } else if (featured !== undefined) {
          await req.db.query(
            `UPDATE store_products SET featured = :featured, updated_at = NOW() WHERE id = :storeProductId`,
            {
              replacements: { storeProductId: storeProductId, featured: featured ? 1 : 0 },
              type: QueryTypes.UPDATE
            }
          );
        }
      }
    }

    // Fetch updated product with variations
    const updatedProductRows = await req.db.query(
      `SELECT id, tenant_id, name, sku, description, price, stock, category, image_url, is_active, created_at, updated_at 
       FROM products WHERE id = :productId`,
      {
        replacements: { productId: product_id },
        type: QueryTypes.SELECT
      }
    );

    const productDataFromDb = updatedProductRows && updatedProductRows.length > 0 ? updatedProductRows[0] : null;

    if (!productDataFromDb) {
      cleanupFiles();
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve updated product'
      });
    }

    // Fetch variations
    const fetchedVariations = await req.db.query(
      `SELECT id, tenant_id, product_id, variation_name, variation_type, is_required, sort_order, created_at 
       FROM product_variations 
       WHERE product_id = :productId 
       ORDER BY sort_order ASC`,
      {
        replacements: { productId: product_id },
        type: QueryTypes.SELECT
      }
    );

    const variationsWithOptions = [];
    if (fetchedVariations && fetchedVariations.length > 0) {
      for (const variation of fetchedVariations) {
        const options = await req.db.query(
          `SELECT id, tenant_id, variation_id, option_value, option_display_name, price_adjustment, stock, sku, image_url, is_default, is_available, sort_order, created_at 
           FROM product_variation_options 
           WHERE variation_id = :variationId 
           ORDER BY sort_order ASC`,
          {
            replacements: { variationId: variation.id },
            type: QueryTypes.SELECT
          }
        );
        variationsWithOptions.push({
          ...variation,
          ProductVariationOptions: options || []
        });
      }
    }

    // Fetch StoreProduct
    const storeProductRows = await req.db.query(
      `SELECT id, tenant_id, product_id, is_published, featured, sort_order, created_at, updated_at 
       FROM store_products 
       WHERE product_id = :productId`,
      {
        replacements: { productId: product_id },
        type: QueryTypes.SELECT
      }
    );

    const productData = {
      ...productDataFromDb,
      ProductVariations: variationsWithOptions || []
    };

    if (storeProductRows && storeProductRows.length > 0) {
      productData.StoreProduct = storeProductRows[0];
    }

    // Convert image_url to full URL
    if (productData && productData.image_url && productData.image_url.startsWith('/uploads/')) {
      productData.image_url = getFullUrl(req, productData.image_url);
    }

    // Convert variation option image URLs to full URLs
    if (productData.ProductVariations) {
      productData.ProductVariations = productData.ProductVariations.map(variation => {
        if (variation.ProductVariationOptions) {
          variation.ProductVariationOptions = variation.ProductVariationOptions.map(option => {
            if (option.image_url && option.image_url.startsWith('/uploads/')) {
              option.image_url = getFullUrl(req, option.image_url);
            }
            return option;
          });
        }
        return variation;
      });
    }

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: {
        product: productData
      }
    });
  } catch (error) {
    // Cleanup files on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    if (req.files) {
      const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
      files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }
    console.error('Error updating online store product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product',
      error: error.message
    });
  }
}

/**
 * Remove/Delete product from online store (free users only)
 * DELETE /api/v1/online-stores/:id/products/:product_id
 * Query params: ?unpublish_only=true (optional - if true, only unpublishes, doesn't delete product)
 */
async function removeOnlineStoreProduct(req, res) {
  try {
    const { QueryTypes } = require('sequelize');
    const { id: online_store_id, product_id } = req.params;
    const { unpublish_only } = req.query; // If true, only unpublish, don't delete
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Get tenant to check subscription plan
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // Verify online store ownership
    const onlineStoreRows = await req.db.query(
      `SELECT id, tenant_id FROM online_stores WHERE id = :onlineStoreId AND tenant_id = :tenantId`,
      {
        replacements: { onlineStoreId: online_store_id, tenantId: tenantId },
        type: QueryTypes.SELECT
      }
    );

    if (!onlineStoreRows || onlineStoreRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found or access denied'
      });
    }

    // Check if product exists and is linked to this online store
    const productRows = await req.db.query(
      `SELECT p.id, p.tenant_id, p.name, p.image_url 
       FROM products p
       INNER JOIN store_products sp ON sp.product_id = p.id
       WHERE p.id = :productId AND p.tenant_id = :tenantId`,
      {
        replacements: { productId: product_id, tenantId: tenantId },
        type: QueryTypes.SELECT
      }
    );

    if (!productRows || productRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or access denied'
      });
    }

    const product = productRows[0];

    if (unpublish_only === 'true' || unpublish_only === true) {
      // Only unpublish (set is_published to false) - keep the product
      await req.db.query(
        `UPDATE store_products SET is_published = 0, updated_at = NOW() WHERE product_id = :productId`,
        {
          replacements: { productId: product_id },
          type: QueryTypes.UPDATE
        }
      );

      return res.json({
        success: true,
        message: 'Product unpublished from online store successfully',
        data: {
          product_id: parseInt(product_id),
          action: 'unpublished',
          note: 'Product is still in your inventory but not visible in the online store'
        }
      });
    } else {
      // Delete completely: Remove from online store AND delete the product
      
      // First, get variation option images before deleting (for cleanup)
      const variationOptions = await req.db.query(
        `SELECT image_url FROM product_variation_options WHERE variation_id IN (
          SELECT id FROM product_variations WHERE product_id = :productId
        )`,
        {
          replacements: { productId: product_id },
          type: QueryTypes.SELECT
        }
      );

      // Delete variation option images from filesystem
      if (variationOptions && variationOptions.length > 0) {
        for (const option of variationOptions) {
          if (option.image_url && option.image_url.startsWith('/uploads/product-variations/')) {
            const imagePath = path.join(__dirname, '..', option.image_url);
            if (fs.existsSync(imagePath)) {
              try {
                fs.unlinkSync(imagePath);
              } catch (error) {
                console.warn('Failed to delete variation option image:', error);
              }
            }
          }
        }
      }

      // Delete the StoreProduct record
      await req.db.query(
        `DELETE FROM store_products WHERE product_id = :productId`,
        {
          replacements: { productId: product_id },
          type: QueryTypes.DELETE
        }
      );

      // Delete product variations (cascade will delete variation options)
      await req.db.query(
        `DELETE FROM product_variations WHERE product_id = :productId`,
        {
          replacements: { productId: product_id },
          type: QueryTypes.DELETE
        }
      );

      // Delete product images if they exist
      if (product.image_url && product.image_url.startsWith('/uploads/products/')) {
        const imagePath = path.join(__dirname, '..', product.image_url);
        if (fs.existsSync(imagePath)) {
          try {
            fs.unlinkSync(imagePath);
          } catch (error) {
            console.warn('Failed to delete product image:', error);
          }
        }
      }

      // Delete the product itself
      await req.db.query(
        `DELETE FROM products WHERE id = :productId AND tenant_id = :tenantId`,
        {
          replacements: { productId: product_id, tenantId: tenantId },
          type: QueryTypes.DELETE
        }
      );

      return res.json({
        success: true,
        message: 'Product removed from online store and deleted successfully',
        data: {
          product_id: parseInt(product_id),
          action: 'deleted',
          note: 'Product and all associated data have been permanently deleted'
        }
      });
    }
  } catch (error) {
    console.error('Error removing online store product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove product from online store',
      error: error.message
    });
  }
}

/**
 * Publish product to online store (free users only)
 * POST /api/v1/online-stores/:id/products/:product_id/publish
 */
async function publishOnlineStoreProduct(req, res) {
  try {
    const { QueryTypes } = require('sequelize');
    const { id: online_store_id, product_id } = req.params;
    const { featured, sort_order } = req.body; // Optional: featured flag and sort order
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Get tenant to check subscription plan
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    // Verify online store ownership
    const onlineStoreRows = await req.db.query(
      `SELECT id, tenant_id FROM online_stores WHERE id = :onlineStoreId AND tenant_id = :tenantId`,
      {
        replacements: { onlineStoreId: online_store_id, tenantId: tenantId },
        type: QueryTypes.SELECT
      }
    );

    if (!onlineStoreRows || onlineStoreRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found or access denied'
      });
    }

    // Check if product exists and belongs to the user
    const productRows = await req.db.query(
      `SELECT id, tenant_id, name FROM products WHERE id = :productId AND tenant_id = :tenantId`,
      {
        replacements: { productId: product_id, tenantId: tenantId },
        type: QueryTypes.SELECT
      }
    );

    if (!productRows || productRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or access denied'
      });
    }

    // Check if StoreProduct already exists
    const existingStoreProduct = await req.db.query(
      `SELECT id, is_published, sort_order FROM store_products WHERE product_id = :productId`,
      {
        replacements: { productId: product_id },
        type: QueryTypes.SELECT
      }
    );

    let storeProductId;
    let finalSortOrder = sort_order;

    if (existingStoreProduct && existingStoreProduct.length > 0) {
      // Update existing StoreProduct
      storeProductId = existingStoreProduct[0].id;
      const oldSortOrder = existingStoreProduct[0].sort_order;

      // Handle smart sort order rearrangement if sort_order is provided
      if (sort_order !== undefined) {
        finalSortOrder = parseInt(sort_order) || 1;
        
        if (oldSortOrder !== finalSortOrder) {
          // Shift existing products
          const existingProductsToShift = await req.db.query(
            `SELECT id, sort_order FROM store_products 
             WHERE id != :storeProductId AND sort_order >= :sortOrder 
             ORDER BY sort_order DESC`,
            {
              replacements: { storeProductId: storeProductId, sortOrder: finalSortOrder },
              type: QueryTypes.SELECT
            }
          );

          if (existingProductsToShift && existingProductsToShift.length > 0) {
            for (const existingProduct of existingProductsToShift) {
              await req.db.query(
                `UPDATE store_products SET sort_order = :newSortOrder WHERE id = :id`,
                {
                  replacements: { 
                    newSortOrder: (parseInt(existingProduct.sort_order) || 0) + 1,
                    id: existingProduct.id
                  },
                  type: QueryTypes.UPDATE
                }
              );
            }
          }
        }
      } else {
        // Keep existing sort_order if not provided
        finalSortOrder = oldSortOrder || 1;
      }

      // Update StoreProduct
      const updateFields = ['is_published = 1', 'updated_at = NOW()'];
      const updateReplacements = { storeProductId: storeProductId };

      if (featured !== undefined) {
        updateFields.push('featured = :featured');
        updateReplacements.featured = featured ? 1 : 0;
      }
      if (sort_order !== undefined) {
        updateFields.push('sort_order = :sortOrder');
        updateReplacements.sortOrder = finalSortOrder;
      }

      await req.db.query(
        `UPDATE store_products SET ${updateFields.join(', ')} WHERE id = :storeProductId`,
        {
          replacements: updateReplacements,
          type: QueryTypes.UPDATE
        }
      );
    } else {
      // Create new StoreProduct record
      // Get max sort_order if not provided
      if (finalSortOrder === undefined || finalSortOrder === null) {
        const [maxResult] = await req.db.query(
          `SELECT MAX(sort_order) as max_sort_order FROM store_products`,
          {
            type: QueryTypes.SELECT
          }
        );
        const maxSortOrder = maxResult && maxResult.max_sort_order !== null ? maxResult.max_sort_order : 0;
        finalSortOrder = (maxSortOrder === null || maxSortOrder === undefined || maxSortOrder === 0) 
          ? 1 
          : (parseInt(maxSortOrder) || 0) + 1;
      } else {
        finalSortOrder = parseInt(finalSortOrder) || 1;
        // Smart sort order rearrangement
        const existingProductsToShift = await req.db.query(
          `SELECT id, sort_order FROM store_products WHERE sort_order >= :sortOrder ORDER BY sort_order DESC`,
          {
            replacements: { sortOrder: finalSortOrder },
            type: QueryTypes.SELECT
          }
        );

        if (existingProductsToShift && existingProductsToShift.length > 0) {
          for (const existingProduct of existingProductsToShift) {
            await req.db.query(
              `UPDATE store_products SET sort_order = :newSortOrder WHERE id = :id`,
              {
                replacements: { 
                  newSortOrder: (parseInt(existingProduct.sort_order) || 0) + 1,
                  id: existingProduct.id
                },
                type: QueryTypes.UPDATE
              }
            );
          }
        }
      }

      // Create StoreProduct
      await req.db.query(
        `INSERT INTO store_products (tenant_id, product_id, is_published, featured, sort_order, created_at, updated_at) 
         VALUES (:tenantId, :productId, 1, :featured, :sortOrder, NOW(), NOW())`,
        {
          replacements: {
            tenantId: tenantId,
            productId: product_id,
            featured: featured ? 1 : 0,
            sortOrder: finalSortOrder
          },
          type: QueryTypes.INSERT
        }
      );

      // Get the inserted ID
      const storeProductIdResults = await req.db.query(
        `SELECT LAST_INSERT_ID() as id`,
        {
          type: QueryTypes.SELECT
        }
      );
      
      storeProductId = storeProductIdResults && storeProductIdResults.length > 0 && storeProductIdResults[0].id 
        ? storeProductIdResults[0].id 
        : null;
    }

    // Fetch complete product with StoreProduct
    const publishedProductRows = await req.db.query(
      `SELECT id, tenant_id, name, sku, description, price, stock, category, image_url, is_active, created_at, updated_at 
       FROM products WHERE id = :productId`,
      {
        replacements: { productId: product_id },
        type: QueryTypes.SELECT
      }
    );

    const productData = publishedProductRows && publishedProductRows.length > 0 ? publishedProductRows[0] : null;

    if (!productData) {
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve product'
      });
    }

    // Fetch StoreProduct
    const storeProductRows = await req.db.query(
      `SELECT id, tenant_id, product_id, is_published, featured, sort_order, created_at, updated_at 
       FROM store_products 
       WHERE id = :storeProductId`,
      {
        replacements: { storeProductId: storeProductId },
        type: QueryTypes.SELECT
      }
    );

    if (storeProductRows && storeProductRows.length > 0) {
      productData.StoreProduct = storeProductRows[0];
    }

    // Fetch variations if they exist
    const fetchedVariations = await req.db.query(
      `SELECT id, tenant_id, product_id, variation_name, variation_type, is_required, sort_order, created_at 
       FROM product_variations 
       WHERE product_id = :productId 
       ORDER BY sort_order ASC`,
      {
        replacements: { productId: product_id },
        type: QueryTypes.SELECT
      }
    );

    const variationsWithOptions = [];
    if (fetchedVariations && fetchedVariations.length > 0) {
      for (const variation of fetchedVariations) {
        const options = await req.db.query(
          `SELECT id, tenant_id, variation_id, option_value, option_display_name, price_adjustment, stock, sku, image_url, is_default, is_available, sort_order, created_at 
           FROM product_variation_options 
           WHERE variation_id = :variationId 
           ORDER BY sort_order ASC`,
          {
            replacements: { variationId: variation.id },
            type: QueryTypes.SELECT
          }
        );
        variationsWithOptions.push({
          ...variation,
          ProductVariationOptions: options || []
        });
      }
    }

    productData.ProductVariations = variationsWithOptions || [];

    // Helper function to get full URL
    const getFullUrl = (req, relativePath) => {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    };

    // Convert image_url to full URL
    if (productData && productData.image_url && productData.image_url.startsWith('/uploads/')) {
      productData.image_url = getFullUrl(req, productData.image_url);
    }

    // Convert variation option image URLs to full URLs
    if (productData.ProductVariations) {
      productData.ProductVariations = productData.ProductVariations.map(variation => {
        if (variation.ProductVariationOptions) {
          variation.ProductVariationOptions = variation.ProductVariationOptions.map(option => {
            if (option.image_url && option.image_url.startsWith('/uploads/')) {
              option.image_url = getFullUrl(req, option.image_url);
            }
            return option;
          });
        }
        return variation;
      });
    }

    res.json({
      success: true,
      message: 'Product published to online store successfully',
      data: {
        product: productData
      }
    });
  } catch (error) {
    console.error('Error publishing product to online store:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to publish product to online store',
      error: error.message
    });
  }
}

/**
 * Get all products uploaded to online store (not in collections)
 * GET /api/v1/stores/online/:id/products
 * Returns products that are NOT in any collection
 */
async function getOnlineStoreProducts(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { id: online_store_id } = req.params;
    const { search, category, store_id, page = 1, limit = 20 } = req.query;

    // Parse pagination parameters
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    // Verify online store belongs to current tenant
    const onlineStore = await findTenantOnlineStoreById(req, models, online_store_id);
    if (!onlineStore) {
      return res.status(403).json({
        success: false,
        message: 'Online store not found or access denied'
      });
    }

    // Get tenant to check subscription plan
    const tenantId = req.user?.tenantId;
    const { getTenantById } = require('../config/tenant');
    let tenant = null;
    let isFreePlan = false;
    try {
      tenant = await getTenantById(tenantId);
      isFreePlan = tenant && tenant.subscription_plan === 'free';
    } catch (error) {
      console.warn('Could not fetch tenant:', error);
    }

    const { Sequelize } = require('sequelize');

    // Build where clause
    const where = {
      is_active: true
    };

    if (search) {
      where[Sequelize.Op.or] = [
        { name: { [Sequelize.Op.like]: `%${search}%` } },
        { sku: { [Sequelize.Op.like]: `%${search}%` } }
      ];
    }

    if (category) {
      where.category = category;
    }

    // For enterprise users, filter by store_id if provided
    if (!isFreePlan && store_id) {
      where.store_id = store_id;
    }

    // Get all product IDs that are already in collections for this online store
    const productsInCollections = await models.StoreCollectionProduct.findAll({
      attributes: ['product_id'],
      include: [
        {
          model: models.StoreCollection,
          where: { online_store_id: online_store_id },
          attributes: []
        }
      ],
      raw: true
    });

    const productIdsInCollections = productsInCollections.map(p => p.product_id).filter(Boolean);

    // Exclude products that are already in collections
    if (productIdsInCollections.length > 0) {
      where.id = {
        [Sequelize.Op.notIn]: productIdsInCollections
      };
    }

    // Get products with pagination
    const { count, rows } = await models.Product.findAndCountAll({
      where,
      attributes: ['id', 'name', 'sku', 'price', 'image_url', 'category', 'stock', 'description', 'created_at'],
      order: [['created_at', 'DESC']],
      limit: limitNum,
      offset: offset
    });

    // Helper function to get full URL
    const getFullUrl = (relativePath) => {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    };

    // Convert image_url to full URL for each product
    const products = rows.map(product => {
      const productData = product.toJSON();
      if (productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      return productData;
    });

    res.json({
      success: true,
      data: {
        products,
        total: count,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(count / limitNum),
          total_items: count
        }
      }
    });
  } catch (error) {
    console.error('Error getting online store products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get online store products',
      error: error.message
    });
  }
}

/**
 * Get authenticated user's online store preview
 * Protected route - requires authentication
 * Returns comprehensive store overview (same as public but for authenticated owners)
 * Can preview even if store is not published
 * GET /api/v1/online-stores/preview?preview_limit=5
 */
async function getStorePreview(req, res) {
  try {
    const { preview_limit = 5 } = req.query;

    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { Sequelize, Op } = require('sequelize');

    // Parse preview limit (max 20 items per section)
    const previewLimit = Math.min(parseInt(preview_limit) || 5, 20);

    // Get user's online store (can be unpublished for preview)
    const onlineStore = await models.OnlineStore.findOne({
      where: {
        // For free users, filter by tenant_id; for enterprise, no filter needed (separate DB)
        ...(req.user.tenantId && req.tenant?.subscription_plan === 'free' 
          ? { tenant_id: req.user.tenantId } 
          : {})
      },
      include: [
        {
          model: models.OnlineStoreLocation,
          include: [{ 
            model: models.Store, 
            attributes: ['id', 'name', 'address', 'city', 'state', 'country'] 
          }]
        }
      ],
      order: [['created_at', 'DESC']] // Get most recent store
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found. Please set up your online store first.'
      });
    }

    // Helper to normalize URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const storeData = onlineStore.toJSON();
    
    // Normalize store image URLs
    if (storeData.profile_logo_url) storeData.profile_logo_url = getFullUrl(storeData.profile_logo_url);
    if (storeData.banner_image_url) storeData.banner_image_url = getFullUrl(storeData.banner_image_url);
    if (storeData.background_image_url) storeData.background_image_url = getFullUrl(storeData.background_image_url);

    // Check if products and services exist to determine toggle visibility
    // Can preview even if not published
    const hasProducts = await models.StoreProduct.count({
      where: {
        online_store_id: onlineStore.id
      },
      include: [{
        model: models.Product,
        where: { is_active: true },
        required: true
      }]
    }) > 0;

    const hasServices = await models.StoreService.count({
      where: { is_active: true }
    }) > 0;

    // Get product collections (preview - limited items per collection)
    // Can preview even if not visible
    const productCollections = await models.StoreCollection.findAll({
      where: {
        online_store_id: onlineStore.id,
        collection_type: 'product'
      },
      include: [
        {
          model: models.StoreCollectionProduct,
          include: [
            {
              model: models.Product,
              where: { is_active: true },
              required: false,
              attributes: ['id', 'name', 'sku', 'price', 'image_url', 'category']
            }
          ],
          limit: previewLimit,
          order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
        }
      ],
      order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']],
      limit: 10
    });

    // Get service collections (preview - limited items per collection)
    // Can preview even if not visible
    const serviceCollections = await models.StoreCollection.findAll({
      where: {
        online_store_id: onlineStore.id,
        collection_type: 'service'
      },
      include: [
        {
          model: models.StoreCollectionService,
          include: [
            {
              model: models.StoreService,
              where: { is_active: true },
              required: false,
              attributes: ['id', 'service_title', 'description', 'price', 'service_image_url', 'duration_minutes']
            }
          ],
          limit: previewLimit,
          order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']]
        }
      ],
      order: [['sort_order', 'ASC'], ['is_pinned', 'DESC']],
      limit: 10
    });

    // Get products NOT in any collection (preview)
    // Can preview even if not published
    const productsNotInCollections = await models.StoreProduct.findAll({
      where: {
        online_store_id: onlineStore.id,
        '$Product.StoreCollectionProducts.id$': { [Op.eq]: null }
      },
      include: [
        {
          model: models.Product,
          where: { is_active: true },
          required: true,
          include: [{
            model: models.StoreCollectionProduct,
            required: false,
            attributes: []
          }]
        }
      ],
      limit: previewLimit,
      order: [['created_at', 'DESC']],
      subQuery: false,
      group: ['StoreProduct.id']
    });

    // Get services NOT in any collection (preview)
    const servicesNotInCollections = await models.StoreService.findAll({
      where: {
        is_active: true,
        '$OnlineStoreServices.online_store_id$': onlineStore.id,
        '$StoreCollectionServices.id$': { [Op.eq]: null }
      },
      include: [
        {
          model: models.OnlineStoreService,
          where: { 
            online_store_id: onlineStore.id,
            is_visible: true
          },
          required: true,
          attributes: []
        },
        {
          model: models.StoreCollectionService,
          required: false,
          attributes: []
        }
      ],
      limit: previewLimit,
      order: [['created_at', 'DESC']],
      subQuery: false,
      group: ['StoreService.id']
    });

    // Get total counts for pagination info
    // Can preview even if not visible
    const totalProductCollections = await models.StoreCollection.count({
      where: {
        online_store_id: onlineStore.id,
        collection_type: 'product'
      }
    });

    const totalServiceCollections = await models.StoreCollection.count({
      where: {
        online_store_id: onlineStore.id,
        collection_type: 'service'
      }
    });

    // Count products not in collections using a subquery approach
    // Can preview even if not published
    const [productsNotInCollectionsCountResult] = await req.db.query(`
      SELECT COUNT(DISTINCT sp.id) as count
      FROM store_products sp
      INNER JOIN products p ON sp.product_id = p.id
      LEFT JOIN store_collection_products scp ON p.id = scp.product_id
      WHERE sp.online_store_id = :onlineStoreId
        AND p.is_active = 1
        AND scp.id IS NULL
    `, {
      replacements: { onlineStoreId: onlineStore.id },
      type: Sequelize.QueryTypes.SELECT
    });
    const totalProductsNotInCollections = productsNotInCollectionsCountResult?.count || 0;

    // Count services not in collections (linked to this online store)
    const [servicesNotInCollectionsCountResult] = await req.db.query(`
      SELECT COUNT(DISTINCT ss.id) as count
      FROM store_services ss
      INNER JOIN online_store_services oss ON ss.id = oss.service_id
      LEFT JOIN store_collection_services scs ON ss.id = scs.service_id
      WHERE ss.is_active = 1
        AND oss.online_store_id = :onlineStoreId
        AND oss.is_visible = 1
        AND scs.id IS NULL
    `, {
      replacements: { onlineStoreId: onlineStore.id },
      type: Sequelize.QueryTypes.SELECT
    });
    const totalServicesNotInCollections = servicesNotInCollectionsCountResult?.count || 0;

    // Normalize collection data
    const normalizeCollection = (collection) => {
      const collectionData = collection.toJSON();
      if (collectionData.StoreCollectionProducts) {
        collectionData.StoreCollectionProducts = collectionData.StoreCollectionProducts.map(cp => {
          const productData = cp.Product ? cp.Product.toJSON() : null;
          if (productData && productData.image_url) {
            productData.image_url = getFullUrl(productData.image_url);
          }
          return {
            ...cp.toJSON(),
            Product: productData
          };
        });
      }
      if (collectionData.StoreCollectionServices) {
        collectionData.StoreCollectionServices = collectionData.StoreCollectionServices.map(cs => {
          const serviceData = cs.StoreService ? cs.StoreService.toJSON() : null;
          if (serviceData && serviceData.service_image_url) {
            serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
          }
          return {
            ...cs.toJSON(),
            StoreService: serviceData
          };
        });
      }
      return collectionData;
    };

    // Normalize products
    const normalizedProducts = productsNotInCollections.map(sp => {
      const productData = sp.Product.toJSON();
      if (productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      return productData;
    });

    // Normalize services
    const normalizedServices = servicesNotInCollections.map(service => {
      const serviceData = service.toJSON();
      if (serviceData.service_image_url) {
        serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
      }
      return serviceData;
    });

    res.json({
      success: true,
      data: {
        store: {
          id: storeData.id,
          username: storeData.username,
          store_name: storeData.store_name,
          store_description: storeData.store_description,
          profile_logo_url: storeData.profile_logo_url,
          banner_image_url: storeData.banner_image_url,
          background_image_url: storeData.background_image_url,
          background_color: storeData.background_color,
          button_style: storeData.button_style,
          button_color: storeData.button_color,
          button_font_color: storeData.button_font_color,
          social_links: storeData.social_links,
          is_location_based: storeData.is_location_based,
          show_location: storeData.show_location,
          allow_delivery_datetime: storeData.allow_delivery_datetime,
          is_published: storeData.is_published, // Include published status for preview
          OnlineStoreLocations: storeData.OnlineStoreLocations
        },
        toggles: {
          show_products: hasProducts,
          show_services: hasServices
        },
        product_collections: {
          items: productCollections.map(normalizeCollection),
          total: totalProductCollections,
          preview_limit: previewLimit,
          has_more: totalProductCollections > productCollections.length
        },
        service_collections: {
          items: serviceCollections.map(normalizeCollection),
          total: totalServiceCollections,
          preview_limit: previewLimit,
          has_more: totalServiceCollections > serviceCollections.length
        },
        products_not_in_collections: {
          items: normalizedProducts,
          total: parseInt(totalProductsNotInCollections) || 0,
          preview_limit: previewLimit,
          has_more: (parseInt(totalProductsNotInCollections) || 0) > normalizedProducts.length
        },
        services_not_in_collections: {
          items: normalizedServices,
          total: parseInt(totalServicesNotInCollections) || 0,
          preview_limit: previewLimit,
          has_more: (parseInt(totalServicesNotInCollections) || 0) > normalizedServices.length
        }
      }
    });
  } catch (error) {
    console.error('Error getting store preview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store preview',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Preview Controller Functions
 * These mirror the public store routes but are protected and can show unpublished stores
 * For authenticated store owners to preview their store
 */

/**
 * Get all services for preview (ALL services with filters)
 * GET /api/v1/online-stores/preview/services?collection_id=123&search=keyword
 * Filters:
 *   - collection_id: Filter services by collection
 *   - search: Search by service name or description
 */
async function getPreviewServices(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { search, page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    // Get user's online store
    const onlineStore = await models.OnlineStore.findOne({
      where: {
        ...(req.user.tenantId && req.tenant?.subscription_plan === 'free' 
          ? { tenant_id: req.user.tenantId } 
          : {})
      },
      order: [['created_at', 'DESC']]
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found. Please set up your online store first.'
      });
    }

    const { Op } = require('sequelize');
    const { collection_id } = req.query;

    const where = {
      is_active: true
    };

    if (search) {
      where[Op.or] = [
        { service_title: { [Op.like]: `%${search}%` } },
        { description: { [Op.like]: `%${search}%` } }
      ];
    }

    // Build include clause - services linked to this online store
    const includeClause = [{
      model: models.OnlineStoreService,
      where: { 
        online_store_id: onlineStore.id,
        is_visible: true
      },
      required: true,
      attributes: []
    }];

    // If collection_id is provided, filter services in that collection
    if (collection_id) {
      includeClause.push({
        model: models.StoreCollectionService,
        where: { collection_id },
        required: true,
        attributes: []
      });
    }

    // Get ALL services for this online store (with optional collection filter)
    // Can preview even if not visible
    const { count, rows } = await models.StoreService.findAndCountAll({
      where,
      include: includeClause,
      order: [['created_at', 'DESC']],
      limit: limitNum,
      offset: offset,
      distinct: true
    });

    // Normalize image URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const services = rows.map(service => {
      const serviceData = service.toJSON();
      if (serviceData.service_image_url) {
        serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
      }
      return serviceData;
    });

    res.json({
      success: true,
      data: { 
        services,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(count / limitNum),
          total_items: count
        }
      }
    });
  } catch (error) {
    console.error('Error getting preview services:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get services',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get service by ID for preview
 * GET /api/v1/online-stores/preview/services/:service_id
 */
async function getPreviewService(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { service_id } = req.params;

    // Get user's online store
    const onlineStore = await models.OnlineStore.findOne({
      where: {
        ...(req.user.tenantId && req.tenant?.subscription_plan === 'free' 
          ? { tenant_id: req.user.tenantId } 
          : {})
      },
      order: [['created_at', 'DESC']]
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found. Please set up your online store first.'
      });
    }

    // Get service (linked to this online store)
    const service = await models.StoreService.findOne({
      where: {
        id: service_id,
        is_active: true
      },
      include: [{
        model: models.OnlineStoreService,
        where: { 
          online_store_id: onlineStore.id
        },
        required: true
      }]
    });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Normalize image URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const serviceData = service.toJSON();
    if (serviceData.service_image_url) {
      serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
    }

    res.json({
      success: true,
      data: { service: serviceData }
    });
  } catch (error) {
    console.error('Error getting preview service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get service',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get all products for preview (products not in collections)
 * GET /api/v1/online-stores/preview/products
 */
async function getPreviewProducts(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { search, category, store_id, page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    // Get user's online store
    const onlineStore = await models.OnlineStore.findOne({
      where: {
        ...(req.user.tenantId && req.tenant?.subscription_plan === 'free' 
          ? { tenant_id: req.user.tenantId } 
          : {})
      },
      order: [['created_at', 'DESC']]
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found. Please set up your online store first.'
      });
    }

    const { Op } = require('sequelize');

    // Build product where clause
    const productWhere = { is_active: true };
    if (search) {
      productWhere[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { sku: { [Op.like]: `%${search}%` } }
      ];
    }
    if (category) {
      productWhere.category = category;
    }

    // For enterprise users, filter by physical store if store_id is provided
    if (req.tenant?.subscription_plan !== 'free' && store_id) {
      productWhere.store_id = store_id;
    }

    // Build StoreProduct where clause
    const storeProductWhere = {
      online_store_id: onlineStore.id
    };

    // If collection_id is provided, filter products in that collection
    if (collection_id) {
      storeProductWhere['$Product.StoreCollectionProducts.collection_id$'] = collection_id;
    }

    // Get ALL products for this online store (with optional collection filter)
    // Can preview even if not published
    const { count, rows } = await models.StoreProduct.findAndCountAll({
      where: storeProductWhere,
      include: [
        {
          model: models.Product,
          where: productWhere,
          required: true,
          include: [{
            model: models.StoreCollectionProduct,
            required: collection_id ? true : false, // Required only if filtering by collection
            attributes: ['id', 'collection_id'],
            ...(collection_id ? { where: { collection_id } } : {})
          }]
        }
      ],
      limit: limitNum,
      offset: offset,
      order: [['created_at', 'DESC']],
      subQuery: false,
      group: ['StoreProduct.id'],
      distinct: true
    });

    // Normalize image URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const products = rows.map(sp => {
      const productData = sp.Product.toJSON();
      if (productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      return productData;
    });

    res.json({
      success: true,
      data: { 
        products,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(count.length / limitNum),
          total_items: count.length
        }
      }
    });
  } catch (error) {
    console.error('Error getting preview products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get products',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get product by ID for preview
 * GET /api/v1/online-stores/preview/products/:product_id
 */
async function getPreviewProduct(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { product_id } = req.params;

    // Get user's online store
    const onlineStore = await models.OnlineStore.findOne({
      where: {
        ...(req.user.tenantId && req.tenant?.subscription_plan === 'free' 
          ? { tenant_id: req.user.tenantId } 
          : {})
      },
      order: [['created_at', 'DESC']]
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found. Please set up your online store first.'
      });
    }

    // Get product (can preview even if not published)
    const product = await models.Product.findOne({
      where: {
        id: product_id,
        is_active: true
      },
      include: [{
        model: models.StoreProduct,
        where: {
          online_store_id: onlineStore.id
        },
        required: true
      }]
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Normalize image URLs
    function getFullUrl(relativePath) {
      if (!relativePath) return null;
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        return relativePath;
      }
      const protocol = req.protocol;
      const host = req.get('host');
      return `${protocol}://${host}${relativePath}`;
    }

    const productData = product.toJSON();
    if (productData.image_url) {
      productData.image_url = getFullUrl(productData.image_url);
    }

    res.json({
      success: true,
      data: { product: productData }
    });
  } catch (error) {
    console.error('Error getting preview product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

module.exports = {
  checkOnlineStoreSetup,
  setupOnlineStore,
  getOnlineStoreById,
  updateStorefront,
  updateStoreInformation,
  updateStoreAppearance,
  uploadStoreImage,
  publishOnlineStore,
  getPublicStorePreview,
  getStorePreview,
  getPreviewProducts,
  getPreviewProduct,
  getPreviewServices,
  getPreviewService,
  createOnlineStoreProduct,
  updateOnlineStoreProduct,
  removeOnlineStoreProduct,
  publishOnlineStoreProduct,
  getOnlineStoreProducts
};

