/**
 * Server-owned cart. The client can only say *which* product and *how many*;
 * prices, tiers, savings and totals are recomputed on every read from the DB,
 * so a stale or tampered client can never influence the chargeable amount.
 */
import { get, run, all, insert, settings, update } from '../db/index.js';
import { priceLine, summarise, scopeForUser, minQuantityFor, maxQuantityFor } from './pricing.js';
import { badRequest, notFound } from '../lib/errors.js';
import { round2 } from '../lib/money.js';

export function getOrCreateCart(userId) {
  let cart = get('SELECT * FROM carts WHERE user_id = ?', [userId]);
  if (!cart) {
    const id = insert('carts', { user_id: userId });
    cart = get('SELECT * FROM carts WHERE id = ?', [id]);
  }
  return cart;
}

function productRow(id) {
  return get(
    `SELECT p.*, b.name AS brand_name, c.name AS category_name, c.name_ta AS category_name_ta
     FROM products p
     LEFT JOIN brands b ON b.id = p.brand_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = ?`,
    [Number(id) || 0],
  );
}

export function loadCart(userId, user) {
  const cart = getOrCreateCart(userId);
  const rows = all(
    `SELECT ci.id AS cart_item_id, ci.qty, p.*, b.name AS brand_name, c.name AS category_name, c.name_ta AS category_name_ta
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN brands b ON b.id = p.brand_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ci.cart_id = ? ORDER BY ci.id ASC`,
    [cart.id],
  );
  const tiersByProduct = batchTiers(rows.map((r) => r.id));
  const scope = scopeForUser(user);

  const lines = rows.map((row) => {
    const min = minQuantityFor(row, scope);
    const max = maxQuantityFor(row, scope);
    const qty = clamp(row.qty, min, max);
    if (qty !== row.qty) run('UPDATE cart_items SET qty = ? WHERE id = ?', [qty, row.cart_item_id]);
    const line = priceLine({ product: row, qty, scope, tiers: tiersByProduct.get(row.id) || [] });
    return { ...line, product_id: row.id, image: row.image || `/img/products/placeholder-${row.category_id || 1}.svg` };
  });

  const summary = summarise({ lines, user, settings: settings() });
  return {
    updated_at: cart.updated_at,
    lines,
    ...summary,
    total_savings: round2(lines.reduce((s, l) => s + l.save_amount, 0)),
  };
}

function batchTiers(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = all(
    `SELECT * FROM price_tiers WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY min_qty ASC`,
    ids,
  );
  for (const t of rows) {
    if (!map.has(t.product_id)) map.set(t.product_id, []);
    map.get(t.product_id).push(t);
  }
  return map;
}

const clamp = (qty, min, max) => Math.min(max ?? Infinity, Math.max(min ?? 1, qty));

export function addItem(userId, productId, qty = 1) {
  const cart = getOrCreateCart(userId);
  const product = productRow(productId);
  if (!product) throw notFound('That product is no longer in the catalogue.');
  if (product.is_active === 0) throw badRequest('That product is not available right now.');
  const existing = get('SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ?', [cart.id, product.id]);
  const wanted = clamp((existing ? existing.qty : 0) + Math.max(1, Math.trunc(Number(qty) || 1)), 1, 999);
  writeItem(cart.id, product.id, wanted);
  return cart;
}

export function setQty(userId, productId, qty) {
  const cart = getOrCreateCart(userId);
  const n = Math.trunc(Number(qty));
  if (!Number.isFinite(n) || n < 0 || n > 999) throw badRequest('Quantity must be between 0 and 999.');
  if (n === 0) {
    run('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?', [cart.id, Number(productId)]);
  } else {
    const product = productRow(productId);
    if (!product) throw notFound('That product is no longer in the catalogue.');
    writeItem(cart.id, product.id, n);
  }
  return cart;
}

/**
 * Quantity changes that would break an MOQ are corrected rather than rejected:
 * a wholesale buyer typing "3" on a 5-pack-MOQ item gets bumped to 5 with a note.
 */
function writeItem(cartId, productId, qty) {
  run(
    `INSERT INTO cart_items (cart_id, product_id, qty) VALUES (?,?,?)
     ON CONFLICT(cart_id, product_id) DO UPDATE SET qty=excluded.qty, added_at=datetime('now')`,
    [cartId, productId, qty],
  );
  run("UPDATE carts SET updated_at=datetime('now') WHERE id=?", [cartId]);
}

export function removeItem(userId, productId) {
  const cart = getOrCreateCart(userId);
  run('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?', [cart.id, Number(productId)]);
  run("UPDATE carts SET updated_at=datetime('now') WHERE id=?", [cart.id]);
  return cart;
}

export function clearCart(userId) {
  const cart = getOrCreateCart(userId);
  run('DELETE FROM cart_items WHERE cart_id = ?', [cart.id]);
  run("UPDATE carts SET updated_at=datetime('now') WHERE id=?", [cart.id]);
  return cart;
}

/** Used by Reorder. `replace` wipes the cart first. */
export function fillFromItems(userId, items, { replace = false } = {}) {
  const cart = getOrCreateCart(userId);
  if (replace) run('DELETE FROM cart_items WHERE cart_id = ?', [cart.id]);
  const skipped = [];
  for (const item of items) {
    const product = productRow(item.product_id);
    if (!product || product.is_active === 0 || product.stock_status === 'out_of_stock') {
      skipped.push({ product_id: item.product_id, name: item.name, reason: !product ? 'no longer listed' : product.stock_status === 'out_of_stock' ? 'out of stock' : 'unavailable today' });
      continue;
    }
    const want = Math.trunc(Number(item.qty) || 1);
    const qty = Math.max(want, Number(product.moq_wholesale || 1), Number(product.min_qty_retail || 1));
    writeItem(cart.id, product.id, Math.min(999, qty));
  }
  return { cartId: cart.id, skipped };
}

export function cartCount(userId) {
  const cart = get('SELECT id FROM carts WHERE user_id = ?', [userId]);
  if (!cart) return 0;
  return Number(get('SELECT COALESCE(SUM(qty),0) AS n FROM cart_items WHERE cart_id = ?', [cart.id]).n || 0);
}
