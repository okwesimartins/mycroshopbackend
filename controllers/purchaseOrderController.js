const { Sequelize } = require('sequelize');
const { v4: uuidv4 } = require('uuid');

/**
 * Generate unique PO number
 */
function generatePONumber() {
  const prefix = 'PO';
  const timestamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Get all purchase orders
 */
async function getAllPurchaseOrders(req, res) {
  try {
    const { page = 1, limit = 50, supplier_id, store_id, status, start_date, end_date } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (supplier_id) where.supplier_id = supplier_id;
    if (store_id) where.store_id = store_id;
    if (status) where.status = status;
    if (start_date || end_date) {
      where.order_date = {};
      if (start_date) where.order_date[Sequelize.Op.gte] = start_date;
      if (end_date) where.order_date[Sequelize.Op.lte] = end_date;
    }

    const { count, rows } = await req.db.models.PurchaseOrder.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.Supplier,
          attributes: ['id', 'name', 'company_name', 'phone']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        purchase_orders: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting purchase orders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get purchase orders'
    });
  }
}

/**
 * Get purchase order by ID
 */
async function getPurchaseOrderById(req, res) {
  try {
    const purchaseOrder = await req.db.models.PurchaseOrder.findByPk(req.params.id, {
      include: [
        {
          model: req.db.models.Supplier
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        },
        {
          model: req.db.models.PurchaseOrderItem,
          include: [
            {
              model: req.db.models.Product,
              attributes: ['id', 'name', 'sku', 'barcode']
            }
          ]
        }
      ]
    });

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    res.json({
      success: true,
      data: { purchase_order: purchaseOrder }
    });
  } catch (error) {
    console.error('Error getting purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get purchase order'
    });
  }
}

/**
 * Create purchase order
 */
async function createPurchaseOrder(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const {
      supplier_id,
      store_id,
      order_date,
      expected_delivery_date,
      items, // Array of { product_id, product_name, quantity, unit_price }
      tax_rate = 0,
      shipping_amount = 0,
      notes
    } = req.body;

    if (!supplier_id || !order_date || !items || !Array.isArray(items) || items.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'supplier_id, order_date, and items are required'
      });
    }

    // Verify supplier exists
    const supplier = await req.db.models.Supplier.findByPk(supplier_id);
    if (!supplier) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Calculate totals
    let subtotal = 0;
    const poItems = [];

    for (const item of items) {
      const { product_id, product_name, quantity, unit_price } = item;

      if (!product_name || !quantity || !unit_price) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Each item must have product_name, quantity, and unit_price'
        });
      }

      const itemTotal = quantity * unit_price;
      subtotal += itemTotal;

      poItems.push({
        product_id: product_id || null,
        product_name,
        quantity,
        unit_price,
        total: itemTotal
      });
    }

    const taxAmount = subtotal * (tax_rate / 100);
    const total = subtotal + taxAmount + shipping_amount;

    // Create purchase order
    const purchaseOrder = await req.db.models.PurchaseOrder.create({
      po_number: generatePONumber(),
      supplier_id,
      store_id: store_id || null,
      order_date,
      expected_delivery_date: expected_delivery_date || null,
      status: 'draft',
      subtotal,
      tax_amount: taxAmount,
      shipping_amount,
      total,
      notes: notes || null
    }, { transaction });

    // Create purchase order items
    for (const item of poItems) {
      await req.db.models.PurchaseOrderItem.create({
        purchase_order_id: purchaseOrder.id,
        ...item
      }, { transaction });
    }

    await transaction.commit();

    // Fetch complete purchase order
    const completePO = await req.db.models.PurchaseOrder.findByPk(purchaseOrder.id, {
      include: [
        {
          model: req.db.models.Supplier
        },
        {
          model: req.db.models.Store
        },
        {
          model: req.db.models.PurchaseOrderItem,
          include: [
            {
              model: req.db.models.Product
            }
          ]
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Purchase order created successfully',
      data: { purchase_order: completePO }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error creating purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create purchase order'
    });
  }
}

/**
 * Receive purchase order (update stock)
 */
async function receivePurchaseOrder(req, res) {
  const transaction = await req.db.transaction();
  
  try {
    const { received_items } = req.body; // Array of { item_id, received_quantity }
    const purchaseOrder = await req.db.models.PurchaseOrder.findByPk(req.params.id);

    if (!purchaseOrder) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    if (purchaseOrder.status === 'received') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Purchase order already received'
      });
    }

    const items = await req.db.models.PurchaseOrderItem.findAll({
      where: { purchase_order_id: purchaseOrder.id }
    });

    let allReceived = true;

    for (const receivedItem of received_items) {
      const item = items.find(i => i.id === receivedItem.item_id);
      if (!item) continue;

      const receivedQty = receivedItem.received_quantity || item.quantity;
      const newReceivedQty = item.received_quantity + receivedQty;

      await item.update({
        received_quantity: newReceivedQty
      }, { transaction });

      // Update product stock if product_id exists
      if (item.product_id) {
        const product = await req.db.models.Product.findByPk(item.product_id);
        if (product) {
          await product.update({
            stock: product.stock + receivedQty
          }, { transaction });

          // Record stock movement
          await req.db.models.StockMovement.create({
            product_id: item.product_id,
            store_id: purchaseOrder.store_id,
            movement_type: 'purchase',
            quantity: receivedQty,
            reference_type: 'purchase_order',
            reference_id: purchaseOrder.id,
            notes: `Received from PO ${purchaseOrder.po_number}`,
            created_by: req.user.staffId || req.user.id
          }, { transaction });
        }
      }

      if (newReceivedQty < item.quantity) {
        allReceived = false;
      }
    }

    // Update PO status
    const newStatus = allReceived ? 'received' : 'partial';
    await purchaseOrder.update({
      status: newStatus
    }, { transaction });

    await transaction.commit();

    const updatedPO = await req.db.models.PurchaseOrder.findByPk(purchaseOrder.id, {
      include: [
        {
          model: req.db.models.PurchaseOrderItem
        }
      ]
    });

    res.json({
      success: true,
      message: 'Purchase order received successfully',
      data: { purchase_order: updatedPO }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error receiving purchase order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to receive purchase order'
    });
  }
}

/**
 * Update purchase order status
 */
async function updatePurchaseOrderStatus(req, res) {
  try {
    const { status } = req.body;
    const purchaseOrder = await req.db.models.PurchaseOrder.findByPk(req.params.id);

    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    const validStatuses = ['draft', 'sent', 'confirmed', 'partial', 'received', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    await purchaseOrder.update({ status });

    res.json({
      success: true,
      message: 'Purchase order status updated successfully',
      data: { purchase_order: purchaseOrder }
    });
  } catch (error) {
    console.error('Error updating purchase order status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update purchase order status'
    });
  }
}

module.exports = {
  getAllPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  receivePurchaseOrder,
  updatePurchaseOrderStatus
};

