/**
 * Initialize Sequelize models for tenant database
 * This function should be called after getting tenant connection
 */
function initializeModels(sequelize) {
  try {
    if (!sequelize) {
      throw new Error('Sequelize instance is required');
    }

  const { DataTypes } = require('sequelize');

    console.log('Starting model initialization...');
    console.log('Sequelize instance type:', typeof sequelize);
    console.log('Sequelize has define method:', typeof sequelize.define === 'function');
    
    // CRITICAL FIX: Check and fix Sequelize ModelManager state
    // The ModelManager.models can be null, which causes "Cannot set properties of null" errors
    if (!sequelize.modelManager) {
      throw new Error('Sequelize instance does not have a modelManager. Instance may be corrupted.');
    }
    
    // If modelManager.models is null, we need to initialize it
    // This is the root cause of both "Cannot set properties of null" and "Cannot convert undefined or null to object" errors
    if (sequelize.modelManager.models === null || sequelize.modelManager.models === undefined) {
      console.warn('CRITICAL: sequelize.modelManager.models is null/undefined. Reinitializing...');
      sequelize.modelManager.models = {};
      // Sync sequelize.models immediately to ensure consistency
      sequelize.models = sequelize.modelManager.models;
      console.log('ModelManager.models reinitialized successfully');
    } else if (!sequelize.models || sequelize.models !== sequelize.modelManager.models) {
      // Ensure sequelize.models references modelManager.models
      sequelize.models = sequelize.modelManager.models;
    }
    
    console.log('ModelManager.models type:', typeof sequelize.modelManager.models);
    console.log('ModelManager.models is null:', sequelize.modelManager.models === null);
    console.log('Existing models on sequelize:', sequelize.models ? Object.keys(sequelize.models).length : 0);
    
    // Check if models are already defined - if so, return existing models
    if (sequelize.models && Object.keys(sequelize.models).length > 0) {
      console.log('Models already exist on sequelize instance.');
      console.log('Existing models count:', Object.keys(sequelize.models).length);
      console.log('Existing models:', Object.keys(sequelize.models));
      
      // Verify Invoice exists in existing models and is valid
      if (sequelize.models.Invoice && typeof sequelize.models.Invoice === 'object') {
        console.log('Invoice model found in existing models. Returning existing models.');
        return sequelize.models;
      } else {
        console.warn('WARNING: Models exist but Invoice is missing or invalid. Will attempt to add Invoice.');
        // Don't clear all models - just try to define the missing ones
      }
    }

  // Store Model (must be defined before Product)
    console.log('Defining Store model...');
    
    // Define Store model - Sequelize will handle removal of existing model if needed
    // But we'll wrap it in try-catch to handle the removal error gracefully
    let Store;
    try {
      Store = sequelize.define('Store', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    store_type: {
      type: DataTypes.ENUM('retail_store', 'warehouse', 'popup_store', 'online_only'),
      allowNull: false
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    city: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    state: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    country: {
      type: DataTypes.STRING(100),
      defaultValue: 'Nigeria'
    },
    phone: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    tableName: 'stores',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
      console.log('Store model defined:', !!Store);
    } catch (storeError) {
      console.error('Error defining Store model:', storeError.message);
      // If error is about removing existing model, try to clear it first
      if (storeError.message.includes('removeModel') || storeError.message.includes('undefined') || storeError.message.includes('null')) {
        console.log('Attempting to recover by clearing Store model...');
        try {
          if (sequelize.models && sequelize.models.Store) {
            delete sequelize.models.Store;
          }
          // Try again with fresh definition
          Store = sequelize.define('Store', {
            id: {
              type: DataTypes.INTEGER,
              primaryKey: true,
              autoIncrement: true
            },
            tenant_id: {
              type: DataTypes.INTEGER,
              allowNull: true
            },
            name: {
              type: DataTypes.STRING(255),
              allowNull: false
            },
            store_type: {
              type: DataTypes.ENUM('retail_store', 'warehouse', 'popup_store', 'online_only'),
              allowNull: false
            },
            address: {
              type: DataTypes.TEXT,
              allowNull: true
            },
            city: {
              type: DataTypes.STRING(100),
              allowNull: true
            },
            state: {
              type: DataTypes.STRING(100),
              allowNull: true
            },
            country: {
              type: DataTypes.STRING(100),
              defaultValue: 'Nigeria'
            },
            phone: {
              type: DataTypes.STRING(50),
              allowNull: true
            },
            email: {
              type: DataTypes.STRING(255),
              allowNull: true
            },
            description: {
              type: DataTypes.TEXT,
              allowNull: true
            },
            is_active: {
              type: DataTypes.BOOLEAN,
              defaultValue: true
            }
          }, {
            tableName: 'stores',
            timestamps: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at'
          });
          console.log('Store model recovered successfully');
        } catch (recoverError) {
          console.error('Failed to recover Store model:', recoverError.message);
          throw new Error(`Failed to define Store model after recovery attempt: ${storeError.message}. Recovery error: ${recoverError.message}`);
        }
      } else {
        throw storeError;
      }
    }

  // Product Model (store-specific)
    console.log('Defining Product model...');
  const Product = sequelize.define('Product', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    sku: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    barcode: {
      type: DataTypes.STRING(100),
      unique: true,
      allowNull: true
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    expiry_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    batch_number: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    unit_of_measure: {
      type: DataTypes.STRING(50),
      defaultValue: 'piece'
    },
    price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true, // Can be null for products with variations (each variation option has its own price)
      defaultValue: 0.00
    },
    cost: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    stock: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    low_stock_threshold: {
      type: DataTypes.INTEGER,
      defaultValue: 10
    },
    category: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    image_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    tableName: 'products',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Product Store Model (many-to-many: products in multiple stores)
  const ProductStore = sequelize.define('ProductStore', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    stock: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    price_override: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    }
  }, {
    tableName: 'product_stores',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Product Variation Model (variation types like Color, Size, etc.)
  const ProductVariation = sequelize.define('ProductVariation', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    variation_name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    variation_type: {
      type: DataTypes.ENUM('color', 'size', 'material', 'style', 'length', 'width', 'height', 'weight', 'other'),
      allowNull: false
    },
    is_required: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    tableName: 'product_variations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Product Variation Option Model (actual values like Red, Blue, Small, Large, etc.)
  const ProductVariationOption = sequelize.define('ProductVariationOption', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    variation_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'product_variations',
        key: 'id'
      }
    },
    option_value: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    option_display_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    price_adjustment: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    stock: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    sku: {
      type: DataTypes.STRING(100),
      allowNull: true,
      unique: true
    },
    barcode: {
      type: DataTypes.STRING(100),
      allowNull: true,
      unique: true
    },
    image_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    is_default: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    is_available: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    tableName: 'product_variation_options',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Customer Model
  const Customer = sequelize.define('Customer', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    phone: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    city: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    state: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    zip_code: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    country: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    tags: {
      type: DataTypes.JSON,
      allowNull: true
    }
  }, {
    tableName: 'customers',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Invoice Model (store-specific with tax breakdown)
    console.log('Defining Invoice model...');
  const Invoice = sequelize.define('Invoice', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    invoice_number: {
      type: DataTypes.STRING(50),
      unique: true,
      allowNull: false
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'customers',
        key: 'id'
      }
    },
    issue_date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    due_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    tax_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    vat_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    development_levy_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    other_tax_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    tax_breakdown: {
      type: DataTypes.JSON,
      allowNull: true
    },
    discount_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    tax_calculation_method: {
      type: DataTypes.ENUM('automatic', 'manual'),
      defaultValue: 'automatic'
    },
    tax_rate: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00
    },
    status: {
      type: DataTypes.ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled'),
      defaultValue: 'draft'
    },
    payment_method: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    payment_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'invoices',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
    console.log('Invoice model defined:', !!Invoice);

  // Invoice Item Model (with price adjustments and bundling)
  const InvoiceItem = sequelize.define('InvoiceItem', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    invoice_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'invoices',
        key: 'id'
      }
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    item_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    quantity: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 1.00
    },
    unit_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    original_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    },
    discount_percentage: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00
    },
    discount_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    is_bundled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    bundle_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    bundle_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    }
  }, {
    tableName: 'invoice_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Receipt Model (can be standalone or linked to invoice)
  const Receipt = sequelize.define('Receipt', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    invoice_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable - receipts can be standalone (for walk-in customers)
      references: {
        model: 'invoices',
        key: 'id'
      },
      onDelete: 'CASCADE'
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Optional - for enterprise users to link to physical store
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    receipt_number: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    receipt_html: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    preview_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    pdf_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    esc_pos_commands: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Base64 encoded ESC/POS commands for thermal printers'
    },
    digital_stamp_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    customer_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    customer_email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    customer_phone: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    tax_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    discount_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'NGN'
    },
    currency_symbol: {
      type: DataTypes.STRING(10),
      defaultValue: '₦'
    },
    payment_method: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'receipts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });
  console.log('Receipt model defined:', !!Receipt);

  // Store Service Model (tied to physical stores or online stores for free users)
  const StoreService = sequelize.define('StoreService', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for free users (services tied to online stores only)
      references: {
        model: 'stores',
        key: 'id'
      },
      comment: 'NULL for free users (services tied to online stores only), required for enterprise users'
    },
    service_title: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    price: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    service_image_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    duration_minutes: {
      type: DataTypes.INTEGER,
      defaultValue: 30
    },
    location_type: {
      type: DataTypes.ENUM('in_person', 'online', 'both'),
      defaultValue: 'in_person'
    },
    availability: {
      type: DataTypes.JSON,
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'store_services',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Booking Model (Calendly-like, store-specific)
  const Booking = sequelize.define('Booking', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    service_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'store_services',
        key: 'id'
      }
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'customers',
        key: 'id'
      }
    },
    customer_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    customer_email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    customer_phone: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    service_title: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    scheduled_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    duration_minutes: {
      type: DataTypes.INTEGER,
      defaultValue: 60
    },
    timezone: {
      type: DataTypes.STRING(50),
      defaultValue: 'Africa/Lagos'
    },
    location_type: {
      type: DataTypes.ENUM('in_person', 'online', 'both'),
      defaultValue: 'in_person'
    },
    meeting_link: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    staff_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('pending', 'confirmed', 'completed', 'cancelled', 'no_show'),
      defaultValue: 'pending'
    },
    cancellation_reason: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'bookings',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Booking Availability Model (Calendly-like availability slots)
  const BookingAvailability = sequelize.define('BookingAvailability', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for free users (services without physical stores)
      references: {
        model: 'stores',
        key: 'id'
      },
      comment: 'NULL for free users (services tied to online stores only), required for enterprise users'
    },
    service_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'store_services',
        key: 'id'
      }
    },
    day_of_week: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '0=Sunday, 1=Monday, etc.'
    },
    start_time: {
      type: DataTypes.TIME,
      allowNull: false
    },
    end_time: {
      type: DataTypes.TIME,
      allowNull: false
    },
    is_available: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    max_bookings_per_slot: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'booking_availability',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Store Product Model (for online store product publishing)
  const StoreProduct = sequelize.define('StoreProduct', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    is_published: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    seo_title: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    seo_description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    seo_keywords: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    featured: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'store_products',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Customer Interaction Model
  const CustomerInteraction = sequelize.define('CustomerInteraction', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'customers',
        key: 'id'
      }
    },
    interaction_type: {
      type: DataTypes.ENUM('call', 'email', 'meeting', 'note', 'whatsapp', 'instagram'),
      allowNull: false
    },
    subject: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    interaction_date: {
      type: DataTypes.DATE,
      allowNull: false
    },
    created_by: {
      type: DataTypes.STRING(255),
      allowNull: true
    }
  }, {
    tableName: 'customer_interactions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // AI Agent Config Model
  const AIAgentConfig = sequelize.define('AIAgentConfig', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    whatsapp_enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    instagram_enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    whatsapp_phone_number: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    whatsapp_phone_number_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    whatsapp_access_token: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    instagram_account_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    instagram_access_token: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    greeting_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    unavailable_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    business_hours: {
      type: DataTypes.JSON,
      allowNull: true
    },
    auto_reply_enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    settings: {
      type: DataTypes.JSON,
      allowNull: true
    }
  }, {
    tableName: 'ai_agent_configs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

    // Define associations (all associations must be inside try block)
    console.log('Defining model associations...');
    
  // Store associations
  Store.hasMany(Product, { foreignKey: 'store_id' });
  Product.belongsTo(Store, { foreignKey: 'store_id' });

  Store.belongsToMany(Product, { through: ProductStore, foreignKey: 'store_id', otherKey: 'product_id' });
  Product.belongsToMany(Store, { through: ProductStore, foreignKey: 'product_id', otherKey: 'store_id' });

  Store.hasMany(Invoice, { foreignKey: 'store_id' });
  Invoice.belongsTo(Store, { foreignKey: 'store_id' });

  Store.hasMany(StoreService, { foreignKey: 'store_id', onDelete: 'CASCADE' });
  StoreService.belongsTo(Store, { foreignKey: 'store_id' });

  Store.hasMany(Booking, { foreignKey: 'store_id' });
  Booking.belongsTo(Store, { foreignKey: 'store_id' });

  Store.hasMany(BookingAvailability, { foreignKey: 'store_id', onDelete: 'CASCADE' });
  BookingAvailability.belongsTo(Store, { foreignKey: 'store_id' });

  // Customer associations
  Customer.hasMany(Invoice, { foreignKey: 'customer_id' });
  Invoice.belongsTo(Customer, { foreignKey: 'customer_id' });

  Customer.hasMany(Booking, { foreignKey: 'customer_id' });
  Booking.belongsTo(Customer, { foreignKey: 'customer_id' });

  Customer.hasMany(CustomerInteraction, { foreignKey: 'customer_id', onDelete: 'CASCADE' });
  CustomerInteraction.belongsTo(Customer, { foreignKey: 'customer_id' });

  // Invoice associations
  Invoice.hasMany(InvoiceItem, { foreignKey: 'invoice_id', onDelete: 'CASCADE' });
  InvoiceItem.belongsTo(Invoice, { foreignKey: 'invoice_id' });

  Product.hasMany(InvoiceItem, { foreignKey: 'product_id' });
  InvoiceItem.belongsTo(Product, { foreignKey: 'product_id' });

  // Booking associations
  StoreService.hasMany(Booking, { foreignKey: 'service_id' });
  Booking.belongsTo(StoreService, { foreignKey: 'service_id' });

  StoreService.hasMany(BookingAvailability, { foreignKey: 'service_id', onDelete: 'CASCADE' });
  BookingAvailability.belongsTo(StoreService, { foreignKey: 'service_id' });
  
  // Product associations
    // One product can be published to multiple stores, so it's hasMany, not hasOne
    Product.hasMany(StoreProduct, { foreignKey: 'product_id', onDelete: 'CASCADE' });
  StoreProduct.belongsTo(Product, { foreignKey: 'product_id' });

  // Product Variation associations
  Product.hasMany(ProductVariation, { foreignKey: 'product_id', onDelete: 'CASCADE' });
  ProductVariation.belongsTo(Product, { foreignKey: 'product_id' });
  ProductVariation.hasMany(ProductVariationOption, { foreignKey: 'variation_id', onDelete: 'CASCADE' });
  ProductVariationOption.belongsTo(ProductVariation, { foreignKey: 'variation_id' });
 
  // Online Store Model (aggregates physical stores)
  const OnlineStore = sequelize.define('OnlineStore', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    username: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true
    },
    store_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    store_description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    profile_logo_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    banner_image_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    background_image_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    background_color: {
      type: DataTypes.STRING(7),
      defaultValue: '#F2EFEF'
    },
    button_style: {
      type: DataTypes.ENUM('rounded', 'square', 'pill'),
      defaultValue: 'rounded'
    },
    button_color: {
      type: DataTypes.STRING(7),
      defaultValue: '#78716C'
    },
    button_font_color: {
      type: DataTypes.STRING(7),
      defaultValue: '#FFFFFF'
    },
    is_location_based: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    show_location: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    allow_delivery_datetime: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    social_links: {
      type: DataTypes.JSON,
      allowNull: true
    },
    // Paystack subaccount details for split payments (enterprise and free users)
    paystack_subaccount_code: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    paystack_subaccount_id: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    is_published: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    setup_completed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName: 'online_stores',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Online Store Location Model (many-to-many: online store ↔ physical stores)
  const OnlineStoreLocation = sequelize.define('OnlineStoreLocation', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    online_store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'online_stores',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    is_default: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName: 'online_store_locations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Online Store Service Model (links physical store services to online store)
  const OnlineStoreService = sequelize.define('OnlineStoreService', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    online_store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'online_stores',
        key: 'id'
      }
    },
    service_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'store_services',
        key: 'id'
      }
    },
    is_visible: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'online_store_services',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });


  // Store Collection Model
  const StoreCollection = sequelize.define('StoreCollection', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    online_store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'online_stores',
        key: 'id'
      }
    },
    collection_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    collection_type: {
      type: DataTypes.ENUM('product', 'service'),
      allowNull: false,
      defaultValue: 'product',
      comment: 'Type of collection: product or service'
    },
    layout_type: {
      type: DataTypes.ENUM('grid', 'list', 'carousel'),
      defaultValue: 'grid'
    },
    is_pinned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    is_visible: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'store_collections',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Store Collection Product Model (junction table)
  const StoreCollectionProduct = sequelize.define('StoreCollectionProduct', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    collection_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'store_collections',
        key: 'id'
      }
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    is_pinned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'store_collection_products',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Store Collection Service Model (junction table for services in collections)
  const StoreCollectionService = sequelize.define('StoreCollectionService', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    collection_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'store_collections',
        key: 'id'
      }
    },
    service_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'store_services',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    is_pinned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'store_collection_services',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Online Store Order Model
  const OnlineStoreOrder = sequelize.define('OnlineStoreOrder', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // Nullable for enterprise users (they have separate DBs), required for free users (shared DB)
      comment: 'Required for free users (shared DB), NULL for enterprise users (separate DB)'
    },
    online_store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'online_stores',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    order_number: {
      type: DataTypes.STRING(50),
      unique: true,
      allowNull: false
    },
    idempotency_key: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Unique key to prevent duplicate orders from the same request'
    },
    customer_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    customer_email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    customer_phone: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    customer_address: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    city: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    state: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    country: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    delivery_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    delivery_time: {
      type: DataTypes.TIME,
      allowNull: true
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    tax_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    shipping_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    discount_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    status: {
      type: DataTypes.ENUM('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'),
      defaultValue: 'pending'
    },
    payment_status: {
      type: DataTypes.ENUM('pending', 'paid', 'failed', 'refunded'),
      defaultValue: 'pending'
    },
    payment_method: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'online_store_orders',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Online Store Order Item Model
  const OnlineStoreOrderItem = sequelize.define('OnlineStoreOrderItem', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    order_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'online_store_orders',
        key: 'id'
      }
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    product_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    },
    unit_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    variation_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'product_variations',
        key: 'id'
      }
    },
    variation_option_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'product_variation_options',
        key: 'id'
      }
    },
    variation_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Name of the variation (e.g., "Color", "Size")'
    },
    variation_option_value: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Value of the selected variation option (e.g., "Red", "Large")'
    }
  }, {
    tableName: 'online_store_order_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Define OnlineStoreOrder associations
  // OnlineStoreOrder ↔ OnlineStore
  OnlineStoreOrder.belongsTo(OnlineStore, { foreignKey: 'online_store_id', onDelete: 'CASCADE' });
  OnlineStore.hasMany(OnlineStoreOrder, { foreignKey: 'online_store_id', onDelete: 'CASCADE' });

  // OnlineStoreOrder ↔ Store (optional - for enterprise users with physical stores)
  OnlineStoreOrder.belongsTo(Store, { foreignKey: 'store_id', onDelete: 'SET NULL' });

  // OnlineStoreOrder ↔ OnlineStoreOrderItem
  OnlineStoreOrder.hasMany(OnlineStoreOrderItem, { foreignKey: 'order_id', onDelete: 'CASCADE' });
  OnlineStoreOrderItem.belongsTo(OnlineStoreOrder, { foreignKey: 'order_id', onDelete: 'CASCADE' });

  // OnlineStoreOrderItem ↔ Product (optional)
  OnlineStoreOrderItem.belongsTo(Product, { foreignKey: 'product_id', onDelete: 'SET NULL' });

  // Define store associations (online stores are linked to physical stores via OnlineStoreLocation)
  // OnlineStore ↔ OnlineStoreLocation (one online store can have many physical locations)
  OnlineStore.hasMany(OnlineStoreLocation, { foreignKey: 'online_store_id', onDelete: 'CASCADE' });
  OnlineStoreLocation.belongsTo(OnlineStore, { foreignKey: 'online_store_id' });

  // Store ↔ OnlineStoreLocation (one physical store can be linked to many online stores)
  Store.hasMany(OnlineStoreLocation, { foreignKey: 'store_id', onDelete: 'CASCADE' });
  OnlineStoreLocation.belongsTo(Store, { foreignKey: 'store_id' });

  // OnlineStore ↔ StoreService (many-to-many through OnlineStoreService junction table)
  // OnlineStore ↔ OnlineStoreService
  OnlineStore.hasMany(OnlineStoreService, { foreignKey: 'online_store_id', onDelete: 'CASCADE' });
  OnlineStoreService.belongsTo(OnlineStore, { foreignKey: 'online_store_id' });
  
  // StoreService ↔ OnlineStoreService
  StoreService.hasMany(OnlineStoreService, { foreignKey: 'service_id', onDelete: 'CASCADE' });
  OnlineStoreService.belongsTo(StoreService, { foreignKey: 'service_id' });
  
  // Many-to-many relationship (using belongsToMany for convenience)
  OnlineStore.belongsToMany(StoreService, { through: OnlineStoreService, foreignKey: 'online_store_id', otherKey: 'service_id' });
  StoreService.belongsToMany(OnlineStore, { through: OnlineStoreService, foreignKey: 'service_id', otherKey: 'online_store_id' });

  // OnlineStore ↔ StoreCollection (collections on online store)
  OnlineStore.hasMany(StoreCollection, { foreignKey: 'online_store_id', onDelete: 'CASCADE' });
  StoreCollection.belongsTo(OnlineStore, { foreignKey: 'online_store_id' });

  // StoreCollection ↔ StoreCollectionProduct ↔ Product
  StoreCollection.hasMany(StoreCollectionProduct, { foreignKey: 'collection_id', onDelete: 'CASCADE' });
  StoreCollectionProduct.belongsTo(StoreCollection, { foreignKey: 'collection_id' });

  Product.hasMany(StoreCollectionProduct, { foreignKey: 'product_id', onDelete: 'CASCADE' });
  StoreCollectionProduct.belongsTo(Product, { foreignKey: 'product_id' });

  // StoreCollection ↔ StoreCollectionService ↔ StoreService
  StoreCollection.hasMany(StoreCollectionService, { foreignKey: 'collection_id', onDelete: 'CASCADE' });
  StoreCollectionService.belongsTo(StoreCollection, { foreignKey: 'collection_id' });

  StoreService.hasMany(StoreCollectionService, { foreignKey: 'service_id', onDelete: 'CASCADE' });
  StoreCollectionService.belongsTo(StoreService, { foreignKey: 'service_id' });

  // Staff Model
  const Staff = sequelize.define('Staff', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    email: {
      type: DataTypes.STRING(255),
      unique: true,
      allowNull: true
    },
    phone: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    role_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'roles',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    employee_id: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    hire_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    salary: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive', 'suspended', 'terminated'),
      defaultValue: 'active'
    },
    last_login: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'staff',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Role Model
  const Role = sequelize.define('Role', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    is_system_role: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName: 'roles',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Permission Model
  const Permission = sequelize.define('Permission', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true
    },
    resource: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    action: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'permissions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Role Permission Model
  const RolePermission = sequelize.define('RolePermission', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    role_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'roles',
        key: 'id'
      }
    },
    permission_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'permissions',
        key: 'id'
      }
    }
  }, {
    tableName: 'role_permissions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Supplier Model
  const Supplier = sequelize.define('Supplier', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    company_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    phone: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    city: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    state: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    country: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    contact_person: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    payment_terms: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    tax_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    tableName: 'suppliers',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Purchase Order Model
  const PurchaseOrder = sequelize.define('PurchaseOrder', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    po_number: {
      type: DataTypes.STRING(50),
      unique: true,
      allowNull: false
    },
    supplier_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'suppliers',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    order_date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    expected_delivery_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('draft', 'sent', 'confirmed', 'partial', 'received', 'cancelled'),
      defaultValue: 'draft'
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    tax_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    shipping_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'purchase_orders',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Purchase Order Item Model
  const PurchaseOrderItem = sequelize.define('PurchaseOrderItem', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    purchase_order_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'purchase_orders',
        key: 'id'
      }
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    product_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    },
    unit_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    received_quantity: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    }
  }, {
    tableName: 'purchase_order_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // POS Transaction Model
  const POSTransaction = sequelize.define('POSTransaction', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    transaction_number: {
      type: DataTypes.STRING(50),
      unique: true,
      allowNull: false
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    staff_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'staff',
        key: 'id'
      }
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'customers',
        key: 'id'
      }
    },
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    tax_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    discount_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    payment_method: {
      type: DataTypes.ENUM('cash', 'card', 'transfer', 'mobile_money', 'other'),
      defaultValue: 'cash'
    },
    amount_paid: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    change_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    status: {
      type: DataTypes.ENUM('pending', 'completed', 'cancelled', 'refunded'),
      defaultValue: 'pending'
    },
    receipt_printed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'pos_transactions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // POS Transaction Item Model
  const POSTransactionItem = sequelize.define('POSTransactionItem', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    transaction_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'pos_transactions',
        key: 'id'
      }
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    product_name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    barcode: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    quantity: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 1.00
    },
    unit_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    discount_percentage: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00
    },
    discount_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    }
  }, {
    tableName: 'pos_transaction_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Product Bundle Model
  const ProductBundle = sequelize.define('ProductBundle', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    bundle_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    image_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    tableName: 'product_bundles',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Product Bundle Item Model
  const ProductBundleItem = sequelize.define('ProductBundleItem', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    bundle_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'product_bundles',
        key: 'id'
      }
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    }
  }, {
    tableName: 'product_bundle_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Menu Model (for restaurants)
  const Menu = sequelize.define('Menu', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    menu_type: {
      type: DataTypes.ENUM('breakfast', 'lunch', 'dinner', 'drinks', 'dessert', 'all_day'),
      defaultValue: 'all_day'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    tableName: 'menus',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Menu Item Model
  const MenuItem = sequelize.define('MenuItem', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    menu_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'menus',
        key: 'id'
      }
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true, // Can be null for products with variations (each variation option has its own price)
      defaultValue: 0.00
    },
    image_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    is_available: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    preparation_time: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    dietary_info: {
      type: DataTypes.JSON,
      allowNull: true
    },
    allergens: {
      type: DataTypes.JSON,
      allowNull: true
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    tableName: 'menu_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Menu Item Modifier Model
  const MenuItemModifier = sequelize.define('MenuItemModifier', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    menu_item_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'menu_items',
        key: 'id'
      }
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    price: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    is_required: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    sort_order: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    tableName: 'menu_item_modifiers',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Stock Movement Model
  const StockMovement = sequelize.define('StockMovement', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    movement_type: {
      type: DataTypes.ENUM('purchase', 'sale', 'adjustment', 'transfer', 'return', 'expiry', 'damage'),
      allowNull: false
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    reference_type: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    reference_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    tableName: 'stock_movements',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Define additional associations
  // Staff associations
  Staff.belongsTo(Role, { foreignKey: 'role_id' });
  Role.hasMany(Staff, { foreignKey: 'role_id' });
  Staff.belongsTo(Store, { foreignKey: 'store_id' });
  Store.hasMany(Staff, { foreignKey: 'store_id' });
  Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'role_id', otherKey: 'permission_id' });
  Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permission_id', otherKey: 'role_id' });

  // Supplier associations
  Supplier.hasMany(PurchaseOrder, { foreignKey: 'supplier_id' });
  PurchaseOrder.belongsTo(Supplier, { foreignKey: 'supplier_id' });
  PurchaseOrder.belongsTo(Store, { foreignKey: 'store_id' });
  Store.hasMany(PurchaseOrder, { foreignKey: 'store_id' });
  PurchaseOrder.hasMany(PurchaseOrderItem, { foreignKey: 'purchase_order_id', onDelete: 'CASCADE' });
  PurchaseOrderItem.belongsTo(PurchaseOrder, { foreignKey: 'purchase_order_id' });
  Product.hasMany(PurchaseOrderItem, { foreignKey: 'product_id' });
  PurchaseOrderItem.belongsTo(Product, { foreignKey: 'product_id' });

  // POS associations
  POSTransaction.belongsTo(Store, { foreignKey: 'store_id' });
  Store.hasMany(POSTransaction, { foreignKey: 'store_id' });
  POSTransaction.belongsTo(Staff, { foreignKey: 'staff_id' });
  Staff.hasMany(POSTransaction, { foreignKey: 'staff_id' });
  POSTransaction.belongsTo(Customer, { foreignKey: 'customer_id' });
  Customer.hasMany(POSTransaction, { foreignKey: 'customer_id' });
  POSTransaction.hasMany(POSTransactionItem, { foreignKey: 'transaction_id', onDelete: 'CASCADE' });
  POSTransactionItem.belongsTo(POSTransaction, { foreignKey: 'transaction_id' });
  Product.hasMany(POSTransactionItem, { foreignKey: 'product_id' });
  POSTransactionItem.belongsTo(Product, { foreignKey: 'product_id' });

  // Bundle associations
  ProductBundle.hasMany(ProductBundleItem, { foreignKey: 'bundle_id', onDelete: 'CASCADE' });
  ProductBundleItem.belongsTo(ProductBundle, { foreignKey: 'bundle_id' });
  Product.hasMany(ProductBundleItem, { foreignKey: 'product_id', onDelete: 'CASCADE' });
  ProductBundleItem.belongsTo(Product, { foreignKey: 'product_id' });

  // Menu associations
  Menu.hasMany(MenuItem, { foreignKey: 'menu_id', onDelete: 'CASCADE' });
  MenuItem.belongsTo(Menu, { foreignKey: 'menu_id' });
  Product.hasMany(MenuItem, { foreignKey: 'product_id' });
  MenuItem.belongsTo(Product, { foreignKey: 'product_id' });
  MenuItem.hasMany(MenuItemModifier, { foreignKey: 'menu_item_id', onDelete: 'CASCADE' });
  MenuItemModifier.belongsTo(MenuItem, { foreignKey: 'menu_item_id' });

  // Stock movement associations
  StockMovement.belongsTo(Product, { foreignKey: 'product_id' });
  Product.hasMany(StockMovement, { foreignKey: 'product_id' });
  StockMovement.belongsTo(Store, { foreignKey: 'store_id' });
  Store.hasMany(StockMovement, { foreignKey: 'store_id' });

  // Loyalty Program Model
  const LoyaltyProgram = sequelize.define('LoyaltyProgram', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    points_per_currency: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 1.00
    },
    currency_unit: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 1.00
    },
    redemption_rate: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 100.00
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    tableName: 'loyalty_programs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Customer Loyalty Points Model
  const CustomerLoyaltyPoints = sequelize.define('CustomerLoyaltyPoints', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'customers',
        key: 'id'
      }
    },
    loyalty_program_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'loyalty_programs',
        key: 'id'
      }
    },
    total_points: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    redeemed_points: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    available_points: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    lifetime_points: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    tier: {
      type: DataTypes.STRING(50),
      defaultValue: 'bronze'
    }
  }, {
    tableName: 'customer_loyalty_points',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'last_updated'
  });

  // Loyalty Point Transaction Model
  const LoyaltyPointTransaction = sequelize.define('LoyaltyPointTransaction', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'customers',
        key: 'id'
      }
    },
    loyalty_program_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'loyalty_programs',
        key: 'id'
      }
    },
    transaction_type: {
      type: DataTypes.ENUM('earned', 'redeemed', 'expired', 'adjusted'),
      allowNull: false
    },
    points: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false
    },
    reference_type: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    reference_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    expires_at: {
      type: DataTypes.DATEONLY,
      allowNull: true
    }
  }, {
    tableName: 'loyalty_point_transactions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  // Staff Attendance Model
  const StaffAttendance = sequelize.define('StaffAttendance', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    staff_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'staff',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    clock_in_time: {
      type: DataTypes.DATE,
      allowNull: false
    },
    clock_out_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    break_start_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    break_end_time: {
      type: DataTypes.DATE,
      allowNull: true
    },
    total_hours: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00
    },
    break_duration: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00
    },
    work_duration: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00
    },
    attendance_method: {
      type: DataTypes.ENUM('manual', 'biometric', 'card', 'mobile', 'web'),
      defaultValue: 'manual'
    },
    device_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    location_latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: true
    },
    location_longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('present', 'absent', 'late', 'early_leave', 'half_day'),
      defaultValue: 'present'
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'staff_attendance',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Staff Shift Model
  const StaffShift = sequelize.define('StaffShift', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    staff_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'staff',
        key: 'id'
      }
    },
    store_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'stores',
        key: 'id'
      }
    },
    shift_date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    shift_start_time: {
      type: DataTypes.TIME,
      allowNull: false
    },
    shift_end_time: {
      type: DataTypes.TIME,
      allowNull: false
    },
    break_duration: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    is_approved: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    approved_by: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'staff_shifts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Loyalty associations
  LoyaltyProgram.hasMany(CustomerLoyaltyPoints, { foreignKey: 'loyalty_program_id' });
  CustomerLoyaltyPoints.belongsTo(LoyaltyProgram, { foreignKey: 'loyalty_program_id' });
  Customer.hasMany(CustomerLoyaltyPoints, { foreignKey: 'customer_id' });
  CustomerLoyaltyPoints.belongsTo(Customer, { foreignKey: 'customer_id' });
  Customer.hasMany(LoyaltyPointTransaction, { foreignKey: 'customer_id' });
  LoyaltyPointTransaction.belongsTo(Customer, { foreignKey: 'customer_id' });
  LoyaltyProgram.hasMany(LoyaltyPointTransaction, { foreignKey: 'loyalty_program_id' });
  LoyaltyPointTransaction.belongsTo(LoyaltyProgram, { foreignKey: 'loyalty_program_id' });

  // Attendance associations
  Staff.hasMany(StaffAttendance, { foreignKey: 'staff_id' });
  StaffAttendance.belongsTo(Staff, { foreignKey: 'staff_id' });
  Store.hasMany(StaffAttendance, { foreignKey: 'store_id' });
  StaffAttendance.belongsTo(Store, { foreignKey: 'store_id' });
  Staff.hasMany(StaffShift, { foreignKey: 'staff_id' });
  StaffShift.belongsTo(Staff, { foreignKey: 'staff_id' });
  Store.hasMany(StaffShift, { foreignKey: 'store_id' });
  StaffShift.belongsTo(Store, { foreignKey: 'store_id' });

  // Payment Gateway Model
  const PaymentGateway = sequelize.define('PaymentGateway', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    gateway_name: {
      type: DataTypes.ENUM('paystack', 'flutterwave', 'stripe', 'other'),
      allowNull: false
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    is_default: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    public_key: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    secret_key: {
      type: DataTypes.STRING(500),
      allowNull: false
    },
    webhook_secret: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    test_mode: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    transaction_fee_percentage: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true
    }
  }, {
    tableName: 'payment_gateways',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Payment Transaction Model
  const PaymentTransaction = sequelize.define('PaymentTransaction', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    tenant_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    order_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    invoice_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    transaction_reference: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true
    },
    gateway_name: {
      type: DataTypes.ENUM('paystack', 'flutterwave', 'stripe', 'other'),
      allowNull: false
    },
    gateway_transaction_id: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'NGN'
    },
    platform_fee: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.00
    },
    merchant_amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false
    },
    customer_email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    customer_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    payment_method: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('pending', 'success', 'failed', 'cancelled', 'refunded'),
      defaultValue: 'pending'
    },
    gateway_response: {
      type: DataTypes.JSON,
      allowNull: true
    },
    failure_reason: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    paid_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'payment_transactions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  // Payment associations (these are the last associations after PaymentTransaction model)
  PaymentTransaction.belongsTo(OnlineStoreOrder, { foreignKey: 'order_id' });
  PaymentTransaction.belongsTo(Invoice, { foreignKey: 'invoice_id' });
  // Allow including transactions from orders/invoices
  if (typeof OnlineStoreOrder !== 'undefined') {
    OnlineStoreOrder.hasMany(PaymentTransaction, { foreignKey: 'order_id' });
  }
  if (typeof Invoice !== 'undefined') {
    Invoice.hasMany(PaymentTransaction, { foreignKey: 'invoice_id' });
  }

    // Verify Invoice model is defined before returning
    console.log('Checking Invoice model before return...');
    console.log('Invoice is defined:', typeof Invoice !== 'undefined');
    console.log('Invoice value:', Invoice ? 'object' : 'null/undefined');
    
    if (!Invoice) {
      console.error('ERROR: Invoice model is undefined before return statement');
      console.error('Store is defined:', typeof Store !== 'undefined');
      console.error('Product is defined:', typeof Product !== 'undefined');
      console.error('Customer is defined:', typeof Customer !== 'undefined');
      throw new Error('Invoice model was not properly defined');
    }

    console.log('Creating models object...');
    const models = {
    Store,
    Product,
    ProductStore,
    ProductVariation,
    ProductVariationOption,
    Customer,
    Invoice,
    InvoiceItem,
      Receipt,
    StoreService,
    Booking,
    BookingAvailability,
    StoreProduct,
    CustomerInteraction,
    AIAgentConfig,
    OnlineStore,
    OnlineStoreLocation,
    OnlineStoreService,
    StoreCollection,
    StoreCollectionProduct,
    StoreCollectionService,
    OnlineStoreOrder,
    OnlineStoreOrderItem,
    Staff,
    Role,
    Permission,
    RolePermission,
    Supplier,
    PurchaseOrder,
    PurchaseOrderItem,
    POSTransaction,
    POSTransactionItem,
    ProductBundle,
    ProductBundleItem,
    Menu,
    MenuItem,
    MenuItemModifier,
    StockMovement,
    LoyaltyProgram,
    CustomerLoyaltyPoints,
    LoyaltyPointTransaction,
    StaffAttendance,
    StaffShift,
    PaymentGateway,
    PaymentTransaction
  };

  // Final verification
  if (!models.Invoice) {
    console.error('ERROR: Invoice model missing from returned models object');
    console.error('Available models:', Object.keys(models));
    throw new Error('Invoice model missing from models return object');
  }

  console.log(`Successfully initialized ${Object.keys(models).length} models`);
  return models;
  } catch (error) {
    console.error('FATAL ERROR in initializeModels function:');
    console.error('Error message:', error.message);
    console.error('Error name:', error.name);
    console.error('Error stack:', error.stack);
    throw error; // Re-throw to be caught by middleware
  }
}

module.exports = initializeModels;

