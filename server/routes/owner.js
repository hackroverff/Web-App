/**
 * Shop-owner side.
 *
 * Two-factor-by-design, as specified:
 *   1. PIN (4-6 digits)  → `ops` level: counter dashboard, order status, voiding,
 *                          payment reconciliation, shop open/close.
 *   2. Password          → `admin` level (expires after ELEVATED_MINUTES): price
 *                          edits, wholesale approvals, store settings.
 * That keeps the counter quick while pricing controls stay out of reach of anyone
 * who happens to see the PIN.
 */
import express from 'express';
import { config } from '../config.js';
import { all, get, insert, run, tx, update, settings, setSettings, getBoolSetting, getNumberSetting, dbStats } from '../db/index.js';
import { verifyPin, verifyPassword, hashPin } from '../lib/password.js';
import { createSession, destroySession, setSessionCookie, revokeUserSessions } from '../middleware/session.js';
import { requireOwner, requireElevated } from '../middleware/session.js';
import { rateLimit } from '../lib/ratelimit.js';
import { pin as vPin, password as vPassword, str, optStr, oneOf, intIn } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { audit, recentAudit } from '../lib/audit.js';
import { recentNotifications, sendMessage, render } from '../lib/notify.js';
import {
  currentShift,
  openShift,
  closeShift,
  shiftSummary,
  shiftOrders,
  changeStatus,
  voidOrder,
  salesSummary,
  history as orderHistory,
  lowStockList,
  orderDetail,
  mapsUrl,
  STATUS_FLOW,
} from '../services/orders.js';

export const router = express.Router();

const pinLimiter = rateLimit({ name: 'owner-pin', max: 12, windowMs: 5 * 60_000 });

// ------------------------------------------------------------------- access --
/**
 * PIN login. `pin_hash` lives in the DB (seeded from env on first boot) so the
 * shop can change it without a redeploy.
 */
router.post('/login', pinLimiter, async (req, res, next) => {
  try {
    const code = vPin(req.body?.pin);
    const staff = all("SELECT * FROM staff WHERE is_active=1 ORDER BY id ASC");
    let matched = null;
    for (const s of staff) {
      if (await verifyPin(code, s.pin_hash, config.pinPepper)) {
        matched = s;
        break;
      }
    }
    if (!matched) throw unauthorized('That PIN is not correct.');

    const session = createSession({ subject: 'owner', staffId: matched.id, level: 'ops', req });
    setSessionCookie(res, session);
    const shift = openShift(matched.username, 'Opened at counter login');
    update('staff', matched.id, { last_pin_login_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    audit({ actorType: 'owner', actorId: matched.id, actorLabel: matched.name, action: 'owner.pin_login', entity: 'shift', entityId: shift.id });
    res.json({
      level: 'ops',
      staff: publicStaff(matched),
      shift,
      dashboard: buildDashboard(shift.id),
      message: `Welcome back, ${matched.name.split(' ')[0]}. Shift #${shift.id} is open.`,
    });
  } catch (err) {
    next(err);
  }
});

/** Password step-up for sensitive actions. */
router.post('/elevate', pinLimiter, async (req, res, next) => {
  try {
    if (!req.staff) throw unauthorized('Enter your PIN first.');
    const pass = vPassword(req.body?.password, { min: 6 });
    const ok = await verifyPassword(pass, req.staff.password_hash);
    if (!ok) throw unauthorized('Password is not correct for this account.');
    if (req.staff.role !== 'owner') throw forbidden('Only the owner account can unlock pricing and approvals. Ask Lakshmi to enter her password.');
    const until = new Date(Date.now() + config.elevatedMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    update('sessions', req.session.token_hash, { level: 'admin', elevated_until: until }, 'token_hash');
    update('staff', req.staff.id, { last_admin_login_at: until });
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'owner.elevate' });
    res.json({ level: 'admin', elevated_until: until, minutes: config.elevatedMinutes, message: `Unlocked for ${config.elevatedMinutes} minutes.` });
  } catch (err) {
    next(err);
  }
});

router.post('/lock', (req, res, next) => {
  try {
    if (!req.session) throw unauthorized('Not signed in.');
    update('sessions', req.session.token_hash, { level: 'ops', elevated_until: null }, 'token_hash');
    res.json({ level: 'ops', message: 'Pricing controls locked again.' });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res, next) => {
  try {
    if (req.session) audit({ actorType: 'owner', actorId: req.staff?.id, actorLabel: req.staff?.name || 'owner', action: 'owner.logout' });
    destroySession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/session', (req, res) => {
  if (!req.staff) return res.json({ signed_in: false, level: 'anonymous' });
  const shift = currentShift();
  res.json({
    signed_in: true,
    level: req.level,
    elevated_until: req.session.elevated_until,
    minutes_left: req.level === 'admin' ? Math.max(0, Math.round((new Date(`${req.session.elevated_until}Z`) - Date.now()) / 60_000)) : 0,
    staff: publicStaff(req.staff),
    shift,
    shop_open: getBoolSetting('shop_open', true),
  });
});

// -------------------------------------------------------------- dashboards --
router.get('/dashboard', requireOwner, (req, res) => {
  const shift = currentShift() || openShift(req.staff.username, 'Auto-opened');
  res.json(buildDashboard(shift.id, { includeLowStock: true }));
});

function buildDashboard(shiftId, opts = {}) {
  const shift = get('SELECT * FROM shifts WHERE id=?', [shiftId]) || currentShift();
  const summary = shiftSummary(shift ? shift.id : null);
  const pendingApprovals = Number(get("SELECT COUNT(*) AS n FROM users WHERE role='wholesale' AND status='pending_verification'").n || 0);
  const pendingPayments = Number(get("SELECT COUNT(*) AS n FROM orders WHERE payment_method='upi' AND payment_status='pending' AND voided=0").n || 0);
  const low = lowStockList(8);
  return {
    shift,
    summary: {
      ...summary,
      shift_orders: summary.orders,
      online_received: summary.online_received,
      grand_total: summary.grand_total,
      cod_received: summary.cod_received,
    },
    cards: [
      { key: 'shift_orders', label: 'Shift Orders', value: summary.orders, kind: 'count', hint: 'non-voided orders in this shift' },
      { key: 'online_received', label: 'Online Received', value: summary.online_received, kind: 'money', hint: `${pendingPayments} UPI payment(s) awaiting verification` },
      { key: 'grand_total', label: 'Grand Total', value: summary.grand_total, kind: 'money', hint: 'all live order value in this shift' },
      { key: 'cod_received', label: 'COD Received', value: summary.cod_received, kind: 'money', hint: `₹${Math.round(summary.cod_pending)} cash still to collect` },
    ],
    orders: shiftOrders(shift ? shift.id : null),
    low_stock: opts.includeLowStock === false ? [] : low,
    low_stock_count: low.length,
    pending_approvals: pendingApprovals,
    pending_payments: pendingPayments,
    shop_open: getBoolSetting('shop_open', true),
    store: {
      name: settings().store_name,
      phone: settings().store_phone,
      upi_id: settings().upi_id,
    },
  };
}

/** Today-so-far strip used on the History screen. */
router.get('/today', requireOwner, (req, res) => {
  res.json({
    today: salesSummary('today'),
    week: salesSummary('week'),
    month: salesSummary('month'),
  });
});

// ------------------------------------------------------- shift + shop state --
router.post('/shop-status', requireOwner, (req, res, next) => {
  try {
    const open = oneOf(String(req.body?.open ?? ''), ['1', '0', 'true', 'false'], { field: 'open' });
    const value = ['1', 'true'].includes(open) ? '1' : '0';
    setSettings({ shop_open: value });
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: value === '1' ? 'shop.open' : 'shop.close' });
    res.json({ shop_open: value === '1', message: value === '1' ? 'Store is OPEN — customers can order.' : 'Store is CLOSED — ordering is paused.' });
  } catch (err) {
    next(err);
  }
});

router.post('/shift/close', requireOwner, (req, res, next) => {
  try {
    const shift = currentShift();
    if (!shift) throw notFound('No shift is currently open.');
    const closed = closeShift(shift.id, { note: optStr(req.body?.note, { field: 'note', max: 160 }) });
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'shift.close', entity: 'shift', entityId: shift.id, detail: `₹${closed.gross_sales} across ${closed.orders_count} orders` });
    res.json({ shift: closed, message: `Shift #${shift.id} closed · ₹${Math.round(closed.gross_sales)} collected across ${closed.orders_count} order(s).` });
  } catch (err) {
    next(err);
  }
});

router.post('/shift/open', requireOwner, (req, res, next) => {
  try {
    if (currentShift()) throw conflict('A shift is already open. Close it first to start a new one.');
    const shift = openShift(req.staff.username, optStr(req.body?.note, { field: 'note', max: 160 }));
    res.json({ shift });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ order actions --
router.get('/orders', requireOwner, (req, res) => {
  const shiftOnly = req.query.scope !== 'all';
  const shift = currentShift();
  res.json({
    orders: shiftOrders(shiftOnly ? shift?.id ?? null : null, { status: req.query.status, q: req.query.q }),
    shift,
    statuses: STATUS_FLOW,
  });
});

router.post('/orders/:id/status', requireOwner, async (req, res, next) => {
  try {
    const id = intIn(req.params.id, { field: 'order', min: 1, max: 1e9, fallback: 0 });
    const status = oneOf(req.body?.status, [...STATUS_FLOW, 'cancelled'], { field: 'status' });
    const order = await changeStatus(id, status, { actor: req.staff.name, reason: optStr(req.body?.reason, { field: 'reason', max: 160 }) });
    res.json({ order, dashboard: buildDashboard(currentShift()?.id ?? null), message: `${order.public_id} → ${order.status_label}` });
  } catch (err) {
    next(err);
  }
});

/** "Navigate" — hand the rider/salesman a Google Maps link for the saved address. */
router.post('/orders/:id/navigate', requireOwner, (req, res, next) => {
  try {
    const id = intIn(req.params.id, { field: 'order', min: 1, max: 1e9, fallback: 0 });
    const order = get('SELECT * FROM orders WHERE id=?', [id]);
    if (!order) throw notFound('Order not found.');
    let snapshot = null;
    try {
      snapshot = JSON.parse(order.address_snapshot || 'null');
    } catch {
      snapshot = null;
    }
    const url = mapsUrl(snapshot);
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'order.navigate', entity: 'order', entityId: id, detail: url.slice(0, 200) });
    res.json({ url, address: snapshot, name: snapshot?.contact_name, phone: snapshot?.contact_phone });
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', requireOwner, (req, res, next) => {
  try {
    const id = intIn(req.params.id, { field: 'order', min: 1, max: 1e9, fallback: 0 });
    res.json({ order: orderDetail(id, null) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------- online payment reconciliation --
router.get('/payments', requireOwner, (req, res) => {
  const pending = all(
    `SELECT o.*, u.full_name, u.mobile, u.business_name FROM orders o LEFT JOIN users u ON u.id=o.user_id
     WHERE o.payment_method='upi' AND o.payment_status IN ('pending','failed') AND o.voided=0
     ORDER BY o.id DESC LIMIT 60`,
  );
  const recent = all(
    `SELECT pe.*, o.public_id FROM payment_events pe JOIN orders o ON o.id=pe.order_id ORDER BY pe.id DESC LIMIT 25`,
  );
  const collectedToday = get(
    `SELECT COALESCE(SUM(total),0) AS online FROM orders WHERE payment_method='upi' AND payment_status='paid' AND date(placed_at)=date('now') AND voided=0`,
  );
  res.json({
    pending: pending.map((o) => ({
      id: o.id,
      public_id: o.public_id,
      total: o.total,
      upi_ref: o.upi_ref,
      placed_at: o.placed_at,
      status: o.status,
      payment_status: o.payment_status,
      customer: o.business_name ? `${o.full_name} · ${o.business_name}` : o.full_name,
      mobile: o.mobile,
    })),
    recent_events: recent,
    online_today: Number(collectedToday.online || 0),
    bank_hint: 'Reconcile against the store UPI statement — no card or bank data is stored in this app.',
  });
});

router.post('/payments/:id', requireOwner, (req, res, next) => {
  try {
    const id = intIn(req.params.id, { field: 'order', min: 1, max: 1e9, fallback: 0 });
    const action = oneOf(req.body?.action, ['mark_paid', 'mark_failed', 'refund', 'mark_cash'], { field: 'action' });
    const order = get('SELECT * FROM orders WHERE id=?', [id]);
    if (!order) throw notFound('Order not found.');
    const ref = optStr(req.body?.ref, { field: 'reference', max: 40 });
    const note = optStr(req.body?.note, { field: 'note', max: 200 });

    const map = {
      mark_paid: 'paid',
      mark_failed: 'failed',
      refund: 'refunded',
      mark_cash: 'cash_collected',
    };
    const nextStatus = map[action];
    if (action === 'mark_paid' && order.payment_method === 'cod') throw badRequest('This is a cash order — use “Cash collected”.');
    if (action === 'mark_cash' && order.payment_method === 'upi') throw badRequest('This order was prepaid by UPI.');

    tx(() => {
      run('UPDATE orders SET payment_status=?, upi_ref=COALESCE(?, upi_ref) WHERE id=?', [nextStatus, ref, id]);
      insert('payment_events', {
        order_id: id,
        actor: req.staff.name,
        action,
        amount: order.total,
        ref,
        note: note || (action === 'mark_paid' ? 'UPI credit verified on store account' : null),
      });
    });
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: `payment.${action}`, entity: 'order', entityId: id, detail: `₹${order.total} ${ref || ''}`.trim() });

    if (action === 'mark_paid') {
      sendMessage({
        to: get('SELECT mobile FROM users WHERE id=?', [order.user_id])?.mobile,
        userId: order.user_id,
        orderId: id,
        template: 'order_confirmed',
        body: render('order_confirmed', { order_no: order.public_id, eta: getNumberSetting('eta_minutes', 90) }, get('SELECT lang FROM users WHERE id=?', [order.user_id])?.lang === 'ta' ? 'ta' : 'en'),
      }).catch(() => {});
    }

    res.json({
      order: orderDetail(id, null),
      message: `${order.public_id}: payment ${nextStatus.replace('_', ' ')}.`,
      dashboard: buildDashboard(currentShift()?.id ?? null),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- wholesale approvals (PIN read, admin write) --
router.get('/wholesale', requireOwner, requireElevatedWrapper, (req, res) => {
  const status = oneOf(req.query.status, ['pending_verification', 'active', 'suspended', 'rejected', 'all'], { field: 'status', fallback: 'pending_verification', required: false }) || 'pending_verification';
  const where = ["role = 'wholesale'"];
  const args = [];
  if (status !== 'all') {
    where.push('status = ?');
    args.push(status);
  }
  const rows = all(
    `SELECT id, full_name, mobile, business_name, business_type, gst_number, status, created_at, approved_at, rejected_reason, last_login_at,
            (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.voided=0) AS orders_count,
            (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.user_id=u.id AND o.voided=0) AS lifetime_value,
            (SELECT COUNT(*) FROM addresses a WHERE a.user_id=u.id) AS addresses
     FROM users u WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100`,
    args,
  );
  res.json({
    accounts: rows.map((r) => ({ ...r, orders_count: Number(r.orders_count), lifetime_value: Number(r.lifetime_value), initials: initialsOf(r.business_name || r.full_name) })),
    pending_count: Number(get("SELECT COUNT(*) AS n FROM users WHERE role='wholesale' AND status='pending_verification'").n || 0),
  });
});

router.post('/wholesale/:id', requireOwner, requireElevatedWrapper, async (req, res, next) => {
  try {
    const id = intIn(req.params.id, { field: 'account', min: 1, max: 1e9, fallback: 0 });
    const action = oneOf(req.body?.action, ['approve', 'reject', 'suspend', 'reinstate'], { field: 'action' });
    const user = get('SELECT * FROM users WHERE id=? AND role=?', [id, 'wholesale']);
    if (!user) throw notFound('Wholesale account not found.');
    const reason = optStr(req.body?.reason, { field: 'reason', max: 200 });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const patch = {
      approve: { status: 'active', approved_at: stamp, approved_by: req.staff.name, rejected_reason: null },
      reject: { status: 'rejected', rejected_reason: reason || 'Documents could not be verified' },
      suspend: { status: 'suspended', rejected_reason: reason || 'Account temporarily paused at owner request' },
      reinstate: { status: 'active', approved_at: stamp, rejected_reason: null },
    }[action];

    tx(() => update('users', id, patch));
    if (action === 'suspend') revokeUserSessions({ userId: id });

    if (action === 'approve' || action === 'reject') {
      sendMessage({
        to: user.mobile,
        userId: user.id,
        template: action === 'approve' ? 'wholesale_approved' : 'wholesale_rejected',
        body: render(
          action === 'approve' ? 'wholesale_approved' : 'wholesale_rejected',
          { business: user.business_name || user.full_name, reason: reason || 'see store for details' },
          user.lang === 'ta' ? 'ta' : 'en',
        ),
      }).catch(() => {});
    }

    audit({
      actorType: 'owner',
      actorId: req.staff.id,
      actorLabel: req.staff.name,
      action: `wholesale.${action}`,
      entity: 'user',
      entityId: id,
      detail: `${user.business_name || ''} ${reason || ''}`.trim(),
    });
    const fresh = get('SELECT * FROM users WHERE id=?', [id]);
    res.json({
      account: { ...fresh, password_hash: undefined },
      message:
        action === 'approve'
          ? `${user.business_name || user.full_name} approved — wholesale prices and slabs are live for this account.`
          : action === 'reject'
            ? 'Application rejected. The customer keeps retail access.'
            : action === 'suspend'
              ? 'Account suspended; their sessions were signed out.'
              : 'Account reinstated at wholesale prices.',
    });
  } catch (err) {
    next(err);
  }
});

/** Read is PIN-only (so the counter can see who is waiting); writes need the password. */
function requireElevatedWrapper(req, res, next) {
  if (['GET', 'HEAD'].includes(req.method)) return requireOwner(req, res, next);
  return requireElevated(req, res, next);
}

// ------------------------------------------------------------ scratch/void --
router.get('/scratch', requireOwner, (req, res) => {
  const shift = currentShift();
  res.json({
    active: shiftOrders(shift?.id ?? null).filter((o) => o.status !== 'delivered'),
    delivered: shiftOrders(shift?.id ?? null).filter((o) => o.status === 'delivered'),
    voided: all(
      `SELECT o.*, u.full_name AS customer_name FROM orders o LEFT JOIN users u ON u.id=o.user_id
       WHERE o.voided=1 ORDER BY o.voided_at DESC LIMIT 30`,
    ).map((o) => ({ ...o, voided: true, items_summary: get('SELECT GROUP_CONCAT(name || \' x\' || qty) AS s FROM order_items WHERE order_id=?', [o.id])?.s || '' })),
  });
});

router.post('/scratch/:id', requireOwner, async (req, res, next) => {
  try {
    const id = intIn(req.params.id, { field: 'order', min: 1, max: 1e9, fallback: 0 });
    const reason = str(req.body?.reason, { field: 'Reason', max: 200, min: 3 });
    const notify = req.body?.notify !== false;
    const order = await voidOrder(id, reason, { actor: req.staff.name, notify });
    res.json({ order, message: `${order.public_id} voided and removed from shift totals.`, dashboard: buildDashboard(currentShift()?.id ?? null) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------- history/report --
router.get('/history', requireOwner, (req, res) => {
  const result = orderHistory({
    from: optStr(req.query.from, { field: 'from', max: 12 }),
    to: optStr(req.query.to, { field: 'to', max: 12 }),
    q: optStr(req.query.q, { field: 'search', max: 60 }),
    status: oneOf(req.query.status, ['all', ...STATUS_FLOW, 'cancelled'], { field: 'status', fallback: 'all', required: false }) || 'all',
    limit: intIn(req.query.limit, { field: 'limit', min: 10, max: 400, fallback: 80 }),
  });
  res.json({
    ...result,
    sales: {
      today: salesSummary('today'),
      week: salesSummary('week'),
      month: salesSummary('month'),
    },
  });
});

router.get('/report', requireOwner, (req, res) => {
  const period = oneOf(req.query.period, ['today', 'week', 'month', 'all'], { field: 'period', fallback: 'month' });
  res.json({ period, ...salesSummary(period) });
});

// ------------------------------------------- notifications + audit trail --
router.get('/notifications', requireOwner, (req, res) => {
  res.json({
    messages: recentNotifications(intIn(req.query.limit, { field: 'limit', min: 5, max: 200, fallback: 40 })),
    provider: config.notify.provider,
    hint:
      config.notify.provider === 'log'
        ? 'Outbox mode: messages are recorded here. Set NOTIFY_PROVIDER=webhook + NOTIFY_WEBHOOK_URL to push to MSG91/Gupshup/Interakt.'
        : 'Live webhook mode: failures stay visible so nothing is silently lost.',
  });
});

router.get('/audit', requireOwner, (req, res) => {
  res.json({ entries: recentAudit(intIn(req.query.limit, { field: 'limit', min: 5, max: 200, fallback: 50 })) });
});

// ---------------------------------------------------------------- settings --
router.get('/settings', requireOwner, (req, res) => {
  const s = settings();
  const { owner_password_hash, ...rest } = s;
  void owner_password_hash;
  res.json({ settings: rest, staff: all('SELECT id, name, designation, username, role, is_active, last_pin_login_at, last_admin_login_at FROM staff ORDER BY id') });
});

router.put('/settings', requireOwner, requireElevated, (req, res, next) => {
  try {
    const allowed = {
      store_name: (v) => str(v, { field: 'Store name', max: 60 }),
      store_tagline: (v) => str(v, { field: 'Tagline', max: 120 }),
      store_phone: (v) => str(v, { field: 'Store phone', max: 20 }),
      store_address: (v) => str(v, { field: 'Address', max: 200 }),
      store_hours: (v) => str(v, { field: 'Hours', max: 120 }),
      google_maps_query: (v) => str(v, { field: 'Maps fallback', max: 160 }),
      upi_id: (v) => str(v, { field: 'UPI ID', max: 60 }),
      upi_display_name: (v) => str(v, { field: 'UPI name', max: 60 }),
      cod_enabled: (v) => (['1', 'true', true].includes(v) ? '1' : '0'),
      shop_open: (v) => (['1', 'true', true].includes(v) ? '1' : '0'),
      wholesale_requires_approval: (v) => (['1', 'true', true].includes(v) ? '1' : '0'),
      delivery_charge: (v) => String(Math.max(0, Number(v) || 0)),
      free_delivery_above: (v) => String(Math.max(0, Number(v) || 0)),
      min_order_retail: (v) => String(Math.max(0, Number(v) || 0)),
      min_order_wholesale: (v) => String(Math.max(0, Number(v) || 0)),
      eta_minutes: (v) => String(Math.min(1440, Math.max(10, Number(v) || 90))),
      low_stock_threshold: (v) => String(Math.max(0, Number(v) || 0)),
    };
    const patch = {};
    for (const [key, cast] of Object.entries(allowed)) {
      if (req.body?.[key] !== undefined) patch[key] = cast(req.body[key]);
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update.');
    setSettings(patch);
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'settings.update', detail: patch });
    res.json({ settings: { ...settings(), owner_password_hash: undefined }, message: 'Store settings saved.' });
  } catch (err) {
    next(err);
  }
});

/** Change the store PIN from inside the admin area (needs the password). */
router.post('/pin', requireOwner, requireElevated, async (req, res, next) => {
  try {
    const code = vPin(req.body?.pin);
    const pass = vPassword(req.body?.password, { min: 6 });
    if (!(await verifyPassword(pass, req.staff.password_hash))) throw unauthorized('Password is not correct.');
    update('staff', req.staff.id, { pin_hash: await hashPin(code, config.pinPepper) });
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'owner.pin_change' });
    res.json({ ok: true, message: 'Counter PIN updated. Use the new PIN on the next login.' });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- helpers --
function publicStaff(s) {
  return {
    id: s.id,
    name: s.name,
    designation: s.designation,
    username: s.username,
    role: s.role,
    can_edit_pricing: s.role === 'owner',
  };
}

function initialsOf(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
}

router.get('/debug/db', requireOwner, requireElevated, (req, res) => res.json(dbStats()));
