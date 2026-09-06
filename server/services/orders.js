/**
 * Orders: placement (the only place money is written), status flow, voiding,
 * reorder, and the aggregates behind the owner dashboard/history.
 */
import { all, get, insert, run, settings, metaGet, metaSet, getSetting, getNumberSetting, getBoolSetting, tx } from '../db/index.js';
import { loadCart, clearCart, fillFromItems } from './cart.js';
import { round2 } from '../lib/money.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { notifyOrderStatus, render, sendMessage } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { escapeLike } from '../lib/validate.js';

export const STATUS_FLOW = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
export const STATUS_LABELS = {
  placed: 'Placed',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

function nextPublicId() {
  const year = new Date().getUTCFullYear();
  const seq = Number(metaGet(`order_seq_${year}`) || 0) + 1;
  metaSet(`order_seq_${year}`, String(seq));
  return `SMV-${year}-${String(seq).padStart(4, '0')}`;
}

export function addressSnapshot(user, body) {
  const wanted = body.address_id ?? body.addressId;
  const addr = wanted ? get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [Number(wanted), user.id]) : null;
  if (wanted && !addr) throw notFound('That saved address no longer exists.');
  const src = addr || body.address || {};
  const line1 = String(src.line1 || '').trim();
  if (!line1) throw badRequest('A delivery address is required.', { fields: { line1: 'required' } });
  return {
    address_id: addr ? addr.id : null,
    label: src.label || (user.role === 'wholesale' ? 'Business' : 'Home'),
    contact_name: src.contact_name || user.full_name,
    contact_phone: src.contact_phone || user.mobile,
    line1,
    line2: src.line2 || '',
    area: src.area || '',
    city: src.city || 'Chennai',
    pincode: src.pincode || '',
    landmark: src.landmark || '',
    lat: Number.isFinite(Number(src.lat)) && src.lat !== '' && src.lat !== null ? Number(src.lat) : null,
    lng: Number.isFinite(Number(src.lng)) && src.lng !== '' && src.lng !== null ? Number(src.lng) : null,
  };
}

export function mapsUrl(snapshot) {
  if (!snapshot) return '';
  if (snapshot.lat && snapshot.lng) return `https://www.google.com/maps/dir/?api=1&destination=${snapshot.lat},${snapshot.lng}`;
  const q = [snapshot.line1, snapshot.line2, snapshot.area, snapshot.city, snapshot.pincode].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || getSetting('google_maps_query', 'Chennai'))}`;
}

/**
 * Place an order. Everything about the amount is derived here from the server
 * cart — the request body only carries address + payment method, so a crafted
 * request can never inject a price.
 */
export async function createOrder({ user, body }) {
  const s = settings();
  if (!getBoolSetting('shop_open', true)) {
    throw conflict('Sathvika MV is closed right now. Please place your order once the store reopens.', { code: 'shop_closed' });
  }
  const paymentMethod = body.payment_method === 'upi' ? 'upi' : 'cod';
  if (paymentMethod === 'cod' && !getBoolSetting('cod_enabled', true)) {
    throw badRequest('Cash on delivery is temporarily disabled. Please pay by UPI.');
  }
  if (paymentMethod === 'cod' && !['retail', 'wholesale'].includes(user.role)) {
    throw badRequest('Unsupported account for COD.');
  }
  const paymentApp = ['gpay', 'phonepe', 'paytm', 'other'].includes(body.payment_app) ? body.payment_app : 'other';

  const cart = loadCart(user.id, user);
  if (!cart.lines.length) throw badRequest('Your cart is empty.');
  if (cart.blocking_lines.length) {
    throw conflict(`Some items need attention: ${cart.blocking_lines.map((b) => `${b.name} — ${b.errors[0]}`).join(' · ')}`, {
      code: 'cart_invalid',
      cart,
    });
  }
  if (!cart.min_order_met) {
    throw conflict(`Minimum order is ₹${Math.round(cart.min_order_value)}. Add ₹${Math.round(cart.min_order_short_by)} more.`, {
      code: 'min_order',
      cart,
    });
  }

  const snapshot = addressSnapshot(user, body);
  const eta = Math.max(10, Math.min(1440, Number(body.eta_minutes || s.eta_minutes || 90)));
  const promised = new Date(Date.now() + eta * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const instructions = String(body.instructions || '').slice(0, 280) || null;
  const upiRef = String(body.upi_ref || '').slice(0, 40) || null;

  const result = tx(() => {
    const publicId = nextPublicId();
    // Orders always land in a shift: reuse the open one, else auto-open it so
    // online orders placed before the counter tablet logs in are never lost.
    const shift = currentShift() || openShift('auto', 'Auto-opened for online orders');
    const orderId = insert('orders', {
      public_id: publicId,
      user_id: user.id,
      shift_id: shift ? shift.id : null,
      account_type: cart.account_type,
      status: 'placed',
      subtotal: cart.subtotal,
      mrp_value: cart.mrp_value,
      discount: cart.discount,
      delivery_charge: cart.delivery_charge,
      total: cart.total,
      payment_method: paymentMethod,
      payment_app: paymentApp,
      payment_status: paymentMethod === 'cod' ? 'cash_due' : 'pending',
      upi_ref: upiRef,
      address_snapshot: JSON.stringify(snapshot),
      instructions,
      eta_minutes: eta,
      promised_at: promised,
    });

    for (const line of cart.lines) {
      insert('order_items', {
        order_id: orderId,
        product_id: line.product_id,
        name: line.name,
        brand: line.brand,
        category: line.category,
        pack_size: line.pack_size,
        unit: line.unit,
        qty: line.qty,
        mrp: line.mrp,
        unit_price: line.unit_price,
        line_total: line.line_total,
        price_scope: line.price_scope,
        tier_label: line.tier_label,
      });
      // Consume stock so the counter sees reality; NULL stock = "we sell by count, don't track".
      run(
        `UPDATE products SET
           stock_qty = CASE WHEN stock_qty IS NULL THEN NULL ELSE MAX(0, ROUND(stock_qty - ?, 3)) END,
           updated_at = datetime('now')
         WHERE id = ?`,
        [line.qty, line.product_id],
      );
    }
    refreshStockStatus(cart.lines.map((l) => l.product_id));
    clearCart(user.id);

    if (upiRef) {
      insert('payment_events', {
        order_id: orderId,
        actor: 'customer',
        action: 'customer_claimed',
        amount: cart.total,
        ref: upiRef,
        note: 'Customer entered a UPI reference at checkout — owner verifies in Online Payment Update.',
      });
    }

    audit({
      actorType: 'customer',
      actorId: user.id,
      actorLabel: user.full_name,
      action: 'order.place',
      entity: 'order',
      entityId: orderId,
      detail: `${publicId} · ₹${cart.total} · ${paymentMethod} · ${cart.lines.length} lines · ${cart.account_type} pricing`,
    });

    const order = get('SELECT * FROM orders WHERE id=?', [orderId]);
    return { order: decorate(order), payment: upiIntent(order, cart.total, snapshot) };
  });
  await notifyOrderStatus({ order: result.order, user, status: 'placed' });
  return result;
}

/** Generic UPI deep link — GPay/PhonePe/Paytm/BHIM all understand this. */
export function upiIntent(order, amount, snapshot) {
  const s = settings();
  const params = new URLSearchParams({
    pa: s.upi_id || 'sathvika.mv@okaxis',
    pn: s.upi_display_name || 'Sathvika MV',
    am: round2(Number(amount)).toFixed(2),
    cu: 'INR',
    tn: `Order ${order.public_id}`,
    tr: order.public_id,
  });
  return {
    upi_id: s.upi_id,
    display_name: s.upi_display_name,
    amount: round2(Number(amount)),
    intent: `${getSetting('upi_intent_scheme', 'upi')}://pay?${params.toString()}`,
    note: 'Pay with any UPI app, then tap "I have paid". The counter reconciles the amount before confirming.',
  };
}

export function ordersForUser(userId, { limit = 30 } = {}) {
  const rows = all(
    `SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id=o.id) AS line_count,
            (SELECT COALESCE(SUM(qty),0) FROM order_items oi WHERE oi.order_id=o.id) AS unit_count
     FROM orders o WHERE o.user_id = ? AND o.voided = 0 ORDER BY o.id DESC LIMIT ?`,
    [userId, Math.min(100, Number(limit) || 30)],
  );
  return rows.map(decorate);
}

export function orderDetail(orderId, user) {
  const row = get('SELECT * FROM orders WHERE id = ?', [Number(orderId) || 0]);
  if (!row) throw notFound('Order not found.');
  if (user && user.id !== row.user_id) throw new AppError(403, 'This order belongs to another account.');
  const items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [row.id]);
  const userRow = get('SELECT id, full_name, mobile, role, business_name FROM users WHERE id = ?', [row.user_id]);
  return {
    ...decorate(row),
    items,
    customer: userRow,
    timeline: buildTimeline(row),
    can_cancel: ['placed', 'confirmed'].includes(row.status),
    can_reorder: true,
    notifications: all('SELECT id, channel, to_number, body, status, created_at FROM notifications WHERE order_id = ? ORDER BY id', [row.id]),
  };
}

function decorate(row) {
  let address = null;
  try {
    address = row.address_snapshot ? JSON.parse(row.address_snapshot) : null;
  } catch {
    address = null;
  }
  const isWholesale = row.account_type === 'wholesale';
  return {
    ...row,
    address,
    maps_url: mapsUrl(address),
    status_label: STATUS_LABELS[row.status] || row.status,
    account_type: row.account_type,
    price_scope_label: isWholesale ? 'Wholesale' : 'Retail',
    voided: !!row.voided,
    next_status: nextStatus(row.status),
    can_move_forward: !!nextStatus(row.status),
  };
}

function nextStatus(status) {
  const i = STATUS_FLOW.indexOf(status);
  if (i === -1 || i === STATUS_FLOW.length - 1) return null;
  return STATUS_FLOW[i + 1];
}

function buildTimeline(row) {
  const stamps = {
    placed: row.placed_at,
    confirmed: row.confirmed_at,
    preparing: row.preparing_at,
    out_for_delivery: row.otd_at,
    delivered: row.delivered_at,
  };
  const steps = row.status === 'cancelled' ? ['placed', 'cancelled'] : STATUS_FLOW;
  const reached = row.status === 'cancelled' ? 2 : STATUS_FLOW.indexOf(row.status) + 1;
  return steps.map((key, i) => ({
    key,
    label: STATUS_LABELS[key] || key,
    at: key === 'cancelled' ? row.cancelled_at : stamps[key] || null,
    done: i < reached,
    current: (row.status === 'cancelled' ? 'cancelled' : row.status) === key,
  }));
}

/** Owner/customer-driven status changes. Returns the updated order. */
export async function changeStatus(orderId, status, { actor = 'owner', reason = null, silent = false } = {}) {
  const order = get('SELECT * FROM orders WHERE id = ?', [Number(orderId) || 0]);
  if (!order) throw notFound('Order not found.');
  if (order.voided) throw conflict('This order was voided on the counter and cannot move forward.');
  if (!STATUS_FLOW.includes(status) && status !== 'cancelled') throw badRequest('Unknown status.');
  if (order.status === status) return decorate(order);

  if (status !== 'cancelled') {
    const from = STATUS_FLOW.indexOf(order.status);
    const to = STATUS_FLOW.indexOf(status);
    // Allow forward jumps (busy counter) and one step back for corrections.
    if (to < from - 1) throw badRequest(`Cannot move an order from ${STATUS_LABELS[order.status]} back to ${STATUS_LABELS[status]}.`);
  } else if (order.status === 'delivered' && order.payment_status === 'cash_collected') {
    throw conflict('Cash for this order is already collected. Use refund in Online Payment Update first.');
  }

  const col = {
    confirmed: 'confirmed_at',
    preparing: 'preparing_at',
    out_for_delivery: 'otd_at',
    delivered: 'delivered_at',
    cancelled: 'cancelled_at',
  }[status];

  run(`UPDATE orders SET status=?, ${col}=datetime('now')${status === 'cancelled' ? ', cancel_reason=?' : ''} WHERE id=?`, [
    status,
    ...(status === 'cancelled' ? [reason || 'Cancelled at the counter'] : []),
    order.id,
  ]);
  if (status === 'delivered') {
    run("UPDATE orders SET payment_status=CASE WHEN payment_method='cod' THEN 'cash_collected' ELSE payment_status END WHERE id=?", [order.id]);
  }

  const updated = get('SELECT * FROM orders WHERE id=?', [order.id]);
  const user = get('SELECT id, mobile, full_name, business_name, lang FROM users WHERE id=?', [order.user_id]);
  if (!silent && user) {
    await notifyOrderStatus({
      order: { ...updated, eta_minutes: getNumberSetting('eta_minutes', 90) },
      user,
      status,
      extra: { reason: reason || undefined },
    });
  }
  audit({
    actorType: actor === 'customer' ? 'customer' : 'owner',
    actorId: actor === 'customer' ? user?.id : null,
    actorLabel: actor === 'customer' ? user?.full_name || 'customer' : 'owner',
    action: `order.status.${status}`,
    entity: 'order',
    entityId: order.id,
    detail: reason || undefined,
  });
  return decorate(updated);
}

/** "Scratch" — void an order so it disappears from live totals but stays in history. */
export async function voidOrder(orderId, reason, { actor = 'owner', notify = true } = {}) {
  const order = get('SELECT * FROM orders WHERE id = ?', [Number(orderId) || 0]);
  if (!order) throw notFound('Order not found.');
  if (order.voided) throw conflict('That order is already voided.');
  if (!reason || !String(reason).trim()) throw badRequest('A short reason is required when voiding an order.');

  run(
    `UPDATE orders SET voided=1, void_note=?, voided_at=datetime('now'), status='cancelled', cancelled_at=datetime('now'),
            cancel_reason=?, payment_status=CASE WHEN payment_status IN ('paid','cash_collected') THEN 'refunded' ELSE 'failed' END
     WHERE id=?`,
    [String(reason).slice(0, 300), `Voided at counter: ${String(reason).slice(0, 160)}`, order.id],
  );
  restoreStock(order.id);
  const updated = get('SELECT * FROM orders WHERE id=?', [order.id]);
  const user = get('SELECT id, mobile, full_name, lang FROM users WHERE id=?', [order.user_id]);
  if (notify && user) {
    await sendMessage({
      to: user.mobile,
      userId: user.id,
      orderId: order.id,
      template: 'order_cancelled',
      body: render('order_cancelled', { order_no: order.public_id, reason: String(reason).slice(0, 120) }, user.lang === 'ta' ? 'ta' : 'en'),
    });
  }
  audit({ actorType: 'owner', actorLabel: actor, action: 'order.void', entity: 'order', entityId: order.id, detail: reason });
  return decorate(updated);
}

function restoreStock(orderId) {
  const items = all('SELECT product_id, qty FROM order_items WHERE order_id=?', [orderId]);
  for (const it of items) {
    if (!it.product_id) continue;
    run('UPDATE products SET stock_qty = CASE WHEN stock_qty IS NULL THEN NULL ELSE ROUND(stock_qty + ?, 3) END WHERE id=?', [it.qty, it.product_id]);
  }
  refreshStockStatus(items.map((i) => i.product_id).filter(Boolean));
}

function refreshStockStatus(ids) {
  const threshold = getNumberSetting('low_stock_threshold', 5);
  for (const id of ids) {
    run(
      `UPDATE products SET
         stock_status = CASE
           WHEN stock_qty IS NULL THEN stock_status
           WHEN stock_qty <= 0 THEN 'out_of_stock'
           WHEN stock_qty <= IFNULL(low_stock_qty, ?) THEN 'low_stock'
           ELSE 'in_stock' END,
         is_active = CASE WHEN stock_qty IS NOT NULL AND stock_qty <= 0 THEN is_active ELSE is_active END,
         updated_at = datetime('now')
       WHERE id = ?`,
      [threshold, Number(id) || 0],
    );
  }
}

export { refreshStockStatus };

export function reorder(orderId, user, { mode = 'full', productIds = null, replace = false } = {}) {
  const order = get('SELECT * FROM orders WHERE id=?', [Number(orderId) || 0]);
  if (!order) throw notFound('Order not found.');
  if (order.user_id !== user.id) throw new AppError(403, 'You can only reorder your own orders.');
  const items = all('SELECT * FROM order_items WHERE order_id=?', [order.id]);
  const chosen = mode === 'partial' && Array.isArray(productIds) && productIds.length
    ? items.filter((i) => productIds.some((p) => Number(p) === i.product_id))
    : items;
  if (!chosen.length) throw badRequest('Pick at least one item to reorder.');
  const { skipped } = fillFromItems(
    user.id,
    chosen.map((i) => ({ product_id: i.product_id, qty: i.qty, name: i.name })),
    { replace },
  );
  const cart = loadCart(user.id, user);
  audit({ actorType: 'customer', actorId: user.id, actorLabel: user.full_name, action: 'cart.reorder', entity: 'order', entityId: order.id, detail: `${chosen.length - skipped.length} item(s) from ${order.public_id}` });
  return { cart, skipped, from: order.public_id, added: chosen.length - skipped.length };
}

// ------------------------------------------------------------------ reporting --
export function currentShift() {
  return get("SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1");
}

export function openShift(actor = 'owner', note = null) {
  const existing = currentShift();
  if (existing) return existing;
  const id = insert('shifts', { opened_by: actor, note });
  return get('SELECT * FROM shifts WHERE id=?', [id]);
}

export function closeShift(id, { note } = {}) {
  const shift = get('SELECT * FROM shifts WHERE id=?', [id]);
  if (!shift) throw notFound('Shift not found.');
  if (shift.closed_at) return shift;
  const summary = shiftSummary(id);
  run(
    `UPDATE shifts SET closed_at=datetime('now'), note=COALESCE(?, note), orders_count=?, gross_sales=?, online_rcvd=?, cod_rcvd=? WHERE id=?`,
    [note || null, summary.orders, summary.grand_total, summary.online_received, summary.cod_received, id],
  );
  return get('SELECT * FROM shifts WHERE id=?', [id]);
}

/** Four live summary cards + the numbers behind them. */
export function shiftSummary(shiftId) {
  const params = shiftId ? [shiftId] : [];
  const where = shiftId ? 'o.shift_id = ? AND o.voided = 0' : 'o.voided = 0';
  const agg = get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total),0) AS gross,
            COALESCE(SUM(CASE WHEN o.payment_method='upi' AND o.payment_status='paid' THEN o.total ELSE 0 END),0) AS online,
            COALESCE(SUM(CASE WHEN o.payment_method='cod' AND o.payment_status='cash_collected' THEN o.total ELSE 0 END),0) AS cod,
            COALESCE(SUM(CASE WHEN o.payment_method='cod' AND o.status<>'delivered' THEN o.total ELSE 0 END),0) AS cod_pending,
            COALESCE(SUM(o.discount),0) AS savings
     FROM orders o WHERE ${where}`,
    params,
  );
  return {
    orders: Number(agg.orders || 0),
    grand_total: round2(agg.gross),
    online_received: round2(agg.online),
    cod_received: round2(agg.cod),
    cod_pending: round2(agg.cod_pending),
    customer_savings: round2(agg.savings),
    awaiting_payment: Number(
      get(`SELECT COUNT(*) AS n FROM orders o WHERE ${where} AND o.payment_method='upi' AND o.payment_status='pending'`, params).n || 0,
    ),
    active_orders: Number(
      get(`SELECT COUNT(*) AS n FROM orders o WHERE ${where} AND o.status IN ('placed','confirmed','preparing','out_for_delivery')`, params).n || 0,
    ),
  };
}

export function shiftOrders(shiftId, { status = null, q = null } = {}) {
  const where = ['o.voided = 0'];
  const args = [];
  if (shiftId) {
    where.push('o.shift_id = ?');
    args.push(shiftId);
  }
  if (status && status !== 'all') {
    where.push('o.status = ?');
    args.push(status);
  }
  if (q) {
    where.push("(o.public_id LIKE ? OR u.full_name LIKE ? OR u.mobile LIKE ? OR IFNULL(u.business_name, '') LIKE ?)");
    const like = `%${escapeLike(String(q).trim())}%`;
    args.push(like, like, like, like);
  }
  const rows = all(
    `SELECT o.*, u.full_name AS customer_name, u.mobile AS customer_mobile, u.role AS customer_role,
            u.business_name, GROUP_CONCAT(oi.name || ' x' || oi.qty, ' | ') AS items_summary,
            COUNT(oi.id) AS line_count
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE ${where.join(' AND ')}
     GROUP BY o.id
     ORDER BY o.id DESC
     LIMIT 200`,
    args,
  );
  return rows.map((r) => ({
    ...decorate(r),
    customer: {
      name: r.customer_name || 'Walk-in',
      mobile: r.customer_mobile,
      role: r.customer_role,
      business_name: r.business_name,
    },
    items_summary: r.items_summary || '',
    line_count: Number(r.line_count || 0),
  }));
}

export function salesSummary(period = 'today') {
  const ranges = {
    today: "date(o.placed_at) = date('now')",
    week: "o.placed_at >= datetime('now','-7 days')",
    month: "o.placed_at >= datetime('now','-30 days')",
    all: '1=1',
  };
  const where = `${ranges[period] || ranges.today} AND o.voided = 0`;
  const agg = get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total),0) AS revenue,
            COALESCE(SUM(CASE WHEN o.payment_method='cod' THEN o.total ELSE 0 END),0) AS cod,
            COALESCE(SUM(o.discount),0) AS savings,
            COUNT(DISTINCT o.user_id) AS customers
     FROM orders o WHERE ${where}`,
  );
  return {
    period,
    orders: Number(agg.orders || 0),
    revenue: round2(agg.revenue),
    average_order_value: agg.orders ? round2(Number(agg.revenue) / Number(agg.orders)) : 0,
    cod_share: round2(agg.cod),
    customer_savings: round2(agg.savings),
    customers: Number(agg.customers || 0),
    top_products: topProducts(period),
  };
}

export function topProducts(period = 'month', limit = 8) {
  const ranges = {
    today: "date(o.placed_at) = date('now')",
    week: "o.placed_at >= datetime('now','-7 days')",
    month: "o.placed_at >= datetime('now','-30 days')",
    all: '1=1',
  };
  return all(
    `SELECT oi.product_id, oi.name, SUM(oi.qty) AS units, SUM(oi.line_total) AS revenue, COUNT(DISTINCT o.id) AS orders
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE ${ranges[period] || ranges.month} AND o.voided = 0
     GROUP BY oi.product_id, oi.name ORDER BY units DESC, revenue DESC LIMIT ?`,
    [limit],
  ).map((r) => ({ ...r, units: Number(r.units), revenue: round2(r.revenue), orders: Number(r.orders) }));
}

export function history({ from = null, to = null, status = null, q = null, limit = 80 } = {}) {
  const where = ['1=1'];
  const args = [];
  if (from) {
    where.push('date(o.placed_at) >= date(?)');
    args.push(from);
  }
  if (to) {
    where.push('date(o.placed_at) <= date(?)');
    args.push(to);
  }
  if (status && status !== 'all') {
    where.push('o.status = ?');
    args.push(status);
  }
  if (status === 'voided') {
    where.push('1=0');
  }
  if (q) {
    where.push('(o.public_id LIKE ? OR u.full_name LIKE ? OR u.mobile LIKE ? OR u.business_name LIKE ?)');
    const like = `%${String(q).trim()}%`;
    args.push(like, like, like, like);
  }
  const rows = all(
    `SELECT o.*, u.full_name AS customer_name, u.mobile AS customer_mobile, u.business_name,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id=o.id) AS line_count
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ?`,
    [...args, Math.min(400, Number(limit) || 80)],
  );
  const voided = q
    ? all(
        `SELECT o.*, u.full_name AS customer_name, u.mobile AS customer_mobile, u.business_name FROM orders o
         LEFT JOIN users u ON u.id=o.user_id
         WHERE o.voided=1 AND (o.public_id LIKE ? OR u.full_name LIKE ?) ORDER BY o.id DESC LIMIT 40`,
        [`%${String(q).trim()}%`, `%${String(q).trim()}%`],
      ).map(decorate)
    : [];
  return {
    orders: rows.map(decorate),
    voided: voided.map((r) => ({ ...r, voided: true })),
    shifts: all('SELECT * FROM shifts ORDER BY id DESC LIMIT 20').map((sh) => ({
      ...sh,
      summary: sh.closed_at
        ? { orders: sh.orders_count, grand_total: sh.gross_sales, online_received: sh.online_rcvd, cod_received: sh.cod_rcvd }
        : shiftSummary(sh.id),
    })),
  };
}

export function lowStockList(limit = 25) {
  return all(
    `SELECT id, name, stock_qty, low_stock_qty, stock_status FROM products
     WHERE is_active=1 AND stock_status IN ('low_stock','out_of_stock')
     ORDER BY CASE stock_status WHEN 'out_of_stock' THEN 0 ELSE 1 END, stock_qty ASC LIMIT ?`,
    [limit],
  );
}
