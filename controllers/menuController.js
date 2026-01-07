const { Sequelize } = require('sequelize');

/**
 * Get all menus
 */
async function getAllMenus(req, res) {
  try {
    const { menu_type, isActive } = req.query;

    const where = {};
    if (menu_type) where.menu_type = menu_type;
    if (isActive !== undefined) where.is_active = isActive === 'true';

    const menus = await req.db.models.Menu.findAll({
      where,
      include: [
        {
          model: req.db.models.MenuItem,
          include: [
            {
              model: req.db.models.MenuItemModifier
            }
          ],
          order: [['sort_order', 'ASC']]
        }
      ],
      order: [['sort_order', 'ASC'], ['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: { menus }
    });
  } catch (error) {
    console.error('Error getting menus:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get menus'
    });
  }
}

/**
 * Create menu
 */
async function createMenu(req, res) {
  try {
    const {
      name,
      description,
      menu_type = 'all_day',
      sort_order = 0
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    const menu = await req.db.models.Menu.create({
      name,
      description: description || null,
      menu_type,
      is_active: true,
      sort_order
    });

    res.status(201).json({
      success: true,
      message: 'Menu created successfully',
      data: { menu }
    });
  } catch (error) {
    console.error('Error creating menu:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create menu'
    });
  }
}

/**
 * Add menu item
 */
async function addMenuItem(req, res) {
  try {
    const {
      menu_id,
      product_id,
      name,
      description,
      price,
      image_url,
      preparation_time = 0,
      dietary_info,
      allergens,
      sort_order = 0,
      modifiers // Array of { name, price, is_required }
    } = req.body;

    if (!menu_id || !name || price === undefined) {
      return res.status(400).json({
        success: false,
        message: 'menu_id, name, and price are required'
      });
    }

    // Verify menu exists
    const menu = await req.db.models.Menu.findByPk(menu_id);
    if (!menu) {
      return res.status(404).json({
        success: false,
        message: 'Menu not found'
      });
    }

    const menuItem = await req.db.models.MenuItem.create({
      menu_id,
      product_id: product_id || null,
      name,
      description: description || null,
      price: parseFloat(price),
      image_url: image_url || null,
      is_available: true,
      preparation_time,
      dietary_info: dietary_info || null,
      allergens: allergens || null,
      sort_order
    });

    // Add modifiers if provided
    if (modifiers && Array.isArray(modifiers)) {
      for (const modifier of modifiers) {
        await req.db.models.MenuItemModifier.create({
          menu_item_id: menuItem.id,
          name: modifier.name,
          price: modifier.price || 0,
          is_required: modifier.is_required || false,
          sort_order: modifier.sort_order || 0
        });
      }
    }

    const completeMenuItem = await req.db.models.MenuItem.findByPk(menuItem.id, {
      include: [
        {
          model: req.db.models.MenuItemModifier
        },
        {
          model: req.db.models.Product,
          attributes: ['id', 'name']
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Menu item added successfully',
      data: { menu_item: completeMenuItem }
    });
  } catch (error) {
    console.error('Error adding menu item:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add menu item'
    });
  }
}

/**
 * Update menu item availability
 */
async function updateMenuItemAvailability(req, res) {
  try {
    const { is_available } = req.body;
    const menuItem = await req.db.models.MenuItem.findByPk(req.params.id);

    if (!menuItem) {
      return res.status(404).json({
        success: false,
        message: 'Menu item not found'
      });
    }

    await menuItem.update({ is_available });

    res.json({
      success: true,
      message: 'Menu item availability updated successfully',
      data: { menu_item: menuItem }
    });
  } catch (error) {
    console.error('Error updating menu item availability:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update menu item availability'
    });
  }
}

module.exports = {
  getAllMenus,
  createMenu,
  addMenuItem,
  updateMenuItemAvailability
};

