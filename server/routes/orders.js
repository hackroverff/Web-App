/** Customer order endpoints: checkout preview, placement, tracking, reorder. */
import express from 'express';
import { requireCustomer } from '../middleware/session.js';
import { createOrder, ordersForUser, orderDetail, changeStatus, reorder, upiIntent } from '../services/orders.js';
import { loadCart } from '../services/cart.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { intIn, oneOf, optStr } from '../lib/validate.js';
import { get, insert, run } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { all } from '../db/index.js';

export const router = express.Router();
router.use(requireCustomer);

/** Step-2 preview: totals for the exact cart the server holds, no client math. */
router.get('/preview', (req, res, next) => {
  try {
    const cart = loadCart(req.user.id, req.user);
    const addresses = all('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC', [req.user.id]);
    res.json({
      cart,
      addresses,
      can_checkout: cart.lines.length > 0 && cart.min_order_met && !cart.blocking_lines.length,
      blockers: [
        ...cart.blocking_lines.flatMap((b) => b.errors.map((e) => `${b.name}: ${e}`)),
        ...(cart.lines.length && !cart.min_order_met ? [`Add ₹${Math.round(cart.min_order_short_by)} more to reach the ${cart.min_order_label}.`] : []),
      ],
    });
  } catch (err) {
    next(err);
  }
});

/** Checkout. Body carries address + payment choice only. */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const paymentMethod = oneOf(body.payment_method, ['upi', 'cod'], { field: 'Payment method', fallback: 'cod' });
    const result = await createOrder({
      user: req.user,
      body: {
        ...body,
        payment_method: paymentMethod,
        payment_app: oneOf(body.payment_app, ['gpay', 'phonepe', 'paytm', 'other'], { field: 'payment_app', fallback: 'other', required: false }),
      },
    });
    res.status(201).json({
      ...result,
      order: orderDetail(result.order.id, req.user),
      cart: loadCart(req.user.id, req.user),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', (req, res) => {
  const limit = intIn(req.query.limit, { field: 'limit', min: 1, max: 60, fallback: 30 });
  res.json({ orders: ordersForUser(req.user.id, { limit }) });
});

router.get('/:id', (req, res) => res.json({ order: orderDetail(orderId(req), req.user) }));

/** Lightweight polling endpoint for the live tracking screen. */
router.get('/:id/track', (req, res) => {
  const row = findOwnOrder(req);
  res.json({
    id: row.id,
    public_id: row.public_id,
    status: row.status,
    payment_status: row.payment_status,
    total: row.total,
    placed_at: row.placed_at,
    promised_at: row.promised_at,
    eta_minutes: row.eta_minutes,
    timeline: orderDetail(row.id, req.user).timeline,
    messages: all('SELECT channel, body, created_at, status FROM notifications WHERE order_id=? ORDER BY id', [row.id]),
  });
});

/** Reorder: whole order, or chosen lines. `replace` swaps the cart instead of merging. */
router.post('/:id/reorder', (req, res, next) => {
  try {
    const mode = oneOf(req.body?.mode, ['full', 'partial'], { field: 'mode', fallback: 'full' });
    const ids = Array.isArray(req.body?.product_ids) ? req.body.product_ids.map((n) => Number(n)).filter(Boolean) : null;
    const result = reorder(orderId(req), req.user, {
      mode,
      productIds: ids,
      replace: !!req.body?.replace,
    });
    res.json({ ...result, cart_summary: { subtotal: result.cart.subtotal, total: result.cart.total, item_count: result.cart.item_count } });
  } catch (err) {
    next(err);
  }
});

/** Customer cancel (only while the shop has not started packing). */
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const row = findOwnOrder(req);
    if (!['placed', 'confirmed'].includes(row.status)) {
      throw conflict('This order is already being prepared, so it cannot be cancelled here. Please call the store.');
    }
    const reason = optStr(req.body?.reason, { field: 'Reason', max: 160 }) || 'Cancelled by customer';
    const order = await changeStatus(row.id, 'cancelled', { actor: 'customer', reason });
    res.json({ order, message: 'Order cancelled. Any UPI payment will be refunded within 2 working days.' });
  } catch (err) {
    next(err);
  }
});

/** "I have paid" — records the UPI reference for the counter to reconcile. */
router.post('/:id/claim-payment', (req, res, next) => {
  try {
    const row = findOwnOrder(req);
    if (row.payment_method !== 'upi') throw badRequest('This order is cash on delivery.');
    if (row.payment_status === 'paid') throw conflict('This order is already marked as paid.');
    const ref = optStr(req.body?.upi_ref, { field: 'UPI reference', max: 40 });
    if (!ref) throw badRequest('Enter the 12-digit UPI reference from your payment app.');
    run('UPDATE orders SET upi_ref=? WHERE id=?', [ref, row.id]);
    insert('payment_events', {
      order_id: row.id,
      actor: 'customer',
      action: 'customer_claimed',
      amount: row.total,
      ref,
      note: 'Customer reported payment; awaiting counter verification.',
    });
    audit({ actorType: 'customer', actorId: req.user.id, actorLabel: req.user.full_name, action: 'payment.claim', entity: 'order', entityId: row.id, detail: ref });
    res.json({ order: orderDetail(row.id, req.user), message: 'Thanks — the counter will confirm your payment shortly.' });
  } catch (err) {
    next(err);
  }
});

/** Re-show the UPI deep link for an unpaid order. */
router.get('/:id/upi', (req, res, next) => {
  const row = findOwnOrder(req);
  if (row.payment_method !== 'upi') throw badRequest('This order is cash on delivery.');
  let snapshot = null;
  try {
    snapshot = JSON.parse(row.address_snapshot || 'null');
  } catch {
    snapshot = null;
  }
  res.json(upiIntent(row, row.total, snapshot));
});

export function orderId(req) {
  return intIn(req.params.id, { field: 'order', min: 1, max: 1e9, fallback: 0 });
}

/** Orders are strictly row-level scoped to the signed-in customer. */
function findOwnOrder(req) {
  const id = orderId(req);
  const row = get('SELECT * FROM orders WHERE id=?', [id]);
  if (!row) throw notFound('Order not found.');
  if (row.user_id !== req.user.id) throw conflict('This order belongs to another account.');
  return row;
}
