const multer = require('multer');
const path = require('path');
const fs = require('fs');
const initModels = require('../models');
const sharp = require('sharp');

// ─── Theme generation helpers ────────────────────────────────────────────────

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16)
  };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function hslHex(h, s, l) {
  const { r, g, b } = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

/**
 * Extract the dominant (most representative) color from an image file using sharp.
 * Filters out near-white, near-black, and transparent pixels to avoid picking backgrounds.
 * Returns a hex color string, e.g. "#3B82F6".
 */
async function extractDominantColor(filePath) {
  // Resize to small thumbnail for speed, get raw RGBA pixels
  const { data } = await sharp(filePath)
    .resize(80, 80, { fit: 'cover' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue; // skip transparent pixels

    const brightness = (r + g + b) / 3;
    if (brightness > 235) continue; // skip near-white
    if (brightness < 20) continue;  // skip near-black

    // Skip very desaturated (grey) pixels
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation < 0.12) continue;

    rSum += r; gSum += g; bSum += b; count++;
  }

  if (count === 0) {
    // Fallback: average all non-transparent pixels without saturation filter
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue;
      rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2]; count++;
    }
  }

  if (count === 0) return '#78716C'; // ultimate fallback

  return rgbToHex(Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count));
}

/**
 * Generate 5 theme variants from a dominant brand color hex string.
 */
function hexToRgbaStr(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Build a complete, fully-specified theme object.
 * Every key the storefront needs is present — no CSS fallbacks required.
 */
function buildTheme({
  id, name, description,
  // Backgrounds
  background_color, surface, card,
  // Primary brand colour scale
  primary, primary_light, primary_dark, primary_muted,
  // Buttons
  button_color, button_font_color,
  // Text hierarchy
  text_primary, text_secondary, text_tertiary,
  // Borders
  border_default, border_accent,
  // Picker swatches (3 colours)
  preview_colors
}) {
  return {
    id,
    name,
    description,
    // Backgrounds
    background_color,
    surface,
    card,
    // Primary colour scale
    primary,
    primary_light,
    primary_dark,
    primary_muted,
    // Buttons
    button_color,
    button_font_color,
    // Text
    text_primary,
    text_secondary,
    text_tertiary,
    // Borders
    border_default,
    border_accent,
    // Picker swatches
    preview_colors: preview_colors || [background_color, primary, card]
  };
}

/**
 * Generate 5 theme variants from a dominant brand color hex string.
 */
function generateThemesFromColor(dominantHex) {
  const { r, g, b } = hexToRgb(dominantHex);
  const { h, s, l } = rgbToHsl(r, g, b);

  const brandS    = Math.min(Math.max(s, 40), 85);
  const brandL    = Math.min(Math.max(l, 30), 65);

  // Brand colour scale
  const primary        = hslHex(h, brandS, brandL);
  const primaryLight   = hslHex(h, Math.min(brandS, 55), Math.min(brandL + 28, 88));
  const primaryDark    = hslHex(h, Math.min(brandS, 70), Math.max(brandL - 20, 14));
  const primaryVibrant = hslHex(h, Math.min(brandS + 15, 100), Math.min(Math.max(brandL, 45), 55));
  const primaryMuted   = hslHex(h, Math.max(brandS - 25, 15), Math.min(brandL + 15, 70));
  const primaryPastel  = hslHex(h, Math.max(brandS - 20, 20), Math.min(brandL + 35, 90));

  const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
  const primaryFontColor = lum > 0.55 ? '#111111' : '#FFFFFF';

  return [
    // ── CLASSIC ── warm white canvas, brand accent
    buildTheme({
      id: 'classic', name: 'Classic',
      description: 'Clean and timeless — brand accent on a warm white base',
      background_color: '#F2EFEF',
      surface:          '#E8E5E2',
      card:             '#FFFFFF',
      primary,
      primary_light:  primaryLight,
      primary_dark:   primaryDark,
      primary_muted:  hexToRgbaStr(primary, 0.08),
      button_color:       primary,
      button_font_color:  primaryFontColor,
      text_primary:       '#111111',
      text_secondary:     'rgba(17,17,17,0.58)',
      text_tertiary:      'rgba(17,17,17,0.35)',
      border_default:     'rgba(0,0,0,0.08)',
      border_accent:      hexToRgbaStr(primary, 0.25),
      preview_colors: ['#F2EFEF', primary, primaryLight]
    }),

    // ── LIGHT ── very lightly brand-tinted — surface/card always near-white
    buildTheme({
      id: 'light', name: 'Light',
      description: 'Clean and minimal — soft tinted background with brand buttons',
      background_color: '#FFFFFF',
      // Surface and card are always very high lightness (≥94%) regardless of brand darkness.
      // Using a tiny fraction of the brand saturation so it reads as white, not coloured.
      surface:          hslHex(h, Math.min(brandS * 0.25, 12), 95),
      card:             hslHex(h, Math.min(brandS * 0.15, 7),  97),
      primary,
      primary_light:  primaryLight,
      primary_dark:   primaryDark,
      primary_muted:  hexToRgbaStr(primary, 0.08),
      button_color:       primary,
      button_font_color:  '#FFFFFF',
      text_primary:       '#111111',
      text_secondary:     'rgba(17,17,17,0.58)',
      text_tertiary:      'rgba(17,17,17,0.35)',
      border_default:     'rgba(0,0,0,0.08)',
      border_accent:      hexToRgbaStr(primary, 0.25),
      preview_colors: ['#FFFFFF', primary, hslHex(h, Math.min(brandS * 0.25, 12), 95)]
    }),

    // ── DARK ── deep brand-tinted dark
    buildTheme({
      id: 'dark', name: 'Dark',
      description: 'Bold and dramatic — dark background with brand highlights',
      background_color: hslHex(h, Math.min(brandS * 0.4, 28), 10),
      surface:          hslHex(h, Math.min(brandS * 0.45, 30), 16),
      card:             hslHex(h, Math.min(brandS * 0.5, 32), 20),
      primary:          primaryVibrant,
      primary_light:    hslHex(h, Math.min(brandS, 55), Math.min(brandL + 25, 78)),
      primary_dark:     primaryDark,
      primary_muted:    hexToRgbaStr(primaryVibrant, 0.12),
      button_color:       primaryVibrant,
      button_font_color:  '#FFFFFF',
      text_primary:       '#F5F2EE',
      text_secondary:     'rgba(245,242,238,0.58)',
      text_tertiary:      'rgba(245,242,238,0.35)',
      border_default:     'rgba(255,255,255,0.08)',
      border_accent:      hexToRgbaStr(primaryVibrant, 0.25),
      preview_colors: [hslHex(h, Math.min(brandS * 0.4, 28), 10), primaryVibrant, hslHex(h, Math.min(brandS * 0.5, 32), 20)]
    }),

    // ── BOLD ── vibrant brand colour fills the canvas
    buildTheme({
      id: 'bold', name: 'Bold',
      description: 'High-impact — vibrant brand colour fills the canvas',
      background_color: primaryVibrant,
      surface:          hslHex(h, Math.min(brandS + 5, 100), Math.max(brandL - 8, 28)),
      card:             hslHex(h, Math.min(brandS + 8, 100), Math.max(brandL - 4, 34)),
      primary:          '#FFFFFF',
      primary_light:    'rgba(255,255,255,0.75)',
      primary_dark:     primaryDark,
      primary_muted:    'rgba(255,255,255,0.12)',
      button_color:       '#FFFFFF',
      button_font_color:  primaryDark,
      text_primary:       '#FFFFFF',
      text_secondary:     'rgba(255,255,255,0.65)',
      text_tertiary:      'rgba(255,255,255,0.4)',
      border_default:     'rgba(255,255,255,0.15)',
      border_accent:      'rgba(255,255,255,0.35)',
      preview_colors: [primaryVibrant, '#FFFFFF', hslHex(h, Math.min(brandS + 5, 100), Math.max(brandL - 8, 28))]
    }),

    // ── SOFT ── neutral base, muted brand accents
    buildTheme({
      id: 'soft', name: 'Soft',
      description: 'Gentle and welcoming — muted tones with subtle brand accents',
      background_color: '#FAFAFA',
      surface:          '#F0EDEA',
      card:             '#FFFFFF',
      primary:          primaryMuted,
      primary_light:    primaryPastel,
      primary_dark:     primaryDark,
      primary_muted:    hexToRgbaStr(primaryMuted, 0.08),
      button_color:       primaryMuted,
      button_font_color:  '#FFFFFF',
      text_primary:       '#111111',
      text_secondary:     'rgba(17,17,17,0.55)',
      text_tertiary:      'rgba(17,17,17,0.32)',
      border_default:     'rgba(0,0,0,0.07)',
      border_accent:      hexToRgbaStr(primaryMuted, 0.22),
      preview_colors: ['#FAFAFA', primaryMuted, primaryPastel]
    })
  ];
}

/**
 * Get the default store URL (subdomain on MycroShop: username.mycroshop.com).
 * This is the always-available URL for every online store, without purchasing a domain.
 */
function getDefaultStoreUrl(username) {
  if (!username) return null;
  const mainDomain = process.env.MAIN_DOMAIN || 'mycroshop.com';
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : (process.env.FRONTEND_URL && process.env.FRONTEND_URL.startsWith('https') ? 'https' : 'http');
  return `${protocol}://${username}.${mainDomain}`;
}

/**
 * Get the primary storefront URL: custom domain if linked, otherwise the default subdomain URL.
 */
function getStorefrontUrl(onlineStore) {
  const store = onlineStore && (onlineStore.toJSON ? onlineStore.toJSON() : onlineStore);
  if (!store) return null;
  if (store.custom_domain) {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'https';
    return `${protocol}://${store.custom_domain}`;
  }
  return getDefaultStoreUrl(store.username);
}

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

const { QueryTypes: QTypes } = require('sequelize');

/**
 * Fetch product variants with option labels in a frontend-friendly structure.
 * Returns array of { id, sku, price, stock, image_url, options: [{ variation_name, option_value, variation_id, option_id }] }.
 * getFullUrl(path) is optional; if provided, variant image_url is converted to full URL.
 */
async function fetchProductVariantsStructured(db, productId, getFullUrl) {
  if (!db || !productId) return [];
  const rows = await db.query(
    `SELECT pv.id AS variant_id, pv.sku, pv.price, pv.stock, pv.image_url,
       pvo.variation_id, pvo.option_id,
       pvar.variation_name,
       pvaropt.option_value, pvaropt.option_display_name
     FROM product_variants pv
     LEFT JOIN product_variant_options pvo ON pv.id = pvo.variant_id
     LEFT JOIN product_variations pvar ON pvo.variation_id = pvar.id
     LEFT JOIN product_variation_options pvaropt ON pvo.option_id = pvaropt.id
     WHERE pv.product_id = :productId
     ORDER BY pv.id, pvar.sort_order ASC`,
    { replacements: { productId }, type: QTypes.SELECT }
  );
  if (!rows || rows.length === 0) return [];
  const byVariant = new Map();
  for (const r of rows) {
    const vid = r.variant_id;
    if (!byVariant.has(vid)) {
      let imageUrl = r.image_url || null;
      if (imageUrl && typeof getFullUrl === 'function') imageUrl = getFullUrl(imageUrl);
      byVariant.set(vid, {
        id: vid,
        sku: r.sku || null,
        price: parseFloat(r.price) || 0,
        stock: parseInt(r.stock) || 0,
        image_url: imageUrl,
        options: []
      });
    }
    if (r.variation_id && r.option_id != null) {
      byVariant.get(vid).options.push({
        variation_name: r.variation_name || null,
        option_value: r.option_value != null ? String(r.option_value) : null,
        option_display_name: r.option_display_name || r.option_value || null,
        variation_id: r.variation_id,
        option_id: r.option_id
      });
    }
  }
  return Array.from(byVariant.values());
}

/**
 * Fetch variants for multiple products. Returns Map<productId, variants[]>. getFullUrl optional.
 */
async function fetchVariantsForProductIds(db, productIds, getFullUrl) {
  if (!db || !productIds || productIds.length === 0) return new Map();
  const ids = [...new Set(productIds)].filter(Boolean);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT pv.id AS variant_id, pv.product_id, pv.sku, pv.price, pv.stock, pv.image_url,
       pvo.variation_id, pvo.option_id,
       pvar.variation_name,
       pvaropt.option_value, pvaropt.option_display_name
     FROM product_variants pv
     LEFT JOIN product_variant_options pvo ON pv.id = pvo.variant_id
     LEFT JOIN product_variations pvar ON pvo.variation_id = pvar.id
     LEFT JOIN product_variation_options pvaropt ON pvo.option_id = pvaropt.id
     WHERE pv.product_id IN (${placeholders})
     ORDER BY pv.product_id, pv.id, pvar.sort_order ASC`,
    { replacements: ids, type: QTypes.SELECT }
  );
  const byProduct = new Map();
  for (const r of rows || []) {
    const pid = r.product_id;
    if (!byProduct.has(pid)) byProduct.set(pid, new Map());
    const byVariant = byProduct.get(pid);
    const vid = r.variant_id;
    if (!byVariant.has(vid)) {
      let imageUrl = r.image_url || null;
      if (imageUrl && typeof getFullUrl === 'function') imageUrl = getFullUrl(imageUrl);
      byVariant.set(vid, {
        id: vid,
        sku: r.sku || null,
        price: parseFloat(r.price) || 0,
        stock: parseInt(r.stock) || 0,
        image_url: imageUrl,
        options: []
      });
    }
    if (r.variation_id && r.option_id != null) {
      byVariant.get(vid).options.push({
        variation_name: r.variation_name || null,
        option_value: r.option_value != null ? String(r.option_value) : null,
        option_display_name: r.option_display_name || r.option_value || null,
        variation_id: r.variation_id,
        option_id: r.option_id
      });
    }
  }
  const result = new Map();
  for (const pid of ids) {
    result.set(Number(pid), byProduct.has(pid) ? Array.from(byProduct.get(pid).values()) : []);
  }
  return result;
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

    const defaultStoreUrl = getDefaultStoreUrl(onlineStore.username);
    res.status(201).json({
      success: true,
      message: 'Online store created successfully',
      data: {
        onlineStore: {
          id: onlineStore.id,
          username: onlineStore.username,
          store_name: onlineStore.store_name,
          default_store_url: defaultStoreUrl,
          storefront_url: defaultStoreUrl,
          storefront_link: defaultStoreUrl
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
 * Get default and storefront URLs for an online store (dedicated API).
 * GET /api/v1/stores/online/:id/urls
 * Returns only URL fields so the client can get the store link without loading full store data.
 */
async function getOnlineStoreUrls(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const onlineStore = await findTenantOnlineStoreById(req, models, req.params.id, {
      attributes: ['id', 'username', 'custom_domain']
    });

    if (!onlineStore) {
      return res.status(404).json({
        success: false,
        message: 'Online store not found'
      });
    }

    const default_store_url = getDefaultStoreUrl(onlineStore.username);
    const storefront_url = getStorefrontUrl(onlineStore);

    res.json({
      success: true,
      data: {
        default_store_url,
        storefront_url,
        custom_domain: onlineStore.custom_domain || null
      }
    });
  } catch (error) {
    console.error('Error getting online store URLs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get store URLs',
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

    // Mirror store_description to tenant.business_bio
    if (store_description !== undefined) {
      try {
        const { getTenantById } = require('../config/tenant');
        const tenant = await getTenantById(req.user.tenantId);
        if (tenant) {
          await tenant.update({ business_bio: store_description });
        }
      } catch (bioErr) {
        console.warn('Could not sync store_description to business_bio:', bioErr.message);
      }
    }

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
      show_social_icons,
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
      ...(show_social_icons !== undefined && { show_social_icons }),
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

    const { selected_theme } = req.body;

    if (!selected_theme || typeof selected_theme !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'selected_theme is required and must be a theme object'
      });
    }

    await onlineStore.update({ selected_theme });

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
  
  // Parse selected_theme if MySQL returned it as a JSON string
  if (storeData.selected_theme && typeof storeData.selected_theme === 'string') {
    try {
      storeData.selected_theme = JSON.parse(storeData.selected_theme);
    } catch (e) {
      storeData.selected_theme = null;
    }
  }

  // Parse suggested_themes if MySQL returned it as a JSON string
  if (storeData.suggested_themes && typeof storeData.suggested_themes === 'string') {
    try {
      storeData.suggested_themes = JSON.parse(storeData.suggested_themes);
    } catch (e) {
      storeData.suggested_themes = null;
    }
  }

  // Patch stale light theme surface/card: old algorithm produced mid-grey (#94a9b8, #8f9ba3).
  // Correct values are always near-white (L ≥ 94%). Detect by checking if surface lightness < 85%
  // and fix in-place so the frontend always receives the correct light theme without re-upload.
  if (Array.isArray(storeData.suggested_themes)) {
    storeData.suggested_themes = storeData.suggested_themes.map(t => {
      if (t.id !== 'light') return t;
      // Parse surface hex to HSL to check lightness
      const staleSurface = /^#([0-9a-f]{6})$/i.exec(t.surface);
      if (staleSurface) {
        const r = parseInt(staleSurface[1].slice(0, 2), 16) / 255;
        const g = parseInt(staleSurface[1].slice(2, 4), 16) / 255;
        const b = parseInt(staleSurface[1].slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const lightness = (max + min) / 2;
        if (lightness < 0.85) {
          // Surface is too dark — replace with near-white tinted values
          // Derive hue from the button_color (primary) to keep the tint consistent
          const pc = /^#([0-9a-f]{6})$/i.exec(t.button_color || t.primary || '#2e526b');
          let hue = 205; // default to blue
          if (pc) {
            const pr = parseInt(pc[1].slice(0, 2), 16) / 255;
            const pg = parseInt(pc[1].slice(2, 4), 16) / 255;
            const pb = parseInt(pc[1].slice(4, 6), 16) / 255;
            const pmx = Math.max(pr, pg, pb), pmn = Math.min(pr, pg, pb);
            const d = pmx - pmn;
            if (d > 0) {
              if (pmx === pr) hue = 60 * (((pg - pb) / d) % 6);
              else if (pmx === pg) hue = 60 * (((pb - pr) / d) + 2);
              else hue = 60 * (((pr - pg) / d) + 4);
              if (hue < 0) hue += 360;
            }
          }
          return {
            ...t,
            surface: `hsl(${Math.round(hue)},10%,95%)`,
            card:    `hsl(${Math.round(hue)},6%,97%)`
          };
        }
      }
      return t;
    });
  }

  // Convert image URLs to full URLs
  if (storeData.profile_logo_url) {
    storeData.profile_logo_url = getFullUrl(req, storeData.profile_logo_url);
  }
  if (storeData.banner_image_url) {
    storeData.banner_image_url = getFullUrl(req, storeData.banner_image_url);
  }

  // Subdomain is the default domain for MycroShop online stores (e.g. mystore.mycroshop.com)
  storeData.default_store_url = getDefaultStoreUrl(storeData.username);
  storeData.storefront_url = getStorefrontUrl(storeData);
  if (!storeData.storefront_link) {
    storeData.storefront_link = storeData.storefront_url || storeData.default_store_url;
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
        let generatedThemes = null;
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

          // Extract dominant color and generate theme suggestions
          try {
            const dominantColor = await extractDominantColor(files.logo[0].path);
            generatedThemes = generateThemesFromColor(dominantColor);
          } catch (themeErr) {
            console.warn('Theme generation failed (non-fatal):', themeErr.message);
          }
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
        
        if (Object.keys(updates).length === 0) {
          return res.status(400).json({
            success: false,
            message: 'No valid files uploaded'
          });
        }

        // Persist suggested_themes so owner can re-select later without re-uploading
        if (generatedThemes) {
          updates.suggested_themes = generatedThemes;
        }

        await onlineStore.update(updates);
        
        // Refresh the onlineStore to get updated values
        await onlineStore.reload();
        
        // Normalize the onlineStore data (parses social_links, converts URLs)
        const normalizedStore = normalizeOnlineStoreData(req, onlineStore);
        
        const uploadedCount = Object.keys(uploadedImages).length;
        const uploadedTypes = Object.keys(uploadedImages).join(', ');
        
        const responseData = {
          uploaded_images: uploadedImages,
          onlineStore: normalizedStore
        };
        if (generatedThemes) {
          responseData.suggested_themes = generatedThemes;
        }

        res.json({
          success: true,
          message: `${uploadedCount} image(s) uploaded successfully: ${uploadedTypes}`,
          data: responseData
        });
      }
      // Support legacy format: single file with image_type field
      else if (files.image && files.image[0]) {
        if (!image_type || !['logo', 'banner'].includes(image_type)) {
          fs.unlinkSync(files.image[0].path);
          return res.status(400).json({
            success: false,
            message: 'image_type must be one of: logo, banner'
          });
        }

        // Delete old image if exists
        const oldImageField = image_type === 'logo' ? 'profile_logo_url' : 'banner_image_url';
        
        if (onlineStore[oldImageField]) {
          const oldImagePath = path.join(__dirname, '../', onlineStore[oldImageField]);
          if (fs.existsSync(oldImagePath)) {
            fs.unlinkSync(oldImagePath);
          }
        }

        // Update with new image URL
        const relativeImageUrl = `/uploads/stores/${files.image[0].filename}`;
        const legacyUpdates = { [oldImageField]: relativeImageUrl };

        // Generate themes if logo was uploaded (before DB update so we can persist them)
        let legacyThemes = null;
        if (image_type === 'logo') {
          try {
            const dominantColor = await extractDominantColor(files.image[0].path);
            legacyThemes = generateThemesFromColor(dominantColor);
            legacyUpdates.suggested_themes = legacyThemes;
          } catch (themeErr) {
            console.warn('Theme generation failed (non-fatal):', themeErr.message);
          }
        }

        await onlineStore.update(legacyUpdates);

        // Refresh the onlineStore to get updated values
        await onlineStore.reload();

        // Normalize the onlineStore data (parses social_links, converts URLs)
        const normalizedStore = normalizeOnlineStoreData(req, onlineStore);

        const legacyResponseData = {
          image_url: getFullUrl(req, relativeImageUrl),
          onlineStore: normalizedStore
        };
        if (legacyThemes) {
          legacyResponseData.suggested_themes = legacyThemes;
        }

        res.json({
          success: true,
          message: `${image_type} uploaded successfully`,
          data: legacyResponseData
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
 * Delete store image (logo, banner, or background)
 * DELETE /api/v1/stores/online/:id/image
 * Body: { image_type: 'logo' | 'banner' | 'background' }
 */
async function deleteStoreImage(req, res) {
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
        message: 'Online store not found or access denied'
      });
    }

    const { image_type } = req.body;
    const validTypes = ['logo', 'banner'];
    if (!image_type || !validTypes.includes(image_type)) {
      return res.status(400).json({
        success: false,
        message: 'image_type must be one of: logo, banner'
      });
    }

    // Map image_type to the database field name
    const fieldMap = {
      logo: 'profile_logo_url',
      banner: 'banner_image_url'
    };
    const dbField = fieldMap[image_type];

    if (!onlineStore[dbField]) {
      return res.status(404).json({
        success: false,
        message: `No ${image_type} image found to delete`
      });
    }

    // Delete the physical file from disk (only for locally uploaded files)
    const currentUrl = onlineStore[dbField];
    if (currentUrl && currentUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../', currentUrl);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Clear the URL in the database
    await onlineStore.update({ [dbField]: null });
    await onlineStore.reload();

    const normalizedStore = normalizeOnlineStoreData(req, onlineStore);

    res.json({
      success: true,
      message: `${image_type} image deleted successfully`,
      data: { onlineStore: normalizedStore }
    });
  } catch (error) {
    console.error('Error deleting store image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete store image',
      error: error.message
    });
  }
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
      variations, // Array of variation objects: [{variation_name, variation_type, is_required, options: [{value, display_name, price_adjustment, stock, sku, barcode, image_url, is_default}]}]
      variants // OPTIONAL: explicit variant combinations [{ sku, price, stock, image_url, options: [{ variation_name, option_value }] }]
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

    // Parse variants early (from form-data string or array)
    let parsedVariants = [];
    if (variants) {
      if (typeof variants === 'string') {
        try {
          parsedVariants = JSON.parse(variants);
          if (!Array.isArray(parsedVariants)) {
            parsedVariants = [];
          }
        } catch (parseError) {
          console.error('Error parsing variants JSON:', parseError);
          cleanupFiles();
          return res.status(400).json({
            success: false,
            message: 'Invalid variants JSON format. Please ensure variants is a valid JSON array.',
            error: parseError.message
          });
        }
      } else if (Array.isArray(variants)) {
        parsedVariants = variants;
      }
    }

    // Check if variations have options
    const hasVariationOptions = Array.isArray(parsedVariations) && parsedVariations.length > 0 &&
      parsedVariations.some(v => v.options && Array.isArray(v.options) && v.options.length > 0);

    // When explicit variants are provided, variation-option images are optional (variants can have their own images)
    const hasExplicitVariants = Array.isArray(parsedVariants) && parsedVariants.length > 0;

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
          message: 'Products with variations cannot have primary stock. Each variation option or variant manages its own stock level.',
          suggestion: 'Remove the "stock" parameter from your request. Stock should only be specified in the variation options or in the variants array.'
        });
      }
      if (price !== undefined && price !== null && price !== '') {
        cleanupFiles();
        return res.status(400).json({
          success: false,
          message: 'Products with variations cannot have primary price. Each variation option or variant manages its own price level.',
          suggestion: 'Remove the "price" parameter from your request. Price should only be specified in the variation options or in the variants array.'
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

    // Handle product variations if provided (support multiple variation types, e.g., Color + Size)
    if (hasVariationOptions && Array.isArray(parsedVariations) && parsedVariations.length > 0) {
      // Pre-validate: at least one variation type must have images on all its options
      // (could be Color OR Size — not necessarily the first type). Always required.
      {
        const anyVariationFullyImaged = parsedVariations.some((variationData, i) => {
          if (!variationData.options || !Array.isArray(variationData.options)) return false;
          const validOptions = variationData.options.filter(o => o && o.value);
          if (validOptions.length === 0) return false;
          return variationData.options.some((optionData, j) => {
            if (!optionData || !optionData.value) return false;
            if (optionData.image_url) return true;
            const fieldName = `variation_option_image_${i}_${j}`;
            if (req.file && (req.file.fieldname === fieldName || req.file.fieldname.startsWith(fieldName))) return true;
            if (req.files) {
              const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
              return files.some(f => f.fieldname === fieldName || f.fieldname.startsWith(fieldName));
            }
            return false;
          });
        });
        if (!anyVariationFullyImaged) {
          cleanupFiles();
          return res.status(400).json({
            success: false,
            message: 'At least one variation type must have at least one option with an image (the same image will be used for all options in that type).'
          });
        }
      }

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

        // Count images provided for this variation type and determine fallback behaviour:
        // 0 images → no fallback (another type covers it)
        // 1 image  → propagate it to all options in this type
        // 2+ images but not all → error (must be consistent — either 1 shared or all individual)
        // all have images → no fallback needed
        const resolvedTypeImages = variationData.options.map((opt, k) => {
          if (!opt || !opt.value) return null;
          if (opt.image_url) return opt.image_url;
          const fn = `variation_option_image_${i}_${k}`;
          if (req.file && (req.file.fieldname === fn || req.file.fieldname.startsWith(fn)))
            return `/uploads/product-variations/${req.file.filename}`;
          if (req.files) {
            const flist = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
            const found = flist.find(f => f.fieldname === fn || f.fieldname.startsWith(fn));
            if (found) return `/uploads/product-variations/${found.filename}`;
          }
          return null;
        });
        const imagedCount = resolvedTypeImages.filter(url => url !== null).length;
        const fallbackImageForType = imagedCount === 1 ? resolvedTypeImages.find(url => url !== null) : null;

        // Create variation options
        for (let j = 0; j < variationData.options.length; j++) {
          const optionData = variationData.options[j];
          if (!optionData.value) {
            continue; // Skip invalid options
          }

          // Handle image: uploaded file OR image_url, falling back to first image in this variation type
          let variationImageUrl = optionData.image_url || null;
          const variationImageFieldName = `variation_option_image_${i}_${j}`;

          if (req.file && (req.file.fieldname === variationImageFieldName || req.file.fieldname.startsWith(`variation_option_image_${i}_${j}`))) {
            variationImageUrl = `/uploads/product-variations/${req.file.filename}`;
          } else if (req.files) {
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

          if (!variationImageUrl && fallbackImageForType) variationImageUrl = fallbackImageForType;


          // Price and stock are only required when NOT using explicit variants.
          // With variants, price and stock live on the variant row, not on the option.
          if (!hasExplicitVariants) {
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
                suggestion: `Provide "price" in options[${j}], or pass a "variants" array to set price per combination.`
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
                suggestion: `Provide "stock" in options[${j}], or pass a "variants" array to set stock per combination.`
              });
            }
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

    // After creating variations and options, optionally create explicit product variants
    if (hasVariationOptions && Array.isArray(parsedVariants) && parsedVariants.length > 0) {
      const variationsForVariantMap = await req.db.query(
        `SELECT id, tenant_id, product_id, variation_name, variation_type, is_required, sort_order, created_at 
         FROM product_variations 
         WHERE product_id = :productId 
         ORDER BY sort_order ASC`,
        { replacements: { productId: productId }, type: QueryTypes.SELECT }
      );
      const variationMap = new Map(); // key: variation_name -> { id, optionsByValue }
      if (variationsForVariantMap && variationsForVariantMap.length > 0) {
        for (const variation of variationsForVariantMap) {
          const options = await req.db.query(
            `SELECT id, option_value, option_display_name 
             FROM product_variation_options 
             WHERE variation_id = :variationId`,
            {
              replacements: { variationId: variation.id },
              type: QueryTypes.SELECT
            }
          );
          const optionsByValue = new Map();
          for (const opt of options || []) {
            if (opt.option_value) optionsByValue.set(String(opt.option_value).toLowerCase(), opt);
            if (opt.option_display_name) optionsByValue.set(String(opt.option_display_name).toLowerCase(), opt);
          }
          variationMap.set(String(variation.variation_name).toLowerCase(), {
            id: variation.id,
            optionsByValue
          });
        }
      }

      for (const variant of parsedVariants) {
        if (!variant || !Array.isArray(variant.options) || variant.options.length === 0) continue;
        const variantOptions = [];

        for (const optRef of variant.options) {
          if (!optRef || !optRef.variation_name || !optRef.option_value) continue;
          const vKey = String(optRef.variation_name).toLowerCase();
          const vEntry = variationMap.get(vKey);
          if (!vEntry) continue;
          const valueKey = String(optRef.option_value).toLowerCase();
          const optRow = vEntry.optionsByValue.get(valueKey);
          if (!optRow) continue;
          variantOptions.push({
            variation_id: vEntry.id,
            option_id: optRow.id
          });
        }

        if (!variantOptions.length) continue;

        // Validate variant price/stock
        if (variant.price === undefined || variant.price === null || variant.price === '') {
          continue;
        }
        if (variant.stock === undefined || variant.stock === null || variant.stock === '') {
          continue;
        }

        // Insert into product_variants
        await req.db.query(
          `INSERT INTO product_variants (tenant_id, product_id, sku, barcode, price, stock, image_url, is_active, created_at, updated_at)
           VALUES (:tenantId, :productId, :sku, :barcode, :price, :stock, :imageUrl, 1, NOW(), NOW())`,
          {
            replacements: {
              tenantId: tenantId,
              productId: productId,
              sku: variant.sku || null,
              barcode: null,
              price: parseFloat(variant.price) || 0,
              stock: parseInt(variant.stock) || 0,
              imageUrl: variant.image_url || null
            },
            type: QueryTypes.INSERT
          }
        );

        const variantIdResults = await req.db.query(
          `SELECT LAST_INSERT_ID() as id`,
          {
            type: QueryTypes.SELECT
          }
        );
        const variantId = variantIdResults && variantIdResults.length > 0 && variantIdResults[0].id
          ? variantIdResults[0].id
          : null;

        if (!variantId) {
          continue;
        }

        // Link variant to chosen options
        for (const vo of variantOptions) {
          await req.db.query(
            `INSERT INTO product_variant_options (tenant_id, variant_id, variation_id, option_id, created_at)
             VALUES (:tenantId, :variantId, :variationId, :optionId, NOW())`,
            {
              replacements: {
                tenantId: tenantId,
                variantId,
                variationId: vo.variation_id,
                optionId: vo.option_id
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

    productData.variants = await fetchProductVariantsStructured(req.db, productId, (path) => getFullUrl(req, path));

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
    const { name, sku, description, price, stock, category, image_url, is_active, is_published, variations, variants, featured, sort_order } = req.body;
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

    // Parse variants (when explicit variants exist, variation-option images are optional)
    let parsedVariantsUpdate = [];
    if (variants !== undefined) {
      if (variants) {
        if (typeof variants === 'string') {
          try {
            parsedVariantsUpdate = JSON.parse(variants);
            if (!Array.isArray(parsedVariantsUpdate)) parsedVariantsUpdate = [];
          } catch (_) {
            parsedVariantsUpdate = [];
          }
        } else if (Array.isArray(variants)) {
          parsedVariantsUpdate = variants;
        }
      }
    }
    const hasExplicitVariantsUpdate = Array.isArray(parsedVariantsUpdate) && parsedVariantsUpdate.length > 0;

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
        // Pre-validate: at least one variation type must have at least one option with an image.
        // The same image is propagated to options that don't have one within that type.
        {
          const anyVariationHasImage = parsedVariations.some((variationData, i) => {
            if (!variationData.options || !Array.isArray(variationData.options)) return false;
            const validOptions = variationData.options.filter(o => o && o.value);
            if (validOptions.length === 0) return false;
            return variationData.options.some((optionData, j) => {
              if (!optionData || !optionData.value) return false;
              if (optionData.image_url) return true;
              const fieldName = `variation_option_image_${i}_${j}`;
              if (req.file && (req.file.fieldname === fieldName || req.file.fieldname.startsWith(fieldName))) return true;
              if (req.files) {
                const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
                return files.some(f => f.fieldname === fieldName || f.fieldname.startsWith(fieldName));
              }
              return false;
            });
          });
          if (!anyVariationHasImage) {
            cleanupFiles();
            return res.status(400).json({
              success: false,
              message: 'At least one variation type must have at least one option with an image (the same image will be used for all options in that type).'
            });
          }
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

          // Count images for this variation type and determine fallback behaviour:
          // 0 images → no fallback (another type covers it)
          // 1 image  → propagate it to all options in this type
          // 2+ images but not all → error (must be consistent)
          // all have images → no fallback needed
          const resolvedTypeImages = variationData.options.map((opt, k) => {
            if (!opt || !opt.value) return null;
            if (opt.image_url) return opt.image_url;
            const fn = `variation_option_image_${i}_${k}`;
            if (req.file && (req.file.fieldname === fn || req.file.fieldname.startsWith(fn)))
              return `/uploads/product-variations/${req.file.filename}`;
            if (req.files) {
              const flist = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
              const found = flist.find(f => f.fieldname === fn || f.fieldname.startsWith(fn));
              if (found) return `/uploads/product-variations/${found.filename}`;
            }
            return null;
          });
          const imagedCount = resolvedTypeImages.filter(url => url !== null).length;
          const fallbackImageForType = imagedCount === 1 ? resolvedTypeImages.find(url => url !== null) : null;

          // Create variation options
          for (let j = 0; j < variationData.options.length; j++) {
            const optionData = variationData.options[j];
            if (!optionData.value) {
              continue;
            }

            // Handle image: prioritize uploaded file over image_url, falling back to first image in this type
            let variationImageUrl = optionData.image_url || null;
            const variationImageFieldName = `variation_option_image_${i}_${j}`;

            if (req.file && (req.file.fieldname === variationImageFieldName || req.file.fieldname.startsWith(`variation_option_image_${i}_${j}`))) {
              variationImageUrl = `/uploads/product-variations/${req.file.filename}`;
            } else if (req.files) {
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

            if (!variationImageUrl && fallbackImageForType) variationImageUrl = fallbackImageForType;


            // Price and stock live on variant rows when explicit variants are provided
            if (!hasExplicitVariantsUpdate) {
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

    // If no `variations` body was sent but variation image files were uploaded,
    // update only those specific option images by matching the file's i_j position
    // to the existing variation/option order — no need to resend the full variations JSON.
    if (variations === undefined) {
      const allUploadedFiles = req.files && Array.isArray(req.files) ? req.files
        : req.files && typeof req.files === 'object' ? Object.values(req.files).flat()
        : req.file ? [req.file] : [];

      const variationImageFiles = allUploadedFiles.filter(
        f => f.fieldname && f.fieldname.startsWith('variation_option_image_')
      );

      if (variationImageFiles.length > 0) {
        const existingVariations = await req.db.query(
          `SELECT id FROM product_variations WHERE product_id = :productId ORDER BY sort_order ASC, id ASC`,
          { replacements: { productId: product_id }, type: QueryTypes.SELECT }
        );

        for (const file of variationImageFiles) {
          const match = file.fieldname.match(/^variation_option_image_(\d+)_(\d+)/);
          if (!match) continue;
          const varIdx = parseInt(match[1]);
          const optIdx = parseInt(match[2]);

          if (!existingVariations[varIdx]) continue;
          const variationId = existingVariations[varIdx].id;

          const existingOptions = await req.db.query(
            `SELECT id FROM product_variation_options WHERE variation_id = :variationId ORDER BY sort_order ASC, id ASC`,
            { replacements: { variationId }, type: QueryTypes.SELECT }
          );

          if (!existingOptions[optIdx]) continue;

          await req.db.query(
            `UPDATE product_variation_options SET image_url = :imageUrl WHERE id = :optionId`,
            {
              replacements: {
                imageUrl: `/uploads/product-variations/${file.filename}`,
                optionId: existingOptions[optIdx].id
              },
              type: QueryTypes.UPDATE
            }
          );
        }
      }
    }

    // When variants are provided, upsert product_variants and product_variant_options (replace existing)
    if (hasVariationOptions && hasExplicitVariantsUpdate && Array.isArray(parsedVariantsUpdate) && parsedVariantsUpdate.length > 0) {
      try {
        const existingVariantIds = await req.db.query(
          `SELECT id FROM product_variants WHERE product_id = :productId`,
          { replacements: { productId: product_id }, type: QueryTypes.SELECT }
        );
        if (existingVariantIds && existingVariantIds.length > 0) {
          const ids = existingVariantIds.map(r => r.id);
          await req.db.query(
            `DELETE FROM product_variant_options WHERE variant_id IN (${ids.join(',')})`,
            { type: QueryTypes.DELETE }
          );
        }
        await req.db.query(
          `DELETE FROM product_variants WHERE product_id = :productId`,
          { replacements: { productId: product_id }, type: QueryTypes.DELETE }
        );

        const variationsForVariantMap = await req.db.query(
          `SELECT id, tenant_id, product_id, variation_name, variation_type, is_required, sort_order, created_at 
           FROM product_variations 
           WHERE product_id = :productId 
           ORDER BY sort_order ASC`,
          { replacements: { productId: product_id }, type: QueryTypes.SELECT }
        );
        const variationMap = new Map();
        if (variationsForVariantMap && variationsForVariantMap.length > 0) {
          for (const variation of variationsForVariantMap) {
            const options = await req.db.query(
              `SELECT id, option_value, option_display_name 
               FROM product_variation_options 
               WHERE variation_id = :variationId`,
              { replacements: { variationId: variation.id }, type: QueryTypes.SELECT }
            );
            const optionsByValue = new Map();
            for (const opt of options || []) {
              if (opt.option_value) optionsByValue.set(String(opt.option_value).toLowerCase(), opt);
              if (opt.option_display_name) optionsByValue.set(String(opt.option_display_name).toLowerCase(), opt);
            }
            variationMap.set(String(variation.variation_name).toLowerCase(), { id: variation.id, optionsByValue });
          }
        }

        for (const variant of parsedVariantsUpdate) {
          if (!variant || !Array.isArray(variant.options) || variant.options.length === 0) {
            cleanupFiles();
            return res.status(400).json({
              success: false,
              message: 'Each variant must have an "options" array with at least one entry (variation_name and option_value).'
            });
          }
          const variantOptions = [];
          for (const optRef of variant.options) {
            if (!optRef || !optRef.variation_name || optRef.option_value === undefined || optRef.option_value === null) {
              cleanupFiles();
              return res.status(400).json({
                success: false,
                message: `Variant option is invalid: each option must have "variation_name" and "option_value". Received: ${JSON.stringify(optRef)}.`
              });
            }
            const vKey = String(optRef.variation_name).toLowerCase();
            const vEntry = variationMap.get(vKey);
            if (!vEntry) {
              cleanupFiles();
              return res.status(400).json({
                success: false,
                message: `Variation "${optRef.variation_name}" not found for this product. Check variation_name matches your variations (e.g. Color, Size).`
              });
            }
            const valueKey = String(optRef.option_value).toLowerCase();
            const optRow = vEntry.optionsByValue.get(valueKey);
            if (!optRow) {
              cleanupFiles();
              return res.status(400).json({
                success: false,
                message: `Option value "${optRef.option_value}" not found for variation "${optRef.variation_name}". Valid options: ${[...vEntry.optionsByValue.keys()].join(', ')}.`
              });
            }
            variantOptions.push({ variation_id: vEntry.id, option_id: optRow.id });
          }

          if (variant.price === undefined || variant.price === null || variant.price === '') {
            cleanupFiles();
            return res.status(400).json({
              success: false,
              message: `Variant with options ${JSON.stringify(variant.options)} is missing "price".`
            });
          }
          if (variant.stock === undefined || variant.stock === null || variant.stock === '') {
            cleanupFiles();
            return res.status(400).json({
              success: false,
              message: `Variant with options ${JSON.stringify(variant.options)} is missing "stock".`
            });
          }

          await req.db.query(
            `INSERT INTO product_variants (tenant_id, product_id, sku, barcode, price, stock, image_url, is_active, created_at, updated_at)
             VALUES (:tenantId, :productId, :sku, :barcode, :price, :stock, :imageUrl, 1, NOW(), NOW())`,
            {
              replacements: {
                tenantId: tenantId,
                productId: product_id,
                sku: variant.sku || null,
                barcode: null,
                price: parseFloat(variant.price) || 0,
                stock: parseInt(variant.stock) || 0,
                imageUrl: variant.image_url || null
              },
              type: QueryTypes.INSERT
            }
          );

          const variantIdResults = await req.db.query(
            `SELECT LAST_INSERT_ID() as id`,
            { type: QueryTypes.SELECT }
          );
          const variantId = variantIdResults && variantIdResults.length > 0 && variantIdResults[0].id ? variantIdResults[0].id : null;
          if (!variantId) {
            cleanupFiles();
            return res.status(500).json({
              success: false,
              message: 'Failed to create product variant: could not retrieve variant ID after insert.'
            });
          }

          for (const vo of variantOptions) {
            await req.db.query(
              `INSERT INTO product_variant_options (tenant_id, variant_id, variation_id, option_id, created_at)
               VALUES (:tenantId, :variantId, :variationId, :optionId, NOW())`,
              {
                replacements: {
                  tenantId: tenantId,
                  variantId,
                  variationId: vo.variation_id,
                  optionId: vo.option_id
                },
                type: QueryTypes.INSERT
              }
            );
          }
        }
      } catch (err) {
        cleanupFiles();
        console.error('Error upserting product variants on update:', err);
        return res.status(500).json({
          success: false,
          message: err.message || 'Failed to save product variants.',
          error: err.message
        });
      }
    }

    // Update StoreProduct if is_published, featured, or sort_order is provided
    if (is_published !== undefined || featured !== undefined || sort_order !== undefined) {
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
        }

        // Build update fields dynamically for all three store_product fields
        const storeProductUpdateFields = [];
        const storeProductReplacements = { storeProductId: storeProductId };

        if (is_published !== undefined) {
          storeProductUpdateFields.push('is_published = :isPublished');
          storeProductReplacements.isPublished = is_published !== false ? 1 : 0;
        }
        if (featured !== undefined) {
          storeProductUpdateFields.push('featured = :featured');
          storeProductReplacements.featured = featured ? 1 : 0;
        }
        if (sort_order !== undefined) {
          storeProductUpdateFields.push('sort_order = :sortOrder');
          storeProductReplacements.sortOrder = parseInt(sort_order) || 1;
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

    productData.variants = await fetchProductVariantsStructured(req.db, product_id, (path) => getFullUrl(req, path));

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
    // To hide without deleting, use PATCH /:id/products/:product_id/publish with { is_published: false }
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
 * PATCH /api/v1/online-stores/:id/products/:product_id/publish
 * Body: { is_published: true | false, featured?, sort_order? }
 *
 * is_published: true  → publish (or re-publish) the product on the store
 * is_published: false → hide the product from the store (keeps it in inventory)
 */
async function setOnlineStoreProductVisibility(req, res) {
  try {
    const { QueryTypes } = require('sequelize');
    const { id: online_store_id, product_id } = req.params;
    const { is_published, featured, sort_order } = req.body;
    const tenantId = req.user?.tenantId;

    if (is_published === undefined || is_published === null) {
      return res.status(400).json({ success: false, message: 'is_published (true or false) is required' });
    }

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

    // ── UNPUBLISH (hide from store, keep in inventory) ────────────────────────
    if (is_published === false || is_published === 'false') {
      await req.db.query(
        `UPDATE store_products SET is_published = 0, updated_at = NOW() WHERE product_id = :productId`,
        { replacements: { productId: product_id }, type: QueryTypes.UPDATE }
      );
      return res.json({
        success: true,
        message: 'Product hidden from online store',
        data: { product_id: parseInt(product_id), is_published: false }
      });
    }

    // ── PUBLISH (make visible / create store_products row if needed) ──────────
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

    productData.variants = await fetchProductVariantsStructured(req.db, product_id, (path) => getFullUrl(req, path));

    res.json({
      success: true,
      message: 'Product is now visible on the online store',
      data: {
        product: productData
      }
    });
  } catch (error) {
    console.error('Error updating product visibility on online store:', error);
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

    // Free users share a database — must always scope to their tenant_id
    if (isFreePlan) {
      where.tenant_id = tenantId;
    }

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

    // Get products with pagination, including publish status from store_products
    const { count, rows } = await models.Product.findAndCountAll({
      where,
      attributes: ['id', 'name', 'sku', 'price', 'image_url', 'category', 'stock', 'description', 'created_at'],
      include: [
        {
          model: models.StoreProduct,
          attributes: ['id', 'is_published', 'featured', 'sort_order'],
          required: false // LEFT JOIN - include products even if not in store_products
        }
      ],
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

    const productIds = rows.map(p => p.id);
    const variantsByProduct = await fetchVariantsForProductIds(req.db, productIds, getFullUrl);

    // Convert image_url to full URL and add publish status and variants for each product
    const products = rows.map(product => {
      const productData = product.toJSON();
      if (productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      
      // Extract publish status from StoreProduct (if exists)
      // StoreProduct is hasMany, so it could be an array or single object
      const storeProducts = productData.StoreProducts || (productData.StoreProduct ? [productData.StoreProduct] : []);
      const storeProduct = storeProducts.length > 0 ? storeProducts[0] : null;
      
      productData.is_published = storeProduct ? (storeProduct.is_published || false) : false;
      productData.featured = storeProduct ? (storeProduct.featured || false) : false;
      productData.sort_order = storeProduct ? (storeProduct.sort_order || null) : null;
      productData.variants = variantsByProduct.get(productData.id) || [];

      // Remove nested StoreProduct objects
      delete productData.StoreProduct;
      delete productData.StoreProducts;
      
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
 * Get detailed product information for online store
 * Includes all product details, variants, metrics (total orders), and publish status
 * Works for both free and enterprise users
 * GET /api/v1/online-stores/:id/products/:product_id/details
 */
async function getOnlineStoreProductDetails(req, res) {
  try {
    if (!req.db) {
      return res.status(500).json({
        success: false,
        message: 'Database connection not available'
      });
    }

    const models = initModels(req.db);
    const { id: online_store_id, product_id } = req.params;

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

    // Define Product attributes - exclude store_id for free users
    const productAttributes = isFreePlan
      ? ['id', 'tenant_id', 'name', 'description', 'sku', 'barcode', 'price', 'stock', 'low_stock_threshold', 'category', 'image_url', 'expiry_date', 'is_active', 'created_at', 'updated_at']
      : ['id', 'tenant_id', 'store_id', 'name', 'description', 'sku', 'barcode', 'price', 'cost', 'stock', 'low_stock_threshold', 'category', 'image_url', 'expiry_date', 'batch_number', 'unit_of_measure', 'is_active', 'created_at', 'updated_at'];

    // Get product with all details
    // For free users (shared DB): use findOne with tenant_id to prevent cross-tenant access
    // For enterprise users (dedicated DB): findByPk is safe
    const productWhere = { id: product_id };
    if (isFreePlan) {
      productWhere.tenant_id = tenantId;
    }

    const product = await models.Product.findOne({
      where: productWhere,
      attributes: productAttributes,
      include: [
        {
          model: models.StoreProduct,
          attributes: ['id', 'is_published', 'featured', 'sort_order', 'created_at', 'updated_at'],
          required: false
        },
        {
          model: models.ProductVariation,
          attributes: ['id', 'variation_name', 'variation_type', 'is_required', 'sort_order'],
          include: [
            {
              model: models.ProductVariationOption,
              attributes: [
                'id', 'option_value', 'option_display_name', 'price_adjustment',
                'stock', 'sku', 'image_url', 'is_default', 'is_available', 'sort_order'
              ],
              order: [['sort_order', 'ASC']]
            }
          ],
          order: [['sort_order', 'ASC']],
          required: false
        },
        // Include Store for enterprise users only (if product has store_id)
        ...(isFreePlan ? [] : [{
          model: models.Store,
          attributes: ['id', 'name', 'store_type', 'city', 'state'],
          required: false
        }])
      ]
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Get product metrics - total orders
    const { QueryTypes } = require('sequelize');
    const orderMetrics = await req.db.query(
      `SELECT 
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(oi.quantity), 0) as total_quantity_sold,
        COALESCE(SUM(oi.total), 0) as total_revenue
      FROM online_store_orders o
      INNER JOIN online_store_order_items oi ON o.id = oi.order_id
      WHERE oi.product_id = :productId
        AND o.online_store_id = :onlineStoreId
        AND o.status != 'cancelled'
        ${isFreePlan ? 'AND o.tenant_id = :tenantId' : ''}`,
      {
        replacements: {
          productId: product_id,
          onlineStoreId: online_store_id,
          ...(isFreePlan && { tenantId })
        },
        type: QueryTypes.SELECT
      }
    );

    const metrics = orderMetrics && orderMetrics.length > 0 ? orderMetrics[0] : {
      total_orders: 0,
      total_quantity_sold: 0,
      total_revenue: 0
    };

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

    // Format product data
    const productData = product.toJSON();

    // Convert image URLs to full URLs
    if (productData.image_url) {
      productData.image_url = getFullUrl(productData.image_url);
    }

    // Format variations with full image URLs
    if (productData.ProductVariations && Array.isArray(productData.ProductVariations)) {
      productData.variations = productData.ProductVariations.map(variation => {
        const variationData = {
          id: variation.id,
          variation_name: variation.variation_name,
          variation_type: variation.variation_type,
          is_required: variation.is_required,
          sort_order: variation.sort_order,
          options: []
        };

        if (variation.ProductVariationOptions && Array.isArray(variation.ProductVariationOptions)) {
          variationData.options = variation.ProductVariationOptions.map(option => ({
            id: option.id,
            value: option.option_value,
            display_name: option.option_display_name,
            price_adjustment: parseFloat(option.price_adjustment || 0),
            stock: parseInt(option.stock || 0),
            sku: option.sku,
            image_url: option.image_url ? getFullUrl(option.image_url) : null,
            is_default: option.is_default || false,
            is_available: option.is_available !== false,
            sort_order: option.sort_order
          }));
        }

        return variationData;
      });
    } else {
      productData.variations = [];
    }

    // Extract publish status from StoreProduct
    // StoreProduct is hasMany, so it's an array - get the first one
    const storeProducts = productData.StoreProducts || [];
    const storeProduct = storeProducts.length > 0 ? storeProducts[0] : null;
    
    productData.is_published = storeProduct ? (storeProduct.is_published || false) : false;
    productData.featured = storeProduct ? (storeProduct.featured || false) : false;
    productData.sort_order = storeProduct ? (storeProduct.sort_order || null) : null;
    productData.published_at = storeProduct && storeProduct.created_at ? storeProduct.created_at : null;
    productData.last_updated = storeProduct && storeProduct.updated_at ? storeProduct.updated_at : productData.updated_at;

    // Add metrics
    productData.metrics = {
      total_orders: parseInt(metrics.total_orders || 0),
      total_quantity_sold: parseFloat(metrics.total_quantity_sold || 0),
      total_revenue: parseFloat(metrics.total_revenue || 0)
    };

    productData.variants = await fetchProductVariantsStructured(req.db, product_id, getFullUrl);

    // Remove nested objects
    delete productData.StoreProducts;
    delete productData.ProductVariations;
    
    // Handle Store for enterprise users only
    if (!isFreePlan && productData.Store) {
      productData.store = productData.Store;
      delete productData.Store;
    } else if (isFreePlan) {
      // Remove store_id if it exists (shouldn't, but just in case)
      delete productData.store_id;
    }

    // Response structure:
    // {
    //   success: true,
    //   data: {
    //     product: {
    //       id, name, sku, price, stock, description, image_url, category, etc.
    //       variations: [ // ✅ Variations are included
    //         {
    //           id, variation_name, variation_type, is_required, sort_order,
    //           options: [
    //             { id, value, display_name, price_adjustment, stock, sku, image_url, is_default, is_available, sort_order }
    //           ]
    //         }
    //       ],
    //       is_published: boolean,
    //       featured: boolean,
    //       sort_order: number,
    //       published_at: date,
    //       last_updated: date,
    //       metrics: {
    //         total_orders: number,
    //         total_quantity_sold: number,
    //         total_revenue: number
    //       },
    //       store: { ... } // Only for enterprise users
    //     }
    //   }
    // }

    res.json({
      success: true,
      data: {
        product: productData // ✅ Includes variations, metrics, publish status - works for both free and enterprise users
      }
    });
  } catch (error) {
    console.error('Error getting online store product details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product details',
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

    // CRITICAL: Determine if this is a free plan user
    // Free users: ALWAYS have tenantId, use shared database, store_products/store_services tables DON'T have online_store_id
    // Enterprise users: separate database, may have online_store_id in store_products/store_services
    // SAFETY: If tenantId exists, we MUST treat as free user to avoid online_store_id errors
    const isFreePlan = req.tenant?.subscription_plan === 'free' || (req.user?.tenantId && (!req.tenant || req.tenant.subscription_plan !== 'enterprise'));
    
    // ABSOLUTE SAFETY: If tenantId exists, force free user mode (defensive programming)
    // This prevents ANY Sequelize StoreProduct/StoreService queries from using online_store_id
    const forceFreeUser = !!req.user?.tenantId;
    
    // Log for debugging
    console.log('[getStorePreview] Plan detection:', {
      isFreePlan,
      forceFreeUser,
      hasTenantId: !!req.user?.tenantId,
      subscriptionPlan: req.tenant?.subscription_plan,
      tenantId: req.user?.tenantId
    });

    // Get user's online store (can be unpublished for preview)
    const onlineStore = await models.OnlineStore.findOne({
      where: {
        // For free users, filter by tenant_id; for enterprise, no filter needed (separate DB)
        ...(isFreePlan && req.user.tenantId
          ? { tenant_id: req.user.tenantId } 
          : {})
      },
      include: [
        {
          model: models.OnlineStoreLocation,
          include: [{
            model: models.Store,
            attributes: ['id', 'name', 'address', 'city', 'state', 'country', 'phone']
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
    
    // Parse social_links if it's a string (JSON stored as string in database)
    if (storeData.social_links) {
      if (typeof storeData.social_links === 'string') {
        try {
          storeData.social_links = JSON.parse(storeData.social_links);
        } catch (e) {
          console.error('[getStorePreview] Error parsing social_links:', e);
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
    
    // Normalize store image URLs
    if (storeData.profile_logo_url) storeData.profile_logo_url = getFullUrl(storeData.profile_logo_url);
    if (storeData.banner_image_url) storeData.banner_image_url = getFullUrl(storeData.banner_image_url);

    // Parse selected_theme if stored as a JSON string
    if (storeData.selected_theme && typeof storeData.selected_theme === 'string') {
      try { storeData.selected_theme = JSON.parse(storeData.selected_theme); } catch (e) { storeData.selected_theme = null; }
    }

    // Check if products and services exist to determine toggle visibility
    // Can preview even if not published
    // CRITICAL: For free users, store_products table does NOT have online_store_id column
    // We MUST use raw SQL for ALL StoreProduct queries for free users
    // isFreePlan is already determined above with defensive checks
    // Only select columns that exist in the database (exclude seo_title, seo_description, seo_keywords for free users)
    const storeProductAttributes = isFreePlan
      ? ['id', 'tenant_id', 'product_id', 'is_published', 'featured', 'sort_order', 'created_at', 'updated_at']
      : ['id', 'tenant_id', 'product_id', 'is_published', 'featured', 'sort_order', 'created_at', 'updated_at', 'seo_title', 'seo_description', 'seo_keywords'];
    
    // Define Product attributes - only include columns that exist in the database
    // For free users: products table has: id, tenant_id, name, description, sku, barcode, price, cost_price, stock, low_stock_threshold, category, image_url, expiry_date, is_active, created_at, updated_at
    // Note: The model defines 'cost' but database has 'cost_price' - no field mapping exists, so we can't use 'cost'
    // Note: batch_number, unit_of_measure, store_id don't exist in the products table for free users
    // For free users, only include columns that actually exist in the database
    const productAttributes = isFreePlan
      ? ['id', 'tenant_id', 'name', 'description', 'sku', 'barcode', 'price', 'stock', 'low_stock_threshold', 'category', 'image_url', 'expiry_date', 'is_active', 'created_at', 'updated_at']
      : ['id', 'tenant_id', 'store_id', 'name', 'description', 'sku', 'barcode', 'price', 'cost', 'stock', 'low_stock_threshold', 'category', 'image_url', 'expiry_date', 'batch_number', 'unit_of_measure', 'is_active', 'created_at', 'updated_at'];
    
    // CRITICAL: For free users, ALWAYS use raw SQL - NEVER use Sequelize StoreProduct queries
    // Sequelize will try to use online_store_id from the model definition even if we specify tenant_id
    // ABSOLUTE SAFETY: If tenantId exists, ALWAYS use raw SQL (store_products doesn't have online_store_id for free users)
    const useRawSQL = forceFreeUser || isFreePlan;
    
    console.log('[getStorePreview] useRawSQL decision:', {
      useRawSQL,
      forceFreeUser,
      isFreePlan,
      tenantId: req.user?.tenantId
    });
    
    let hasProducts = false;
    if (useRawSQL) {
      // Free users: MUST use raw SQL - store_products table doesn't have online_store_id
      try {
        if (!req.user?.tenantId) {
          console.warn('[getStorePreview] Warning: useRawSQL is true but tenantId is missing');
          hasProducts = false;
        } else {
          const [result] = await req.db.query(`
            SELECT COUNT(*) as count
            FROM store_products sp
            INNER JOIN products p ON sp.product_id = p.id
            WHERE sp.tenant_id = :tenantId
              AND p.is_active = 1
          `, {
            replacements: { tenantId: req.user.tenantId },
            type: Sequelize.QueryTypes.SELECT
          });
          hasProducts = (parseInt(result?.count || 0) > 0);
        }
      } catch (error) {
        console.error('[getStorePreview] Error checking products for free user:', error);
        hasProducts = false;
      }
    } else {
      // Enterprise users: can use Sequelize with online_store_id
      // BUT: Double-check we're not accidentally calling this for free users
      if (req.user?.tenantId) {
        console.error('[getStorePreview] ERROR: useRawSQL is false but tenantId exists! This should not happen for free users.');
        // Fallback to raw SQL to prevent error
        try {
          const [result] = await req.db.query(`
            SELECT COUNT(*) as count
            FROM store_products sp
            INNER JOIN products p ON sp.product_id = p.id
            WHERE sp.tenant_id = :tenantId
              AND p.is_active = 1
          `, {
            replacements: { tenantId: req.user.tenantId },
            type: Sequelize.QueryTypes.SELECT
          });
          hasProducts = (parseInt(result?.count || 0) > 0);
        } catch (error) {
          console.error('[getStorePreview] Error in fallback raw SQL:', error);
          hasProducts = false;
        }
      } else {
        hasProducts = await models.StoreProduct.count({
          where: { online_store_id: onlineStore.id },
          include: [{
            model: models.Product,
            where: { is_active: true },
            required: true,
            attributes: productAttributes
          }]
        }) > 0;
      }
    }

    // Check if services exist - for free users, filter by tenant_id and online_store_id via join
    // Note: store_services table doesn't have online_store_id, but online_store_services does
    let hasServices = false;
    if (useRawSQL) {
      const [servicesResult] = await req.db.query(`
        SELECT COUNT(*) as count
        FROM store_services ss
        INNER JOIN online_store_services oss ON ss.id = oss.service_id
        WHERE ss.is_active = 1
          AND oss.online_store_id = :onlineStoreId
          AND oss.is_visible = 1
          AND ss.tenant_id = :tenantId
      `, {
        replacements: { onlineStoreId: onlineStore.id, tenantId: req.user.tenantId },
        type: Sequelize.QueryTypes.SELECT
      });
      hasServices = (parseInt(servicesResult?.count || 0) > 0);
    } else {
      hasServices = await models.StoreService.count({
        where: {
          is_active: true,
          '$OnlineStoreServices.online_store_id$': onlineStore.id
        },
        include: [{
          model: models.OnlineStoreService,
          where: {
            online_store_id: onlineStore.id,
            is_visible: true
          },
          required: true,
          attributes: []
        }]
      }) > 0;
    }

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
              where: {
                is_active: true,
                ...(useRawSQL ? { tenant_id: req.user.tenantId } : {})
              },
              required: false,
              attributes: useRawSQL
                ? ['id', 'name', 'sku', 'price', 'image_url', 'category']
                : ['id', 'name', 'sku', 'price', 'image_url', 'category', 'store_id']
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
              where: {
                is_active: true,
                ...(useRawSQL ? { tenant_id: req.user.tenantId } : {})
              },
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
    // For free users: MUST use raw SQL (store_products doesn't have online_store_id, Sequelize will fail)
    // For enterprise users: can use Sequelize with online_store_id
    let productsNotInCollections = [];
    if (useRawSQL) {
      // Free users: use raw SQL to avoid online_store_id issues
      const productsResult = await req.db.query(`
        SELECT DISTINCT sp.id, sp.tenant_id, sp.product_id, sp.is_published, sp.featured, sp.sort_order, sp.created_at, sp.updated_at,
               p.id as 'Product.id', p.tenant_id as 'Product.tenant_id', p.name as 'Product.name', 
               p.description as 'Product.description', p.sku as 'Product.sku', p.barcode as 'Product.barcode',
               p.price as 'Product.price', p.stock as 'Product.stock', p.low_stock_threshold as 'Product.low_stock_threshold',
               p.category as 'Product.category', p.image_url as 'Product.image_url', p.expiry_date as 'Product.expiry_date',
               p.is_active as 'Product.is_active', p.created_at as 'Product.created_at', p.updated_at as 'Product.updated_at'
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
        LEFT JOIN store_collection_products scp ON p.id = scp.product_id
        WHERE sp.tenant_id = :tenantId
          AND p.tenant_id = :tenantId
          AND p.is_active = 1
          AND scp.id IS NULL
        ORDER BY sp.created_at DESC
        LIMIT :limit
      `, {
        replacements: { tenantId: req.user.tenantId, limit: previewLimit },
        type: Sequelize.QueryTypes.SELECT
      });
      
      // Transform raw results to match Sequelize format
      productsNotInCollections = productsResult.map(row => {
        const sp = {
          id: row.id,
          tenant_id: row.tenant_id,
          product_id: row.product_id,
          is_published: row.is_published,
          featured: row.featured,
          sort_order: row.sort_order,
          created_at: row.created_at,
          updated_at: row.updated_at,
          Product: {
            id: row['Product.id'],
            tenant_id: row['Product.tenant_id'],
            name: row['Product.name'],
            description: row['Product.description'],
            sku: row['Product.sku'],
            barcode: row['Product.barcode'],
            price: row['Product.price'],
            stock: row['Product.stock'],
            low_stock_threshold: row['Product.low_stock_threshold'],
            category: row['Product.category'],
            image_url: row['Product.image_url'],
            expiry_date: row['Product.expiry_date'],
            is_active: row['Product.is_active'],
            created_at: row['Product.created_at'],
            updated_at: row['Product.updated_at']
          }
        };
        // Add toJSON method for compatibility
        sp.toJSON = () => sp;
        sp.Product.toJSON = () => sp.Product;
        return sp;
      });
    } else {
      // Enterprise users: can use Sequelize
      productsNotInCollections = await models.StoreProduct.findAll({
        where: {
          online_store_id: onlineStore.id,
          '$Product.StoreCollectionProducts.id$': { [Op.eq]: null }
        },
        attributes: storeProductAttributes,
        include: [
          {
            model: models.Product,
            where: { is_active: true },
            required: true,
            attributes: productAttributes,
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
    }

    // Get services NOT in any collection (preview)
    // For free users: filter by tenant_id in online_store_services (store_services doesn't have online_store_id)
    // For enterprise users: filter by online_store_id
    let servicesNotInCollections = [];
    if (useRawSQL) {
      // Free users: use raw SQL to ensure we filter correctly
      const servicesResult = await req.db.query(`
        SELECT DISTINCT ss.id, ss.tenant_id, ss.service_title, ss.description, ss.price, ss.service_image_url, 
               ss.duration_minutes, ss.is_active, ss.created_at, ss.updated_at
        FROM store_services ss
        INNER JOIN online_store_services oss ON ss.id = oss.service_id
        LEFT JOIN store_collection_services scs ON ss.id = scs.service_id
        WHERE ss.is_active = 1
          AND oss.online_store_id = :onlineStoreId
          AND oss.is_visible = 1
          AND ss.tenant_id = :tenantId
          AND scs.id IS NULL
        ORDER BY ss.created_at DESC
        LIMIT :limit
      `, {
        replacements: { onlineStoreId: onlineStore.id, tenantId: req.user.tenantId, limit: previewLimit },
        type: Sequelize.QueryTypes.SELECT
      });
      
      // Transform raw results to match Sequelize format
      servicesNotInCollections = servicesResult.map(row => {
        const service = {
          id: row.id,
          tenant_id: row.tenant_id,
          service_title: row.service_title,
          description: row.description,
          price: row.price,
          service_image_url: row.service_image_url,
          duration_minutes: row.duration_minutes,
          is_active: row.is_active,
          created_at: row.created_at,
          updated_at: row.updated_at
        };
        service.toJSON = () => service;
        return service;
      });
    } else {
      // Enterprise users: can use Sequelize
      servicesNotInCollections = await models.StoreService.findAll({
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
    }

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
    // For free users: filter by tenant_id (store_products doesn't have online_store_id)
    // For enterprise users: filter by online_store_id if column exists, otherwise by tenant_id
    let totalProductsNotInCollections = 0;
    try {
      const whereClause = useRawSQL
        ? `sp.tenant_id = :tenantId`
        : `sp.online_store_id = :onlineStoreId`;
      const replacements = useRawSQL
        ? { tenantId: req.user.tenantId }
        : { onlineStoreId: onlineStore.id };
      
      const productsNotInCollectionsCountResult = await req.db.query(`
        SELECT COUNT(DISTINCT sp.id) as count
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
        LEFT JOIN store_collection_products scp ON p.id = scp.product_id
        WHERE ${whereClause}
          AND p.is_active = 1
          AND scp.id IS NULL
      `, {
        replacements: replacements,
        type: Sequelize.QueryTypes.SELECT
      });
      // Query returns array of results, get first element's count
      totalProductsNotInCollections = parseInt(productsNotInCollectionsCountResult?.[0]?.count || 0);
    } catch (queryError) {
      console.error('Error counting products not in collections:', queryError);
      // Fallback: use raw query for free users, Sequelize for enterprise
      try {
        if (useRawSQL) {
          // Use raw query for free users to avoid model field issues (online_store_id doesn't exist)
          const [fallbackResult] = await req.db.query(`
            SELECT COUNT(DISTINCT sp.id) as count
            FROM store_products sp
            INNER JOIN products p ON sp.product_id = p.id
            LEFT JOIN store_collection_products scp ON p.id = scp.product_id
            WHERE sp.tenant_id = :tenantId
              AND p.is_active = 1
              AND scp.id IS NULL
          `, {
            replacements: { tenantId: req.user.tenantId },
            type: Sequelize.QueryTypes.SELECT
          });
          totalProductsNotInCollections = parseInt(fallbackResult?.count || 0);
        } else {
          // Enterprise users can use Sequelize
          totalProductsNotInCollections = await models.StoreProduct.count({
            where: { online_store_id: onlineStore.id },
            attributes: storeProductAttributes, // Only select columns that exist in the database
            include: [{
              model: models.Product,
              where: { is_active: true },
              required: true,
              attributes: productAttributes, // Only select columns that exist in the database
              include: [{
                model: models.StoreCollectionProduct,
                required: false,
                attributes: []
              }]
            }],
            having: Sequelize.literal('COUNT(StoreCollectionProducts.id) = 0')
          });
        }
      } catch (fallbackError) {
        console.error('Fallback count also failed:', fallbackError);
        totalProductsNotInCollections = 0;
      }
    }

    // Count services not in collections (linked to this online store)
    let totalServicesNotInCollections = 0;
    try {
      const servicesNotInCollectionsCountResult = await req.db.query(`
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
      // Query returns array of results, get first element's count
      totalServicesNotInCollections = parseInt(servicesNotInCollectionsCountResult?.[0]?.count || 0);
    } catch (queryError) {
      console.error('Error counting services not in collections:', queryError);
      // Fallback: use Sequelize count
      try {
        totalServicesNotInCollections = await models.StoreService.count({
          where: {
            is_active: true
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
          having: Sequelize.literal('COUNT(StoreCollectionServices.id) = 0')
        });
      } catch (fallbackError) {
        console.error('Fallback count also failed:', fallbackError);
        totalServicesNotInCollections = 0;
      }
    }

    // Collect all product IDs across collections + standalone products for batch variation/variant fetch
    const allPreviewProductIds = [];
    for (const col of productCollections) {
      const colData = col && typeof col.toJSON === 'function' ? col.toJSON() : col;
      for (const cp of (colData.StoreCollectionProducts || [])) {
        const cpData = cp && typeof cp.toJSON === 'function' ? cp.toJSON() : cp;
        const pid = cpData.Product?.id || cpData.product_id;
        if (pid) allPreviewProductIds.push(pid);
      }
    }
    for (const sp of productsNotInCollections) {
      const productData = sp.Product ? (typeof sp.Product.toJSON === 'function' ? sp.Product.toJSON() : sp.Product) : sp;
      if (productData?.id) allPreviewProductIds.push(productData.id);
    }

    // Batch-fetch variations and variants for all products
    const previewVariantsByProduct = await fetchVariantsForProductIds(req.db, allPreviewProductIds, getFullUrl);

    // Batch-fetch variations (product_variations + options) for preview
    const previewVariationsByProduct = new Map();
    if (allPreviewProductIds.length > 0) {
      const uniquePreviewIds = [...new Set(allPreviewProductIds)].filter(Boolean);
      const placeholders = uniquePreviewIds.map(() => '?').join(',');
      const varRows = await req.db.query(
        `SELECT pv.id, pv.product_id, pv.variation_name, pv.sort_order,
                pvo.id AS option_id, pvo.option_value, pvo.option_display_name, pvo.sort_order AS opt_sort
         FROM product_variations pv
         LEFT JOIN product_variation_options pvo ON pvo.variation_id = pv.id
         WHERE pv.product_id IN (${placeholders})
         ORDER BY pv.product_id, pv.sort_order, pvo.sort_order`,
        { replacements: uniquePreviewIds, type: require('sequelize').QueryTypes.SELECT }
      );
      for (const r of varRows || []) {
        const pid = r.product_id;
        if (!previewVariationsByProduct.has(pid)) previewVariationsByProduct.set(pid, new Map());
        const byVar = previewVariationsByProduct.get(pid);
        if (!byVar.has(r.id)) {
          byVar.set(r.id, { id: r.id, variation_name: r.variation_name, sort_order: r.sort_order, options: [] });
        }
        if (r.option_id != null) {
          byVar.get(r.id).options.push({
            id: r.option_id,
            option_value: r.option_value != null ? String(r.option_value) : null,
            option_display_name: r.option_display_name || r.option_value || null,
            sort_order: r.opt_sort
          });
        }
      }
    }

    // Normalize collection data
    // Handles both Sequelize instances (with .toJSON()) and plain objects (from raw SQL)
    const normalizeCollection = (collection) => {
      // Handle both Sequelize instances and plain objects
      const collectionData = collection && typeof collection.toJSON === 'function'
        ? collection.toJSON()
        : collection;

      if (collectionData.StoreCollectionProducts) {
        collectionData.StoreCollectionProducts = collectionData.StoreCollectionProducts.map(cp => {
          // Handle both Sequelize instances and plain objects
          const cpData = cp && typeof cp.toJSON === 'function' ? cp.toJSON() : cp;
          const productData = cpData.Product
            ? (cpData.Product && typeof cpData.Product.toJSON === 'function'
                ? cpData.Product.toJSON()
                : cpData.Product)
            : null;

          if (productData && productData.image_url) {
            productData.image_url = getFullUrl(productData.image_url);
          }
          if (productData) {
            const pid = productData.id;
            productData.variations = previewVariationsByProduct.has(pid)
              ? Array.from(previewVariationsByProduct.get(pid).values())
              : [];
            productData.variants = previewVariantsByProduct.get(pid) || [];
          }
          return {
            ...cpData,
            Product: productData
          };
        });
      }
      if (collectionData.StoreCollectionServices) {
        collectionData.StoreCollectionServices = collectionData.StoreCollectionServices.map(cs => {
          // Handle both Sequelize instances and plain objects
          const csData = cs && typeof cs.toJSON === 'function' ? cs.toJSON() : cs;
          const serviceData = csData.StoreService
            ? (csData.StoreService && typeof csData.StoreService.toJSON === 'function'
                ? csData.StoreService.toJSON()
                : csData.StoreService)
            : null;

          if (serviceData && serviceData.service_image_url) {
            serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
          }
          return {
            ...csData,
            StoreService: serviceData
          };
        });
      }
      return collectionData;
    };

    // Normalize products (handle both Sequelize and raw SQL results)
    const normalizedProducts = productsNotInCollections.map(sp => {
      // Handle both Sequelize instances and raw SQL results
      const productData = sp.Product ? (typeof sp.Product.toJSON === 'function' ? sp.Product.toJSON() : sp.Product) : sp;
      if (productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      const pid = productData.id;
      productData.variations = previewVariationsByProduct.has(pid)
        ? Array.from(previewVariationsByProduct.get(pid).values())
        : [];
      productData.variants = previewVariantsByProduct.get(pid) || [];
      return productData;
    });

    // Normalize services
    // Handle both Sequelize instances and plain objects (from raw SQL)
    const normalizedServices = servicesNotInCollections.map(service => {
      const serviceData = service && typeof service.toJSON === 'function' 
        ? service.toJSON() 
        : service;
      if (serviceData && serviceData.service_image_url) {
        serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
      }
      return serviceData;
    });

    // Build contact info: phone from default (or first) linked physical store
    const previewStorePhone = (() => {
      const locations = storeData.OnlineStoreLocations || [];
      if (!locations.length) return null;
      const defaultLoc = locations.find(l => l.is_default) || locations[0];
      return defaultLoc?.Store?.phone || null;
    })();

    const previewStoreAddress = {
      state: storeData.state || null,
      country: storeData.country || null
    };

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
          selected_theme: storeData.selected_theme || null,
          social_links: storeData.social_links,
          show_social_icons: storeData.show_social_icons !== false,
          is_location_based: storeData.is_location_based,
          show_location: storeData.show_location,
          allow_delivery_datetime: storeData.allow_delivery_datetime,
          address: previewStoreAddress,
          phone_number: previewStorePhone,
          is_published: storeData.is_published,
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
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to get store preview',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      ...(process.env.NODE_ENV === 'development' && { 
        stack: error.stack,
        details: {
          hasDb: !!req.db,
          hasModels: !!req.db?.models,
          hasUser: !!req.user,
          tenantId: req.user?.tenantId
        }
      })
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
    const { search, collection_id, page = 1, limit = 20 } = req.query;

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
    const { Sequelize } = require('sequelize');
    
    // Determine if this is a free user (for raw SQL queries)
    const isFreePlan = req.tenant?.subscription_plan === 'free' || !!req.user?.tenantId;

    // Get ALL services for this online store (with optional collection filter)
    // Can preview even if not visible
    // For free users: use raw SQL to avoid online_store_id issues
    let count, rows;
    
    if (isFreePlan) {
      // Free users: use raw SQL
      let query = `
        SELECT DISTINCT ss.id, ss.tenant_id, ss.service_title, ss.description, ss.price, ss.service_image_url, 
               ss.duration_minutes, ss.is_active, ss.created_at, ss.updated_at
        FROM store_services ss
        INNER JOIN online_store_services oss ON ss.id = oss.service_id
      `;
      
      const replacements = { 
        onlineStoreId: onlineStore.id,
        tenantId: req.user.tenantId
      };
      
      // Add collection filter if provided
      if (collection_id) {
        query += ` INNER JOIN store_collection_services scs ON ss.id = scs.service_id AND scs.collection_id = :collectionId`;
        replacements.collectionId = collection_id;
      }
      
      query += ` WHERE ss.is_active = 1 AND oss.online_store_id = :onlineStoreId AND ss.tenant_id = :tenantId AND oss.is_visible = 1`;
      
      // Add search filter
      if (search) {
        query += ` AND (ss.service_title LIKE :search OR ss.description LIKE :search)`;
        replacements.search = `%${search}%`;
      }
      
      query += ` ORDER BY ss.created_at DESC LIMIT :limit OFFSET :offset`;
      replacements.limit = limitNum;
      replacements.offset = offset;
      
      // Get count
      let countQuery = `
        SELECT COUNT(DISTINCT ss.id) as count
        FROM store_services ss
        INNER JOIN online_store_services oss ON ss.id = oss.service_id
      `;
      
      if (collection_id) {
        countQuery += ` INNER JOIN store_collection_services scs ON ss.id = scs.service_id AND scs.collection_id = :collectionId`;
      }
      
      countQuery += ` WHERE ss.is_active = 1 AND oss.online_store_id = :onlineStoreId AND ss.tenant_id = :tenantId AND oss.is_visible = 1`;
      
      if (search) {
        countQuery += ` AND (ss.service_title LIKE :search OR ss.description LIKE :search)`;
      }
      
      const [countResult] = await req.db.query(countQuery, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });
      
      const serviceRows = await req.db.query(query, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });
      
      // Transform raw results to match Sequelize format
      rows = serviceRows.map(row => {
        const service = {
          id: row.id,
          tenant_id: row.tenant_id,
          service_title: row.service_title,
          description: row.description,
          price: row.price,
          service_image_url: row.service_image_url,
          duration_minutes: row.duration_minutes,
          is_active: row.is_active,
          created_at: row.created_at,
          updated_at: row.updated_at
        };
        service.toJSON = () => service;
        return service;
      });
      
      count = parseInt(countResult?.count || 0);
    } else {
      // Enterprise users: use Sequelize
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

      const result = await models.StoreService.findAndCountAll({
        where,
        include: includeClause,
        order: [['created_at', 'DESC']],
        limit: limitNum,
        offset: offset,
        distinct: true
      });
      
      count = result.count;
      rows = result.rows;
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

    // Normalize services - handle both Sequelize instances and plain objects
    const services = rows.map(service => {
      const serviceData = service && typeof service.toJSON === 'function' 
        ? service.toJSON() 
        : service;
      if (serviceData && serviceData.service_image_url) {
        serviceData.service_image_url = getFullUrl(serviceData.service_image_url);
      }
      return serviceData;
    });

    // Calculate total count
    const totalCount = typeof count === 'number' ? count : (Array.isArray(count) ? count.length : 0);

    res.json({
      success: true,
      data: { 
        services,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(totalCount / limitNum),
          total_items: totalCount
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

    // Determine if this is a free user (for raw SQL queries)
    const isFreePlan = req.tenant?.subscription_plan === 'free' || !!req.user?.tenantId;
    const { Sequelize } = require('sequelize');

    // Get service (linked to this online store)
    // For free users: use raw SQL to ensure tenant_id is checked
    let service;
    
    if (isFreePlan) {
      // Free users: use raw SQL
      const serviceRows = await req.db.query(`
        SELECT ss.id, ss.tenant_id, ss.service_title, ss.description, ss.price, ss.service_image_url, 
               ss.duration_minutes, ss.is_active, ss.created_at, ss.updated_at
        FROM store_services ss
        INNER JOIN online_store_services oss ON ss.id = oss.service_id
        WHERE ss.id = :serviceId
          AND ss.is_active = 1
          AND oss.online_store_id = :onlineStoreId
          AND ss.tenant_id = :tenantId
          AND oss.is_visible = 1
        LIMIT 1
      `, {
        replacements: { 
          serviceId: service_id,
          onlineStoreId: onlineStore.id,
          tenantId: req.user.tenantId
        },
        type: Sequelize.QueryTypes.SELECT
      });

      if (!serviceRows || serviceRows.length === 0 || !serviceRows[0]) {
        return res.status(404).json({
          success: false,
          message: 'Service not found'
        });
      }

      const row = serviceRows[0];
      if (!row || !row.id) {
        return res.status(404).json({
          success: false,
          message: 'Service not found'
        });
      }

      service = {
        id: row.id,
        tenant_id: row.tenant_id,
        service_title: row.service_title,
        description: row.description,
        price: row.price,
        service_image_url: row.service_image_url,
        duration_minutes: row.duration_minutes,
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
      service.toJSON = () => service;
    } else {
      // Enterprise users: use Sequelize
      service = await models.StoreService.findOne({
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

    // Handle both Sequelize instances and plain objects
    const serviceData = service && typeof service.toJSON === 'function' 
      ? service.toJSON() 
      : service;
    if (serviceData && serviceData.service_image_url) {
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
    const { search, category, collection_id, page = 1, limit = 20 } = req.query;

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
    const { Sequelize } = require('sequelize');
    
    // Determine if this is a free user (for raw SQL queries)
    const isFreePlan = req.tenant?.subscription_plan === 'free' || !!req.user?.tenantId;

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

    // Note: Removed store_id filter - enterprise users can only have one online store
    // Products are already linked to the online store via StoreProduct

    // Build StoreProduct where clause
    // For free users: use tenant_id (store_products doesn't have online_store_id)
    // For enterprise users: use online_store_id
    const storeProductWhere = isFreePlan
      ? { tenant_id: req.user.tenantId }
      : { online_store_id: onlineStore.id };

    // If collection_id is provided, filter products in that collection
    // This will be handled in the query below

    // Get ALL products for this online store (with optional collection filter)
    // Can preview even if not published
    // For free users: use raw SQL to avoid online_store_id issues
    let count, rows;
    
    if (isFreePlan) {
      // Free users: use raw SQL
      let query = `
        SELECT DISTINCT sp.id, sp.tenant_id, sp.product_id, sp.is_published, sp.featured, sp.sort_order, sp.created_at, sp.updated_at,
               p.id as 'Product.id', p.tenant_id as 'Product.tenant_id', p.name as 'Product.name', 
               p.description as 'Product.description', p.sku as 'Product.sku', p.barcode as 'Product.barcode',
               p.price as 'Product.price', p.stock as 'Product.stock', p.low_stock_threshold as 'Product.low_stock_threshold',
               p.category as 'Product.category', p.image_url as 'Product.image_url', p.expiry_date as 'Product.expiry_date',
               p.is_active as 'Product.is_active', p.created_at as 'Product.created_at', p.updated_at as 'Product.updated_at'
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
      `;
      
      const replacements = { tenantId: req.user.tenantId };
      
      // Add collection filter if provided
      if (collection_id) {
        query += ` INNER JOIN store_collection_products scp ON p.id = scp.product_id AND scp.collection_id = :collectionId`;
        replacements.collectionId = collection_id;
      }
      
      query += ` WHERE sp.tenant_id = :tenantId AND p.tenant_id = :tenantId AND p.is_active = 1`;

      // Add search filter
      if (search) {
        query += ` AND (p.name LIKE :search OR p.sku LIKE :search)`;
        replacements.search = `%${search}%`;
      }

      // Add category filter
      if (category) {
        query += ` AND p.category = :category`;
        replacements.category = category;
      }
      
      query += ` ORDER BY sp.created_at DESC LIMIT :limit OFFSET :offset`;
      replacements.limit = limitNum;
      replacements.offset = offset;
      
      // Get count
      let countQuery = `
        SELECT COUNT(DISTINCT sp.id) as count
        FROM store_products sp
        INNER JOIN products p ON sp.product_id = p.id
      `;
      
      if (collection_id) {
        countQuery += ` INNER JOIN store_collection_products scp ON p.id = scp.product_id AND scp.collection_id = :collectionId`;
      }
      
      countQuery += ` WHERE sp.tenant_id = :tenantId AND p.is_active = 1`;
      
      if (search) {
        countQuery += ` AND (p.name LIKE :search OR p.sku LIKE :search)`;
      }
      
      if (category) {
        countQuery += ` AND p.category = :category`;
      }
      
      const [countResult] = await req.db.query(countQuery, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });
      
      const productRows = await req.db.query(query, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });
      
      // Transform raw results to match Sequelize format
      rows = productRows.map(row => {
        const sp = {
          id: row.id,
          tenant_id: row.tenant_id,
          product_id: row.product_id,
          is_published: row.is_published,
          featured: row.featured,
          sort_order: row.sort_order,
          created_at: row.created_at,
          updated_at: row.updated_at,
          Product: {
            id: row['Product.id'],
            tenant_id: row['Product.tenant_id'],
            name: row['Product.name'],
            description: row['Product.description'],
            sku: row['Product.sku'],
            barcode: row['Product.barcode'],
            price: row['Product.price'],
            stock: row['Product.stock'],
            low_stock_threshold: row['Product.low_stock_threshold'],
            category: row['Product.category'],
            image_url: row['Product.image_url'],
            expiry_date: row['Product.expiry_date'],
            is_active: row['Product.is_active'],
            created_at: row['Product.created_at'],
            updated_at: row['Product.updated_at']
          }
        };
        sp.toJSON = () => sp;
        sp.Product.toJSON = () => sp.Product;
        return sp;
      });
      
      count = [{ count: parseInt(countResult?.count || 0) }];
    } else {
      // Enterprise users: use Sequelize
      const includeClause = [
        {
          model: models.Product,
          where: productWhere,
          required: true,
          include: []
        }
      ];
      
      // Add collection filter if provided
      if (collection_id) {
        includeClause[0].include.push({
          model: models.StoreCollectionProduct,
          where: { collection_id },
          required: true,
          attributes: ['id', 'collection_id']
        });
      }
      
      const result = await models.StoreProduct.findAndCountAll({
        where: storeProductWhere,
        include: includeClause,
        limit: limitNum,
        offset: offset,
        order: [['created_at', 'DESC']],
        subQuery: false,
        group: ['StoreProduct.id'],
        distinct: true
      });
      
      count = result.count;
      rows = result.rows;
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

    // Normalize products - handle both Sequelize instances and plain objects
    const productIds = [];
    const products = rows.map(sp => {
      const productData = sp.Product && typeof sp.Product.toJSON === 'function'
        ? sp.Product.toJSON()
        : (sp.Product || sp);
      if (productData && productData.image_url) {
        productData.image_url = getFullUrl(productData.image_url);
      }
      if (productData && productData.id) productIds.push(productData.id);

      // Attach store_product visibility metadata
      productData.is_published = sp.is_published != null ? sp.is_published : false;
      productData.featured = sp.featured != null ? sp.featured : false;
      productData.sort_order = sp.sort_order != null ? sp.sort_order : null;

      return productData;
    });

    // Batch-fetch variants for all products
    const variantsByProduct = await fetchVariantsForProductIds(req.db, productIds, getFullUrl);
    products.forEach(p => { p.variants = variantsByProduct.get(p.id) || []; });

    // Calculate total count
    const totalCount = Array.isArray(count) ? count[0]?.count || count.length : count;

    // Attach variations to each product
    const previewProdVariationsByProduct = new Map();
    if (productIds.length > 0) {
      const uniqueProdIds = [...new Set(productIds)].filter(Boolean);
      const pholds = uniqueProdIds.map(() => '?').join(',');
      const varRows = await req.db.query(
        `SELECT pv.id, pv.product_id, pv.variation_name, pv.sort_order,
                pvo.id AS option_id, pvo.option_value, pvo.option_display_name, pvo.sort_order AS opt_sort
         FROM product_variations pv
         LEFT JOIN product_variation_options pvo ON pvo.variation_id = pv.id
         WHERE pv.product_id IN (${pholds})
         ORDER BY pv.product_id, pv.sort_order, pvo.sort_order`,
        { replacements: uniqueProdIds, type: Sequelize.QueryTypes.SELECT }
      );
      for (const r of varRows || []) {
        const pid = r.product_id;
        if (!previewProdVariationsByProduct.has(pid)) previewProdVariationsByProduct.set(pid, new Map());
        const byVar = previewProdVariationsByProduct.get(pid);
        if (!byVar.has(r.id)) {
          byVar.set(r.id, { id: r.id, variation_name: r.variation_name, sort_order: r.sort_order, options: [] });
        }
        if (r.option_id != null) {
          byVar.get(r.id).options.push({
            id: r.option_id,
            option_value: r.option_value != null ? String(r.option_value) : null,
            option_display_name: r.option_display_name || r.option_value || null,
            sort_order: r.opt_sort
          });
        }
      }
    }
    products.forEach(p => {
      p.variations = previewProdVariationsByProduct.has(p.id)
        ? Array.from(previewProdVariationsByProduct.get(p.id).values())
        : [];
    });

    res.json({
      success: true,
      data: {
        products,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total_pages: Math.ceil(totalCount / limitNum),
          total_items: totalCount
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

    // Determine if this is a free user (for raw SQL queries)
    const isFreePlan = req.tenant?.subscription_plan === 'free' || !!req.user?.tenantId;
    const { Sequelize } = require('sequelize');

    // Get product (can preview even if not published)
    // For free users: use raw SQL to avoid online_store_id issues
    let product;
    
    if (isFreePlan) {
      // Free users: use raw SQL
      const productRows = await req.db.query(`
        SELECT p.id, p.tenant_id, p.name, p.description, p.sku, p.barcode, p.price, p.stock, 
               p.low_stock_threshold, p.category, p.image_url, p.expiry_date, p.is_active, 
               p.created_at, p.updated_at,
               sp.id as 'StoreProduct.id', sp.tenant_id as 'StoreProduct.tenant_id', 
               sp.product_id as 'StoreProduct.product_id', sp.is_published as 'StoreProduct.is_published',
               sp.featured as 'StoreProduct.featured', sp.sort_order as 'StoreProduct.sort_order',
               sp.created_at as 'StoreProduct.created_at', sp.updated_at as 'StoreProduct.updated_at'
        FROM products p
        INNER JOIN store_products sp ON p.id = sp.product_id
        WHERE p.id = :productId
          AND p.is_active = 1
          AND sp.tenant_id = :tenantId
        LIMIT 1
      `, {
        replacements: { 
          productId: product_id,
          tenantId: req.user.tenantId
        },
        type: Sequelize.QueryTypes.SELECT
      });

      if (!productRows || productRows.length === 0 || !productRows[0]) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      const row = productRows[0];
      if (!row || !row.id) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      // Get product variations with options
      const variationWhereClause = isFreePlan 
        ? 'WHERE pv.product_id = :productId AND pv.tenant_id = :tenantId'
        : 'WHERE pv.product_id = :productId';
      
      // For free users: product_variation_options table doesn't have barcode column
      // Only include columns that exist in the database
      const variations = await req.db.query(`
        SELECT pv.id, pv.variation_name, pv.variation_type, pv.is_required, pv.sort_order,
               pvo.id as 'option_id', pvo.option_value, pvo.option_display_name, 
               pvo.price_adjustment, pvo.stock, pvo.sku, pvo.image_url, 
               pvo.is_default, pvo.is_available, pvo.sort_order as 'option_sort_order',
               pvo.created_at as 'option_created_at'
        FROM product_variations pv
        LEFT JOIN product_variation_options pvo ON pv.id = pvo.variation_id
          ${isFreePlan ? 'AND pvo.tenant_id = :tenantId' : ''}
        ${variationWhereClause}
        ORDER BY pv.sort_order ASC, pvo.sort_order ASC
      `, {
        replacements: { 
          productId: product_id,
          ...(isFreePlan ? { tenantId: req.user.tenantId } : {})
        },
        type: Sequelize.QueryTypes.SELECT
      });

      // Group variations and their options
      const variationsMap = {};
      variations.forEach(v => {
        if (!variationsMap[v.id]) {
          variationsMap[v.id] = {
            id: v.id,
            variation_name: v.variation_name,
            variation_type: v.variation_type,
            is_required: v.is_required,
            sort_order: v.sort_order,
            options: []
          };
        }
        if (v.option_id) {
          // For free users: barcode column doesn't exist in product_variation_options table
          variationsMap[v.id].options.push({
            id: v.option_id,
            option_value: v.option_value,
            option_display_name: v.option_display_name,
            price_adjustment: v.price_adjustment,
            stock: v.stock,
            sku: v.sku,
            // barcode not included for free users (column doesn't exist)
            image_url: v.image_url,
            is_default: v.is_default,
            is_available: v.is_available,
            sort_order: v.option_sort_order,
            created_at: v.option_created_at
          });
        }
      });

      product = {
        id: row.id,
        tenant_id: row.tenant_id,
        name: row.name,
        description: row.description,
        sku: row.sku,
        barcode: row.barcode,
        price: row.price,
        stock: row.stock,
        low_stock_threshold: row.low_stock_threshold,
        category: row.category,
        image_url: row.image_url,
        expiry_date: row.expiry_date,
        is_active: row.is_active,
        is_published: row['StoreProduct.is_published'] != null ? row['StoreProduct.is_published'] : false,
        featured: row['StoreProduct.featured'] != null ? row['StoreProduct.featured'] : false,
        sort_order: row['StoreProduct.sort_order'] != null ? row['StoreProduct.sort_order'] : null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        variations: Object.values(variationsMap)
      };
      product.toJSON = () => product;
    } else {
      // Enterprise users: use Sequelize
      product = await models.Product.findOne({
        where: {
          id: product_id,
          is_active: true
        },
        include: [
          {
            model: models.StoreProduct,
            where: {
              online_store_id: onlineStore.id
            },
            required: true,
            attributes: ['is_published', 'featured', 'sort_order']
          },
          {
            model: models.ProductVariation,
            include: [{
              model: models.ProductVariationOption,
              order: [['sort_order', 'ASC']]
            }],
            order: [['sort_order', 'ASC']],
            required: false
          }
        ]
      });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }
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

    // Handle both Sequelize instances and plain objects
    const productData = product && typeof product.toJSON === 'function' 
      ? product.toJSON() 
      : product;
    
    if (productData && productData.image_url) {
      productData.image_url = getFullUrl(productData.image_url);
    }

    // Normalize variations if they exist (for Sequelize instances)
    if (productData.ProductVariations) {
      productData.variations = productData.ProductVariations.map(variation => {
        const variationData = variation && typeof variation.toJSON === 'function' 
          ? variation.toJSON() 
          : variation;
        
        return {
          id: variationData.id,
          variation_name: variationData.variation_name,
          variation_type: variationData.variation_type,
          is_required: variationData.is_required,
          sort_order: variationData.sort_order,
          options: (variationData.ProductVariationOptions || []).map(option => {
            const optionData = option && typeof option.toJSON === 'function' 
              ? option.toJSON() 
              : option;
            
            // Normalize option image URL if it exists
            if (optionData.image_url) {
              optionData.image_url = getFullUrl(optionData.image_url);
            }
            
            // For enterprise users: include barcode (column exists)
            // For free users: barcode is not included (column doesn't exist in their table)
            const optionResult = {
              id: optionData.id,
              option_value: optionData.option_value,
              option_display_name: optionData.option_display_name,
              price_adjustment: optionData.price_adjustment,
              stock: optionData.stock,
              sku: optionData.sku,
              image_url: optionData.image_url,
              is_default: optionData.is_default,
              is_available: optionData.is_available,
              sort_order: optionData.sort_order,
              created_at: optionData.created_at
            };
            
            // Only include barcode for enterprise users (free users don't have this column)
            if (!isFreePlan && optionData.barcode !== undefined) {
              optionResult.barcode = optionData.barcode;
            }
            
            return optionResult;
          })
        };
      });
      
      // Remove ProductVariations from response (we've converted it to variations)
      delete productData.ProductVariations;
    }

    // Normalize variation option image URLs for free users (raw SQL results)
    if (productData.variations && Array.isArray(productData.variations)) {
      productData.variations.forEach(variation => {
        if (variation.options && Array.isArray(variation.options)) {
          variation.options.forEach(option => {
            if (option.image_url) {
              option.image_url = getFullUrl(option.image_url);
            }
          });
        }
      });
    }

    // Extract is_published / featured / sort_order from StoreProducts then remove it
    if (productData.StoreProducts && productData.StoreProducts.length > 0) {
      const sp = productData.StoreProducts[0];
      productData.is_published = sp.is_published != null ? sp.is_published : false;
      productData.featured = sp.featured != null ? sp.featured : false;
      productData.sort_order = sp.sort_order != null ? sp.sort_order : null;
      delete productData.StoreProducts;
    } else if (productData.StoreProducts) {
      productData.is_published = false;
      productData.featured = false;
      productData.sort_order = null;
      delete productData.StoreProducts;
    }

    productData.variants = await fetchProductVariantsStructured(req.db, product_id, getFullUrl);

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
  getOnlineStoreUrls,
  getOnlineStoreById,
  updateStorefront,
  updateStoreInformation,
  updateStoreAppearance,
  uploadStoreImage,
  deleteStoreImage,
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
  setOnlineStoreProductVisibility,
  getOnlineStoreProducts,
  getOnlineStoreProductDetails,
  fetchProductVariantsStructured,
  fetchVariantsForProductIds
};

