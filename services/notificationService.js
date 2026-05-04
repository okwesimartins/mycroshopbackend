/**
 * Notification Service
 * Firebase push notifications with deduplication.
 * All notifications go to the business owner (tenant), not the customer.
 */

const { mainSequelize } = require('../config/database');

// ── Internal helpers ──────────────────────────────────────────────────────────

async function getDeviceTokens(tenantId) {
  try {
    const [rows] = await mainSequelize.query(
      'SELECT token FROM device_tokens WHERE tenant_id = ?',
      { replacements: [tenantId] }
    );
    return rows.map(r => r.token);
  } catch (_) { return []; }
}

async function hasNotificationBeenSent(tenantId, type, referenceId) {
  try {
    const [rows] = await mainSequelize.query(
      'SELECT id FROM notifications_sent WHERE tenant_id = ? AND type = ? AND reference_id = ? LIMIT 1',
      { replacements: [tenantId, type, String(referenceId)] }
    );
    return rows.length > 0;
  } catch (_) { return false; }
}

async function markNotificationSent(tenantId, type, referenceId) {
  try {
    await mainSequelize.query(
      'INSERT IGNORE INTO notifications_sent (tenant_id, type, reference_id) VALUES (?, ?, ?)',
      { replacements: [tenantId, type, String(referenceId)] }
    );
  } catch (_) {}
}

async function removeInvalidTokens(invalidTokens) {
  if (!invalidTokens?.length) return;
  try {
    await mainSequelize.query(
      `DELETE FROM device_tokens WHERE token IN (${invalidTokens.map(() => '?').join(',')})`,
      { replacements: invalidTokens }
    );
  } catch (_) {}
}

function fmt(num) {
  return Number(num || 0).toLocaleString('en-NG');
}

// ── New Order ─────────────────────────────────────────────────────────────────

async function notifyNewOrder(tenantId, order) {
  if (!tenantId) return;

  const orderId = order?.id || order?.dataValues?.id;
  if (!orderId) return;

  const dedupeKey = `order_${orderId}`;
  if (await hasNotificationBeenSent(tenantId, 'new_order', dedupeKey)) return;

  const tokens = await getDeviceTokens(tenantId);
  if (!tokens.length) return;

  const d = order?.dataValues || order;
  const orderNumber    = d.order_number    || `#${orderId}`;
  const customerName   = d.customer_name   || 'A customer';
  const customerPhone  = d.customer_phone  || '';
  const customerEmail  = d.customer_email  || '';
  const total          = d.total           || 0;
  const subtotal       = d.subtotal        || 0;
  const shippingAmount = d.shipping_amount || 0;
  const status         = d.status          || 'pending';
  const paymentStatus  = d.payment_status  || 'pending';
  const paymentMethod  = d.payment_method  || '';
  const city           = d.city            || '';
  const state          = d.state           || '';
  const notes          = d.notes           || '';
  const createdAt      = d.created_at      ? String(d.created_at) : '';

  const { sendToTokens } = require('./firebaseService');
  const result = await sendToTokens(
    tokens,
    '🛍️ New Order Received!',
    `${customerName} placed order ${orderNumber} for ₦${fmt(total)}`,
    {
      type:            'new_order',
      order_id:        String(orderId),
      order_number:    orderNumber,
      customer_name:   customerName,
      customer_phone:  customerPhone,
      customer_email:  customerEmail,
      total:           String(total),
      subtotal:        String(subtotal),
      shipping_amount: String(shippingAmount),
      status,
      payment_status:  paymentStatus,
      payment_method:  paymentMethod,
      city,
      state,
      notes,
      created_at:      createdAt
    }
  );

  if (result.invalidTokens?.length) await removeInvalidTokens(result.invalidTokens);
  if (result.successCount > 0) await markNotificationSent(tenantId, 'new_order', dedupeKey);
}

// ── Low Stock / Out of Stock ──────────────────────────────────────────────────

async function notifyLowStock(tenantId, products) {
  if (!tenantId || !products?.length) return;

  const tokens = await getDeviceTokens(tenantId);
  if (!tokens.length) return;

  const { sendToTokens } = require('./firebaseService');

  for (const product of products) {
    const productId = product.id;
    const stock = product.stock;
    const isOutOfStock = stock !== null && stock <= 0;
    const type = isOutOfStock ? 'out_of_stock' : 'low_stock';

    const today = new Date().toISOString().slice(0, 10);
    if (await hasNotificationBeenSent(tenantId, type, `product_${productId}_${today}`)) continue;

    const title = isOutOfStock
      ? `⚠️ Out of Stock: ${product.name}`
      : `📉 Low Stock: ${product.name}`;
    const body = isOutOfStock
      ? `${product.name} is out of stock. Restock now to avoid missing orders.`
      : `${product.name} is running low — only ${stock} unit${stock === 1 ? '' : 's'} left.`;

    const result = await sendToTokens(tokens, title, body, {
      type,
      product_id:   String(productId),
      product_name: product.name,
      stock:        String(stock)
    });

    if (result.invalidTokens?.length) await removeInvalidTokens(result.invalidTokens);
    if (result.successCount > 0) await markNotificationSent(tenantId, type, `product_${productId}_${today}`);
  }
}

async function checkLowStockAfterOrder(tenantId, orderItems, models, isFreePlan) {
  if (!tenantId || !orderItems?.length) return;

  const productIds = [...new Set(
    orderItems.map(item => item.product_id || item.dataValues?.product_id).filter(Boolean)
  )];
  if (!productIds.length) return;

  const whereClause = { id: productIds };
  if (isFreePlan && tenantId) whereClause.tenant_id = tenantId;

  const products = await models.Product.findAll({
    where: whereClause,
    attributes: ['id', 'name', 'stock', 'low_stock_threshold']
  });

  const lowStock = products.filter(p => {
    const s = p.stock ?? p.dataValues?.stock;
    const t = p.low_stock_threshold ?? p.dataValues?.low_stock_threshold;
    return s !== null && t !== null && s <= t;
  });

  if (lowStock.length) {
    await notifyLowStock(tenantId, lowStock.map(p => p.dataValues || p));
  }
}

async function checkTenantLowStock(tenantId, sequelize, isFreePlan) {
  if (!tenantId) return;
  try {
    const tf = isFreePlan ? 'AND tenant_id = :tenantId' : '';
    const [products] = await sequelize.query(`
      SELECT id, name, stock, low_stock_threshold
      FROM products
      WHERE track_stock = 1
        AND low_stock_threshold IS NOT NULL
        AND stock IS NOT NULL
        AND stock <= low_stock_threshold
        ${tf}
    `, { replacements: isFreePlan ? { tenantId } : {} });

    if (products.length) {
      await notifyLowStock(tenantId, products);
    }
  } catch (err) {
    console.error(`[LowStock] Tenant ${tenantId}:`, err.message);
  }
}

async function checkAllTenantsLowStock() {
  const { getTenantConnection } = require('../config/database');
  const [tenants] = await mainSequelize.query(
    `SELECT id, subscription_plan FROM tenants WHERE status = 'active'`
  );
  for (const t of tenants) {
    try {
      const seq = await getTenantConnection(t.id, t.subscription_plan || 'enterprise');
      await checkTenantLowStock(t.id, seq, t.subscription_plan === 'free');
    } catch (err) {
      console.error(`[LowStock] Tenant ${t.id}:`, err.message);
    }
  }
  console.log(`✅ Low stock check completed for ${tenants.length} tenants`);
}

// ── Analytics helpers ─────────────────────────────────────────────────────────

async function queryDailyStats(sequelize, isFreePlan, tenantId, date) {
  const tf = isFreePlan ? 'AND tenant_id = :tenantId' : '';
  const rep = isFreePlan ? { tenantId, date } : { date };

  const [[orders]] = await sequelize.query(`
    SELECT
      COUNT(*)                                                        AS orders_count,
      COALESCE(SUM(total), 0)                                        AS orders_revenue,
      SUM(payment_status = 'paid')                                   AS orders_paid,
      SUM(status = 'pending')                                        AS orders_pending,
      SUM(status = 'cancelled')                                      AS orders_cancelled,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END),0) AS paid_revenue
    FROM online_store_orders
    WHERE DATE(created_at) = :date ${tf}
  `, { replacements: rep });

  const [[invoices]] = await sequelize.query(`
    SELECT
      COUNT(*)                            AS invoices_count,
      COALESCE(SUM(total), 0)            AS invoices_revenue,
      SUM(status = 'paid')               AS invoices_paid,
      SUM(status IN ('sent','overdue'))   AS invoices_outstanding
    FROM invoices
    WHERE DATE(created_at) = :date ${tf}
  `, { replacements: rep }).catch(() => [[{ invoices_count: 0, invoices_revenue: 0, invoices_paid: 0, invoices_outstanding: 0 }]]);

  const [[customers]] = await sequelize.query(`
    SELECT COUNT(*) AS new_customers
    FROM customers
    WHERE DATE(created_at) = :date ${tf}
  `, { replacements: rep }).catch(() => [[{ new_customers: 0 }]]);

  const [[topProduct]] = await sequelize.query(`
    SELECT p.name, CAST(SUM(oi.quantity) AS UNSIGNED) AS qty, SUM(oi.total) AS revenue
    FROM online_store_order_items oi
    INNER JOIN products p ON p.id = oi.product_id
    INNER JOIN online_store_orders o ON o.id = oi.order_id
    WHERE DATE(o.created_at) = :date ${isFreePlan ? 'AND oi.tenant_id = :tenantId' : ''}
    GROUP BY p.id, p.name
    ORDER BY revenue DESC LIMIT 1
  `, { replacements: rep }).catch(() => [[null]]);

  const [[receipts]] = await sequelize.query(`
    SELECT COUNT(*) AS receipts_count
    FROM receipts
    WHERE DATE(created_at) = :date ${tf}
  `, { replacements: rep }).catch(() => [[{ receipts_count: 0 }]]);

  return { orders, invoices, customers, topProduct, receipts };
}

async function queryWeeklyStats(sequelize, isFreePlan, tenantId, weekStart, weekEnd) {
  const tf = isFreePlan ? 'AND tenant_id = :tenantId' : '';
  const rep = isFreePlan ? { tenantId, weekStart, weekEnd } : { weekStart, weekEnd };

  const [[orders]] = await sequelize.query(`
    SELECT
      COUNT(*)                                                           AS orders_count,
      COALESCE(SUM(total), 0)                                           AS orders_revenue,
      SUM(payment_status = 'paid')                                      AS orders_paid,
      SUM(status = 'cancelled')                                         AS orders_cancelled,
      COALESCE(SUM(CASE WHEN payment_status='paid' THEN total END), 0)  AS paid_revenue,
      COALESCE(AVG(CASE WHEN payment_status='paid' THEN total END), 0)  AS avg_order_value
    FROM online_store_orders
    WHERE created_at BETWEEN :weekStart AND :weekEnd ${tf}
  `, { replacements: rep });

  const [[lastWeek]] = await sequelize.query(`
    SELECT COALESCE(SUM(CASE WHEN payment_status='paid' THEN total END), 0) AS paid_revenue
    FROM online_store_orders
    WHERE created_at BETWEEN DATE_SUB(:weekStart, INTERVAL 7 DAY) AND DATE_SUB(:weekEnd, INTERVAL 7 DAY) ${tf}
  `, { replacements: rep });

  const [[invoices]] = await sequelize.query(`
    SELECT
      COUNT(*) AS invoices_count,
      COALESCE(SUM(total), 0) AS invoices_revenue,
      SUM(status = 'paid') AS invoices_paid
    FROM invoices
    WHERE created_at BETWEEN :weekStart AND :weekEnd ${tf}
  `, { replacements: rep }).catch(() => [[{ invoices_count: 0, invoices_revenue: 0, invoices_paid: 0 }]]);

  const [[customers]] = await sequelize.query(`
    SELECT COUNT(*) AS new_customers
    FROM customers
    WHERE created_at BETWEEN :weekStart AND :weekEnd ${tf}
  `, { replacements: rep }).catch(() => [[{ new_customers: 0 }]]);

  const [topProducts] = await sequelize.query(`
    SELECT p.name, CAST(SUM(oi.quantity) AS UNSIGNED) AS qty, SUM(oi.total) AS revenue
    FROM online_store_order_items oi
    INNER JOIN products p ON p.id = oi.product_id
    INNER JOIN online_store_orders o ON o.id = oi.order_id
    WHERE o.created_at BETWEEN :weekStart AND :weekEnd ${isFreePlan ? 'AND oi.tenant_id = :tenantId' : ''}
    GROUP BY p.id, p.name ORDER BY revenue DESC LIMIT 3
  `, { replacements: rep }).catch(() => [[]]);

  // Best performing day of the week
  const [bestDay] = await sequelize.query(`
    SELECT DAYNAME(created_at) AS day_name, SUM(total) AS day_revenue
    FROM online_store_orders
    WHERE created_at BETWEEN :weekStart AND :weekEnd AND payment_status = 'paid' ${tf}
    GROUP BY DAYNAME(created_at), DAYOFWEEK(created_at)
    ORDER BY day_revenue DESC LIMIT 1
  `, { replacements: rep }).catch(() => [[]]);

  return { orders, lastWeek, invoices, customers, topProducts, bestDay: bestDay[0] || null };
}

// ── Daily Analytics Notification ─────────────────────────────────────────────

async function sendDailyAnalytics(tenantId, sequelize, isFreePlan, date) {
  if (!tenantId) return;

  const reportDate = date || new Date().toISOString().slice(0, 10);
  const dedupeKey  = `daily_${reportDate}`;
  if (await hasNotificationBeenSent(tenantId, 'daily_report', dedupeKey)) return;

  const tokens = await getDeviceTokens(tenantId);
  if (!tokens.length) return;

  const { orders, invoices, customers, topProduct, receipts } =
    await queryDailyStats(sequelize, isFreePlan, tenantId, reportDate);

  // Skip if nothing happened today
  if (Number(orders.orders_count) === 0 && Number(invoices.invoices_count) === 0) return;

  const ordersCount   = Number(orders.orders_count   || 0);
  const ordersRevenue = Number(orders.orders_revenue || 0);
  const invoicesCount = Number(invoices.invoices_count || 0);

  const dateLabel = new Date(reportDate + 'T12:00:00').toLocaleDateString('en-NG', {
    day: 'numeric', month: 'short', year: 'numeric'
  });

  const bodyParts = [];
  if (ordersCount)   bodyParts.push(`${ordersCount} order${ordersCount > 1 ? 's' : ''}`);
  if (ordersRevenue) bodyParts.push(`₦${fmt(ordersRevenue)} revenue`);
  if (invoicesCount) bodyParts.push(`${invoicesCount} invoice${invoicesCount > 1 ? 's' : ''}`);

  const { sendToTokens } = require('./firebaseService');
  const result = await sendToTokens(
    tokens,
    `📊 Daily Report — ${dateLabel}`,
    bodyParts.join(' · ') || 'Check your daily performance summary',
    {
      type:                  'daily_report',
      report_date:           reportDate,
      // Orders
      orders_count:          String(orders.orders_count          || 0),
      orders_revenue:        String(orders.orders_revenue        || 0),
      orders_paid:           String(orders.orders_paid           || 0),
      orders_pending:        String(orders.orders_pending        || 0),
      orders_cancelled:      String(orders.orders_cancelled      || 0),
      paid_revenue:          String(orders.paid_revenue          || 0),
      // Invoices
      invoices_count:        String(invoices.invoices_count      || 0),
      invoices_revenue:      String(invoices.invoices_revenue    || 0),
      invoices_paid:         String(invoices.invoices_paid       || 0),
      invoices_outstanding:  String(invoices.invoices_outstanding|| 0),
      // Customers
      new_customers:         String(customers.new_customers      || 0),
      // Receipts
      receipts_count:        String(receipts.receipts_count      || 0),
      // Top product
      top_product_name:      topProduct?.name    || '',
      top_product_revenue:   String(topProduct?.revenue || 0),
      top_product_qty:       String(topProduct?.qty     || 0)
    }
  );

  if (result.invalidTokens?.length) await removeInvalidTokens(result.invalidTokens);
  if (result.successCount > 0) await markNotificationSent(tenantId, 'daily_report', dedupeKey);
}

// ── Weekly Analytics Notification ────────────────────────────────────────────

async function sendWeeklyAnalytics(tenantId, sequelize, isFreePlan) {
  if (!tenantId) return;

  // Week = last Monday 00:00 to last Sunday 23:59
  const now       = new Date();
  const dayOfWeek = now.getDay() || 7; // make Sunday = 7
  const weekEnd   = new Date(now);
  weekEnd.setDate(now.getDate() - (dayOfWeek - 7));
  weekEnd.setHours(23, 59, 59, 0);
  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekEnd.getDate() - 6);
  weekStart.setHours(0, 0, 0, 0);

  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const weekEndStr   = weekEnd.toISOString().slice(0, 10);
  const dedupeKey    = `weekly_${weekStartStr}`;

  if (await hasNotificationBeenSent(tenantId, 'weekly_report', dedupeKey)) return;

  const tokens = await getDeviceTokens(tenantId);
  if (!tokens.length) return;

  const { orders, lastWeek, invoices, customers, topProducts, bestDay } =
    await queryWeeklyStats(sequelize, isFreePlan, tenantId, weekStartStr + ' 00:00:00', weekEndStr + ' 23:59:59');

  if (Number(orders.orders_count) === 0 && Number(invoices.invoices_count) === 0) return;

  // Revenue change vs last week (as integer percentage, e.g. "+12" or "-5")
  const thisRevenue = Number(orders.paid_revenue || 0);
  const lastRevenue = Number(lastWeek.paid_revenue || 0);
  let revenueChangePct = '0';
  if (lastRevenue > 0) {
    revenueChangePct = String(Math.round(((thisRevenue - lastRevenue) / lastRevenue) * 100));
  } else if (thisRevenue > 0) {
    revenueChangePct = '+100';
  }

  const fulfillmentRate = Number(orders.orders_count) > 0
    ? String(Math.round((Number(orders.orders_paid) / Number(orders.orders_count)) * 100))
    : '0';

  const startLabel = new Date(weekStartStr + 'T12:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
  const endLabel   = new Date(weekEndStr   + 'T12:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });

  const top1 = topProducts[0] || null;
  const top2 = topProducts[1] || null;
  const top3 = topProducts[2] || null;

  const bodyParts = [];
  if (orders.orders_count) bodyParts.push(`${orders.orders_count} orders`);
  if (thisRevenue)          bodyParts.push(`₦${fmt(thisRevenue)} revenue`);
  if (customers.new_customers) bodyParts.push(`${customers.new_customers} new customers`);

  const { sendToTokens } = require('./firebaseService');
  const result = await sendToTokens(
    tokens,
    `📈 Weekly Report — ${startLabel}–${endLabel}`,
    bodyParts.join(' · ') || 'Check your weekly performance summary',
    {
      type:               'weekly_report',
      week_start:         weekStartStr,
      week_end:           weekEndStr,
      // Orders
      orders_count:       String(orders.orders_count    || 0),
      orders_revenue:     String(orders.orders_revenue  || 0),
      orders_paid:        String(orders.orders_paid     || 0),
      orders_cancelled:   String(orders.orders_cancelled|| 0),
      paid_revenue:       String(orders.paid_revenue    || 0),
      avg_order_value:    String(Math.round(Number(orders.avg_order_value || 0))),
      fulfillment_rate:   fulfillmentRate,
      revenue_change_pct: revenueChangePct,
      // Invoices
      invoices_count:     String(invoices.invoices_count   || 0),
      invoices_revenue:   String(invoices.invoices_revenue || 0),
      invoices_paid:      String(invoices.invoices_paid    || 0),
      // Customers
      new_customers:      String(customers.new_customers   || 0),
      // Best day
      best_day:           bestDay?.day_name    || '',
      best_day_revenue:   String(bestDay?.day_revenue || 0),
      // Top 3 products
      top1_name:          top1?.name     || '',
      top1_revenue:       String(top1?.revenue || 0),
      top1_qty:           String(top1?.qty     || 0),
      top2_name:          top2?.name     || '',
      top2_revenue:       String(top2?.revenue || 0),
      top2_qty:           String(top2?.qty     || 0),
      top3_name:          top3?.name     || '',
      top3_revenue:       String(top3?.revenue || 0),
      top3_qty:           String(top3?.qty     || 0)
    }
  );

  if (result.invalidTokens?.length) await removeInvalidTokens(result.invalidTokens);
  if (result.successCount > 0) await markNotificationSent(tenantId, 'weekly_report', dedupeKey);
}

// ── Batch senders (called by cron scripts) ────────────────────────────────────

async function sendDailyAnalyticsToAll(date) {
  const { getTenantConnection } = require('../config/database');
  const [tenants] = await mainSequelize.query(
    `SELECT id, subscription_plan FROM tenants WHERE status = 'active'`
  );
  for (const t of tenants) {
    try {
      const seq = await getTenantConnection(t.id, t.subscription_plan || 'enterprise');
      await sendDailyAnalytics(t.id, seq, t.subscription_plan === 'free', date);
    } catch (err) {
      console.error(`[DailyAnalytics] Tenant ${t.id}:`, err.message);
    }
  }
  console.log(`✅ Daily analytics sent to ${tenants.length} tenants`);
}

async function sendWeeklyAnalyticsToAll() {
  const { getTenantConnection } = require('../config/database');
  const [tenants] = await mainSequelize.query(
    `SELECT id, subscription_plan FROM tenants WHERE status = 'active'`
  );
  for (const t of tenants) {
    try {
      const seq = await getTenantConnection(t.id, t.subscription_plan || 'enterprise');
      await sendWeeklyAnalytics(t.id, seq, t.subscription_plan === 'free');
    } catch (err) {
      console.error(`[WeeklyAnalytics] Tenant ${t.id}:`, err.message);
    }
  }
  console.log(`✅ Weekly analytics sent to ${tenants.length} tenants`);
}

module.exports = {
  notifyNewOrder,
  notifyLowStock,
  checkLowStockAfterOrder,
  checkTenantLowStock,
  checkAllTenantsLowStock,
  sendDailyAnalytics,
  sendDailyAnalyticsToAll,
  sendWeeklyAnalytics,
  sendWeeklyAnalyticsToAll
};
