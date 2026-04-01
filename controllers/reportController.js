const { Sequelize } = require('sequelize');
const moment = require('moment');

/**
 * Get sales report
 * Enterprise only: queries POSTransaction and Invoice tables.
 * Free users: returns online store order revenue only.
 */
async function getSalesReport(req, res) {
  try {
    const { start_date, end_date, store_id } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'start_date and end_date are required'
      });
    }

    const isFreePlan = req.tenant?.subscription_plan === 'free';
    const tenantId = req.user?.tenantId;

    if (isFreePlan) {
      // Free users: revenue comes from online store orders only
      const tenantFilter = { tenant_id: tenantId };
      const dateFilter = {
        created_at: { [Sequelize.Op.between]: [start_date, end_date] }
      };

      const totalRevenue = await req.db.models.OnlineStoreOrder.sum('total', {
        where: { ...tenantFilter, ...dateFilter, payment_status: 'paid' }
      }) || 0;

      const orderCount = await req.db.models.OnlineStoreOrder.count({
        where: { ...tenantFilter, ...dateFilter }
      });

      return res.json({
        success: true,
        data: {
          period: { start_date, end_date },
          summary: {
            total_revenue: parseFloat(totalRevenue),
            order_count: orderCount,
            pos_sales: 0,
            invoice_sales: 0
          },
          daily_breakdown: { pos: [], invoices: [] }
        }
      });
    }

    // Enterprise users: POS + Invoice
    const where = {
      created_at: { [Sequelize.Op.between]: [start_date, end_date] },
      status: 'completed'
    };
    if (store_id) where.store_id = store_id;

    const posTransactions = await req.db.models.POSTransaction.findAll({
      where,
      attributes: [
        [Sequelize.fn('DATE', Sequelize.col('created_at')), 'date'],
        [Sequelize.fn('SUM', Sequelize.col('total')), 'total_sales'],
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'transaction_count']
      ],
      group: [Sequelize.fn('DATE', Sequelize.col('created_at'))],
      order: [[Sequelize.fn('DATE', Sequelize.col('created_at')), 'ASC']],
      raw: true
    });

    const paidInvoices = await req.db.models.Invoice.findAll({
      where: {
        created_at: { [Sequelize.Op.between]: [start_date, end_date] },
        status: 'paid',
        ...(store_id ? { store_id } : {})
      },
      attributes: [
        [Sequelize.fn('DATE', Sequelize.col('payment_date')), 'date'],
        [Sequelize.fn('SUM', Sequelize.col('total')), 'total_sales'],
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'invoice_count']
      ],
      group: [Sequelize.fn('DATE', Sequelize.col('payment_date'))],
      order: [[Sequelize.fn('DATE', Sequelize.col('payment_date')), 'ASC']],
      raw: true
    });

    const totalSales = await req.db.models.POSTransaction.sum('total', { where }) || 0;
    const totalInvoices = await req.db.models.Invoice.sum('total', {
      where: {
        created_at: { [Sequelize.Op.between]: [start_date, end_date] },
        status: 'paid',
        ...(store_id ? { store_id } : {})
      }
    }) || 0;

    res.json({
      success: true,
      data: {
        period: { start_date, end_date },
        summary: {
          total_revenue: parseFloat(totalSales) + parseFloat(totalInvoices),
          pos_sales: parseFloat(totalSales),
          invoice_sales: parseFloat(totalInvoices)
        },
        daily_breakdown: { pos: posTransactions, invoices: paidInvoices }
      }
    });
  } catch (error) {
    console.error('Error getting sales report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get sales report',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
}

/**
 * Get product performance report
 * Enterprise only: queries POSTransactionItem and InvoiceItem.
 * Free users: returns top products from online store orders.
 */
async function getProductPerformanceReport(req, res) {
  try {
    const { start_date, end_date, store_id, limit = 20 } = req.query;

    const isFreePlan = req.tenant?.subscription_plan === 'free';
    const tenantId = req.user?.tenantId;

    if (isFreePlan) {
      // Free users: derive product performance from online store order items
      const tenantFilter = { tenant_id: tenantId };
      const dateFilter = start_date && end_date
        ? { created_at: { [Sequelize.Op.between]: [start_date, end_date] } }
        : {};

      const topProducts = await req.db.models.OnlineStoreOrderItem.findAll({
        attributes: [
          'product_id',
          'product_name',
          [Sequelize.fn('SUM', Sequelize.col('OnlineStoreOrderItem.quantity')), 'total_quantity'],
          [Sequelize.fn('SUM', Sequelize.col('OnlineStoreOrderItem.total')), 'total_revenue']
        ],
        include: [{
          model: req.db.models.OnlineStoreOrder,
          where: { ...tenantFilter, ...dateFilter },
          attributes: []
        }],
        where: { product_id: { [Sequelize.Op.ne]: null } },
        group: ['OnlineStoreOrderItem.product_id', 'OnlineStoreOrderItem.product_name'],
        order: [[Sequelize.fn('SUM', Sequelize.col('OnlineStoreOrderItem.total')), 'DESC']],
        limit: parseInt(limit),
        raw: true
      });

      return res.json({
        success: true,
        data: {
          top_products_orders: topProducts,
          top_products_pos: [],
          top_products_invoices: []
        }
      });
    }

    // Enterprise users: POS + Invoice
    const productWhere = {};
    if (store_id) productWhere.store_id = store_id;

    const topProductsPOS = await req.db.models.POSTransactionItem.findAll({
      attributes: [
        'product_id',
        [Sequelize.fn('SUM', Sequelize.col('quantity')), 'total_quantity'],
        [Sequelize.fn('SUM', Sequelize.col('total')), 'total_revenue']
      ],
      include: [
        {
          model: req.db.models.POSTransaction,
          where: {
            status: 'completed',
            ...(start_date && end_date && {
              created_at: { [Sequelize.Op.between]: [start_date, end_date] }
            })
          },
          attributes: []
        },
        {
          model: req.db.models.Product,
          where: productWhere,
          attributes: ['id', 'name', 'sku', 'price']
        }
      ],
      group: ['product_id'],
      order: [[Sequelize.fn('SUM', Sequelize.col('total')), 'DESC']],
      limit: parseInt(limit),
      raw: false
    });

    const topProductsInvoice = await req.db.models.InvoiceItem.findAll({
      attributes: [
        'product_id',
        [Sequelize.fn('SUM', Sequelize.col('quantity')), 'total_quantity'],
        [Sequelize.fn('SUM', Sequelize.col('total')), 'total_revenue']
      ],
      include: [
        {
          model: req.db.models.Invoice,
          where: {
            status: 'paid',
            ...(start_date && end_date && {
              payment_date: { [Sequelize.Op.between]: [start_date, end_date] }
            })
          },
          attributes: []
        },
        {
          model: req.db.models.Product,
          where: productWhere,
          attributes: ['id', 'name', 'sku', 'price']
        }
      ],
      group: ['product_id'],
      order: [[Sequelize.fn('SUM', Sequelize.col('total')), 'DESC']],
      limit: parseInt(limit),
      raw: false
    });

    res.json({
      success: true,
      data: {
        top_products_pos: topProductsPOS,
        top_products_invoices: topProductsInvoice
      }
    });
  } catch (error) {
    console.error('Error getting product performance report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get product performance report',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
}

/**
 * Get customer analytics
 */
async function getCustomerAnalytics(req, res) {
  try {
    const { start_date, end_date, store_id } = req.query;

    const isFreePlan = req.tenant?.subscription_plan === 'free';
    const tenantId = req.user?.tenantId;
    const tenantFilter = isFreePlan ? { tenant_id: tenantId } : {};

    // Total customers scoped to tenant
    const totalCustomers = await req.db.models.Customer.count({
      where: { ...tenantFilter }
    });

    // New customers in period
    const newCustomers = await req.db.models.Customer.count({
      where: {
        ...tenantFilter,
        ...(start_date && end_date && {
          created_at: { [Sequelize.Op.between]: [start_date, end_date] }
        })
      }
    });

    if (isFreePlan) {
      // Free users: derive top customers from online store orders
      const topCustomers = await req.db.models.OnlineStoreOrder.findAll({
        attributes: [
          'customer_name',
          'customer_email',
          'customer_phone',
          [Sequelize.fn('SUM', Sequelize.col('total')), 'total_spent'],
          [Sequelize.fn('COUNT', Sequelize.col('id')), 'order_count']
        ],
        where: {
          ...tenantFilter,
          payment_status: 'paid',
          ...(start_date && end_date && {
            created_at: { [Sequelize.Op.between]: [start_date, end_date] }
          })
        },
        group: ['customer_name', 'customer_email', 'customer_phone'],
        order: [[Sequelize.fn('SUM', Sequelize.col('total')), 'DESC']],
        limit: 10,
        raw: true
      });

      return res.json({
        success: true,
        data: { total_customers: totalCustomers, new_customers: newCustomers, top_customers: topCustomers }
      });
    }

    // Enterprise users: top customers from invoices
    const invoiceWhere = {
      status: 'paid',
      ...(store_id ? { store_id } : {}),
      ...(start_date && end_date && {
        payment_date: { [Sequelize.Op.between]: [start_date, end_date] }
      })
    };

    const topCustomers = await req.db.models.Invoice.findAll({
      attributes: [
        'customer_id',
        [Sequelize.fn('SUM', Sequelize.col('total')), 'total_spent'],
        [Sequelize.fn('COUNT', Sequelize.col('Invoice.id')), 'invoice_count']
      ],
      where: invoiceWhere,
      include: [{
        model: req.db.models.Customer,
        attributes: ['id', 'name', 'email', 'phone']
      }],
      group: ['customer_id'],
      order: [[Sequelize.fn('SUM', Sequelize.col('total')), 'DESC']],
      limit: 10
    });

    res.json({
      success: true,
      data: { total_customers: totalCustomers, new_customers: newCustomers, top_customers: topCustomers }
    });
  } catch (error) {
    console.error('Error getting customer analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get customer analytics',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
}

/**
 * Get dashboard overview
 * Enterprise users: POS transactions + invoices.
 * Free users: online store orders + product counts (no POS/invoice tables).
 */
async function getDashboardOverview(req, res) {
  try {
    const { store_id } = req.query;

    const isFreePlan = req.tenant?.subscription_plan === 'free';
    const tenantId = req.user?.tenantId;

    const today = moment().format('YYYY-MM-DD');
    const thisMonthStart = moment().startOf('month').format('YYYY-MM-DD');
    const lastMonthStart = moment().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
    const lastMonthEnd = moment().subtract(1, 'month').endOf('month').format('YYYY-MM-DD');

    if (isFreePlan) {
      // Free users: shared DB — all queries MUST include tenant_id.
      // No pos_transactions table. invoices + online_store_orders both exist with tenant_id.
      const tenantFilter = { tenant_id: tenantId };

      // Revenue from online store orders (paid)
      const todayOrderSales = await req.db.models.OnlineStoreOrder.sum('total', {
        where: { ...tenantFilter, payment_status: 'paid', created_at: { [Sequelize.Op.gte]: today } }
      }) || 0;

      const thisMonthOrderSales = await req.db.models.OnlineStoreOrder.sum('total', {
        where: { ...tenantFilter, payment_status: 'paid', created_at: { [Sequelize.Op.gte]: thisMonthStart } }
      }) || 0;

      const lastMonthOrderSales = await req.db.models.OnlineStoreOrder.sum('total', {
        where: { ...tenantFilter, payment_status: 'paid', created_at: { [Sequelize.Op.between]: [lastMonthStart, lastMonthEnd] } }
      }) || 0;

      // Revenue from invoices (paid) — invoices table exists in shared DB with tenant_id
      const todayInvoiceSales = await req.db.models.Invoice.sum('total', {
        where: { ...tenantFilter, status: 'paid', created_at: { [Sequelize.Op.gte]: today } }
      }) || 0;

      const thisMonthInvoiceSales = await req.db.models.Invoice.sum('total', {
        where: { ...tenantFilter, status: 'paid', created_at: { [Sequelize.Op.gte]: thisMonthStart } }
      }) || 0;

      const lastMonthInvoiceSales = await req.db.models.Invoice.sum('total', {
        where: { ...tenantFilter, status: 'paid', created_at: { [Sequelize.Op.between]: [lastMonthStart, lastMonthEnd] } }
      }) || 0;

      const todaySales = parseFloat(todayOrderSales) + parseFloat(todayInvoiceSales);
      const thisMonthSales = parseFloat(thisMonthOrderSales) + parseFloat(thisMonthInvoiceSales);
      const lastMonthSales = parseFloat(lastMonthOrderSales) + parseFloat(lastMonthInvoiceSales);

      const lowStockProducts = await req.db.models.Product.count({
        where: {
          ...tenantFilter,
          is_active: true,
          stock: { [Sequelize.Op.lte]: Sequelize.col('low_stock_threshold') }
        }
      });

      const pendingInvoices = await req.db.models.Invoice.count({
        where: { ...tenantFilter, status: { [Sequelize.Op.in]: ['draft', 'sent'] } }
      });

      const todayOrders = await req.db.models.OnlineStoreOrder.count({
        where: { ...tenantFilter, created_at: { [Sequelize.Op.gte]: today } }
      });

      const salesGrowth = lastMonthSales > 0
        ? ((thisMonthSales - lastMonthSales) / lastMonthSales * 100).toFixed(2)
        : 0;

      return res.json({
        success: true,
        data: {
          sales: {
            today: todaySales,
            this_month: thisMonthSales,
            last_month: lastMonthSales,
            growth_percentage: parseFloat(salesGrowth)
          },
          alerts: {
            low_stock_products: lowStockProducts,
            pending_invoices: pendingInvoices
          },
          activity: {
            today_transactions: todayOrders
          }
        }
      });
    }

    // Enterprise users: POS transactions + invoices
    const where = {};
    if (store_id) where.store_id = store_id;

    const todaySales = await req.db.models.POSTransaction.sum('total', {
      where: { ...where, status: 'completed', created_at: { [Sequelize.Op.gte]: today } }
    }) || 0;

    const thisMonthSales = await req.db.models.POSTransaction.sum('total', {
      where: { ...where, status: 'completed', created_at: { [Sequelize.Op.gte]: thisMonthStart } }
    }) || 0;

    const lastMonthSales = await req.db.models.POSTransaction.sum('total', {
      where: { ...where, status: 'completed', created_at: { [Sequelize.Op.between]: [lastMonthStart, lastMonthEnd] } }
    }) || 0;

    const lowStockProducts = await req.db.models.Product.count({
      where: {
        ...where,
        is_active: true,
        stock: { [Sequelize.Op.lte]: Sequelize.col('low_stock_threshold') }
      }
    });

    const pendingInvoices = await req.db.models.Invoice.count({
      where: { ...where, status: { [Sequelize.Op.in]: ['draft', 'sent'] } }
    });

    const todayTransactions = await req.db.models.POSTransaction.count({
      where: { ...where, status: 'completed', created_at: { [Sequelize.Op.gte]: today } }
    });

    const salesGrowth = lastMonthSales > 0
      ? ((thisMonthSales - lastMonthSales) / lastMonthSales * 100).toFixed(2)
      : 0;

    res.json({
      success: true,
      data: {
        sales: {
          today: parseFloat(todaySales),
          this_month: parseFloat(thisMonthSales),
          last_month: parseFloat(lastMonthSales),
          growth_percentage: parseFloat(salesGrowth)
        },
        alerts: {
          low_stock_products: lowStockProducts,
          pending_invoices: pendingInvoices
        },
        activity: {
          today_transactions: todayTransactions
        }
      }
    });
  } catch (error) {
    console.error('Error getting dashboard overview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get dashboard overview',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
}

/**
 * Get dashboard stats
 * Returns total products, active products, total revenue, active orders, and recent orders.
 * Works for both free (shared DB, filtered by tenant_id) and enterprise (dedicated DB) users.
 */
async function getDashboardStats(req, res) {
  try {
    const isFreePlan = req.tenant?.subscription_plan === 'free';
    const tenantId = req.user?.tenantId;

    const tenantFilter = isFreePlan ? { tenant_id: tenantId } : {};

    const totalProducts = await req.db.models.Product.count({
      where: { ...tenantFilter }
    });

    const totalActiveProducts = await req.db.models.Product.count({
      where: { ...tenantFilter, is_active: true }
    });

    const totalRevenue = await req.db.models.OnlineStoreOrder.sum('total', {
      where: { ...tenantFilter, payment_status: 'paid' }
    }) || 0;

    const totalActiveOrders = await req.db.models.OnlineStoreOrder.count({
      where: {
        ...tenantFilter,
        status: { [Sequelize.Op.notIn]: ['cancelled', 'delivered'] }
      }
    });

    const recentOrders = await req.db.models.OnlineStoreOrder.findAll({
      where: { ...tenantFilter },
      order: [['created_at', 'DESC']],
      limit: 10,
      attributes: ['id', 'order_number', 'customer_name', 'total', 'status', 'payment_status', 'created_at']
    });

    res.json({
      success: true,
      data: {
        total_products: totalProducts,
        total_active_products: totalActiveProducts,
        total_revenue: parseFloat(totalRevenue),
        total_active_orders: totalActiveOrders,
        recent_orders: recentOrders
      }
    });
  } catch (error) {
    console.error('Error getting dashboard stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get dashboard stats',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
}

module.exports = {
  getSalesReport,
  getProductPerformanceReport,
  getCustomerAnalytics,
  getDashboardOverview,
  getDashboardStats
};
