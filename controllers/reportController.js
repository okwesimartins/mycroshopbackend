const { Sequelize } = require('sequelize');
const moment = require('moment');

/**
 * Get sales report
 */
async function getSalesReport(req, res) {
  try {
    const { start_date, end_date, store_id, group_by = 'day' } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'start_date and end_date are required'
      });
    }

    const where = {
      created_at: {
        [Sequelize.Op.between]: [start_date, end_date]
      },
      status: 'completed'
    };

    if (store_id) where.store_id = store_id;

    // Get POS transactions
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

    // Get paid invoices
    const paidInvoices = await req.db.models.Invoice.findAll({
      where: {
        ...where,
        status: 'paid'
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

    // Calculate totals
    const totalSales = await req.db.models.POSTransaction.sum('total', {
      where
    }) || 0;

    const totalInvoices = await req.db.models.Invoice.sum('total', {
      where: {
        ...where,
        status: 'paid'
      }
    }) || 0;

    const totalRevenue = parseFloat(totalSales) + parseFloat(totalInvoices);

    res.json({
      success: true,
      data: {
        period: {
          start_date,
          end_date
        },
        summary: {
          total_revenue: totalRevenue,
          pos_sales: parseFloat(totalSales),
          invoice_sales: parseFloat(totalInvoices)
        },
        daily_breakdown: {
          pos: posTransactions,
          invoices: paidInvoices
        }
      }
    });
  } catch (error) {
    console.error('Error getting sales report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get sales report'
    });
  }
}

/**
 * Get product performance report
 */
async function getProductPerformanceReport(req, res) {
  try {
    const { start_date, end_date, store_id, limit = 20 } = req.query;

    const where = {};
    if (store_id) where.store_id = store_id;

    // Get top selling products from POS
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
              created_at: {
                [Sequelize.Op.between]: [start_date, end_date]
              }
            })
          },
          attributes: []
        },
        {
          model: req.db.models.Product,
          where,
          attributes: ['id', 'name', 'sku', 'price']
        }
      ],
      group: ['product_id'],
      order: [[Sequelize.fn('SUM', Sequelize.col('total')), 'DESC']],
      limit: parseInt(limit),
      raw: false
    });

    // Get top products from invoices
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
              payment_date: {
                [Sequelize.Op.between]: [start_date, end_date]
              }
            })
          },
          attributes: []
        },
        {
          model: req.db.models.Product,
          where,
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
      message: 'Failed to get product performance report'
    });
  }
}

/**
 * Get customer analytics
 */
async function getCustomerAnalytics(req, res) {
  try {
    const { start_date, end_date, store_id } = req.query;

    const where = {};
    if (store_id) where.store_id = store_id;

    // Total customers
    const totalCustomers = await req.db.models.Customer.count();

    // New customers in period
    const newCustomers = await req.db.models.Customer.count({
      where: {
        ...(start_date && end_date && {
          created_at: {
            [Sequelize.Op.between]: [start_date, end_date]
          }
        })
      }
    });

    // Top customers by revenue
    const topCustomers = await req.db.models.Invoice.findAll({
      attributes: [
        'customer_id',
        [Sequelize.fn('SUM', Sequelize.col('total')), 'total_spent'],
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'invoice_count']
      ],
      where: {
        ...where,
        status: 'paid',
        ...(start_date && end_date && {
          payment_date: {
            [Sequelize.Op.between]: [start_date, end_date]
          }
        })
      },
      include: [
        {
          model: req.db.models.Customer,
          attributes: ['id', 'name', 'email', 'phone']
        }
      ],
      group: ['customer_id'],
      order: [[Sequelize.fn('SUM', Sequelize.col('total')), 'DESC']],
      limit: 10
    });

    res.json({
      success: true,
      data: {
        total_customers: totalCustomers,
        new_customers: newCustomers,
        top_customers: topCustomers
      }
    });
  } catch (error) {
    console.error('Error getting customer analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get customer analytics'
    });
  }
}

/**
 * Get dashboard overview
 */
async function getDashboardOverview(req, res) {
  try {
    const { store_id } = req.query;
    const today = moment().format('YYYY-MM-DD');
    const thisMonth = moment().startOf('month').format('YYYY-MM-DD');
    const lastMonth = moment().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
    const lastMonthEnd = moment().subtract(1, 'month').endOf('month').format('YYYY-MM-DD');

    const where = {};
    if (store_id) where.store_id = store_id;

    // Today's sales
    const todaySales = await req.db.models.POSTransaction.sum('total', {
      where: {
        ...where,
        status: 'completed',
        created_at: {
          [Sequelize.Op.gte]: today
        }
      }
    }) || 0;

    // This month's sales
    const thisMonthSales = await req.db.models.POSTransaction.sum('total', {
      where: {
        ...where,
        status: 'completed',
        created_at: {
          [Sequelize.Op.gte]: thisMonth
        }
      }
    }) || 0;

    // Last month's sales
    const lastMonthSales = await req.db.models.POSTransaction.sum('total', {
      where: {
        ...where,
        status: 'completed',
        created_at: {
          [Sequelize.Op.between]: [lastMonth, lastMonthEnd]
        }
      }
    }) || 0;

    // Low stock products
    const lowStockProducts = await req.db.models.Product.count({
      where: {
        ...where,
        is_active: true,
        stock: {
          [Sequelize.Op.lte]: Sequelize.col('low_stock_threshold')
        }
      }
    });

    // Pending invoices
    const pendingInvoices = await req.db.models.Invoice.count({
      where: {
        ...where,
        status: {
          [Sequelize.Op.in]: ['draft', 'sent']
        }
      }
    });

    // Today's transactions
    const todayTransactions = await req.db.models.POSTransaction.count({
      where: {
        ...where,
        status: 'completed',
        created_at: {
          [Sequelize.Op.gte]: today
        }
      }
    });

    // Calculate growth
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
      message: 'Failed to get dashboard overview'
    });
  }
}

module.exports = {
  getSalesReport,
  getProductPerformanceReport,
  getCustomerAnalytics,
  getDashboardOverview
};

