/**
 * End-to-end API test (node:test, no external deps). Boots the real app on an
 * ephemeral port against a throwaway database, seeds it, then walks the flows:
 *
 *   retail signup + OTP → catalogue → cart → server-priced checkout → order
 *   wholesale approval → tiered pricing → reorder
 *   owner PIN → ops actions → password elevation gate → price edit
 *
 * Run with: npm test   (uses DATA_DIR=./data/test, so demo data is untouched)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smv-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.DB_FILE = 'test.db';
process.env.NODE_ENV = 'test';
process.env.EXPOSE_OTP = '1';
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';

let server;
let base = '';

const jar = new Map();

async function api(method, url, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (jar.get(opts.jar || 'default')) headers.cookie = jar.get(opts.jar || 'default');
  const sendBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  const res = await fetch(base + url, { method, headers, body: sendBody ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.() || [];
  if (setCookie.length) {
    const merged = { ...(Object.fromEntries((jar.get(opts.jar || 'default') || '').split('; ').filter(Boolean).map((p) => p.split('=')))) };
    for (const c of setCookie) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v === '' || /Max-Age=0/.test(c)) delete merged[k];
      else merged[k] = v;
    }
    jar.set(opts.jar || 'default', Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('; '));
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

before(async () => {
  const { createApp } = await import('../app.js');
  const { ensureSeeded } = await import('../seed/index.js');
  await ensureSeeded({ force: true });
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('health + bootstrap', async () => {
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(health.body.products >= 50, 'catalogue seeded');

  const boot = await api('GET', '/api/catalog/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.body.scope, 'retail');
  assert.ok(boot.body.categories.length >= 7);
  assert.ok(boot.body.featured.length >= 3, 'featured items present');
});

test('catalogue: search, filters and public pricing is retail', async () => {
  const search = await api('GET', '/api/catalog/products?q=atta');
  assert.ok(search.body.products.some((p) => p.name === 'Whole Wheat Atta'));

  const priceRange = await api('GET', '/api/catalog/products?min_price=100&max_price=300');
  assert.ok(priceRange.body.products.every((p) => p.price >= 100 && p.price <= 300));

  const atta = search.body.products.find((p) => p.name === 'Whole Wheat Atta');
  assert.equal(atta.price, atta.retail_price, 'anonymous viewer sees retail price');
  assert.equal(atta.wholesale_price, 235, 'wholesale price is present but not used for display');

  const detail = await api('GET', `/api/catalog/products/${atta.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.scope, 'retail');
  assert.ok(detail.body.product.mrp >= detail.body.product.price);
  assert.ok(detail.body.product.discount_pct > 0, 'discount vs MRP computed');
});

test('retail signup → OTP → login, with validation guards', async () => {
  const shortPw = await api('POST', '/api/auth/register', {
    full_name: 'Test User',
    mobile: '9123456780',
    password: '123',
    confirm_password: '123',
  });
  assert.equal(shortPw.status, 400, 'weak password rejected');

  const badMobile = await api('POST', '/api/auth/register', {
    full_name: 'Test User',
    mobile: '12345',
    password: 'tester@123',
    confirm_password: 'tester@123',
  });
  assert.equal(badMobile.status, 400);

  const reg = await api('POST', '/api/auth/register', {
    full_name: 'Test User',
    mobile: '9123456780',
    password: 'tester@123',
    confirm_password: 'tester@123',
    account_type: 'retail',
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.step, 'verify_otp');
  const code = reg.body.otp.debug_otp;
  assert.match(code, /^\d{6}$/);

  const wrongCode = await api('POST', '/api/auth/verify', { mobile: '9123456780', code: '000000' });
  assert.equal(wrongCode.status, 400, 'wrong OTP rejected');

  const ok = await api('POST', '/api/auth/verify', { mobile: '9123456780', code });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.pricing_scope, 'retail');

  const login = await api('POST', '/api/auth/login', { mobile: '9123456780', password: 'tester@123' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.full_name, 'Test User');

  const badLogin = await api('POST', '/api/auth/login', { mobile: '9123456780', password: 'wrong-password' });
  assert.equal(badLogin.status, 401);
});

test('wholesale signup stays at retail prices until approved', async () => {
  const reg = await api('POST', '/api/auth/register', {
    full_name: 'Deepa Rani',
    mobile: '9223456781',
    password: 'deepa@123',
    confirm_password: 'deepa@123',
    account_type: 'wholesale',
    business_name: 'Deepa Kirana',
    business_type: 'shop',
    gst_number: '33ABCDE1234F1Z5',
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.pending_business, true);
  const verify = await api('POST', '/api/auth/verify', { mobile: '9223456781', code: reg.body.otp.debug_otp });
  assert.equal(verify.body.user.status, 'pending_verification');
  assert.equal(verify.body.user.pricing_scope, 'retail', 'pending wholesale sees retail pricing');

  // Bad business type / bad GST are rejected.
  const badGst = await api('POST', '/api/auth/register', {
    full_name: 'Nope Store',
    mobile: '9223456782',
    password: 'nope@1234',
    confirm_password: 'nope@1234',
    account_type: 'wholesale',
    business_name: 'Nope Store',
    business_type: 'shop',
    gst_number: 'BAD',
  });
  assert.equal(badGst.status, 400);
});

test('approved wholesale account gets wholesale price + MOQ enforced', async () => {
  const res = await api('POST', '/api/auth/login', { mobile: '9840034567', password: 'balaji@123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.pricing_scope, 'wholesale');

  await api('DELETE', '/api/cart');
  const list = await api('GET', '/api/catalog/products?q=Sunflower%20Oil');
  const oil = list.body.products.find((p) => p.name === 'Refined Sunflower Oil');
  assert.equal(oil.price, 135, 'wholesale price shown');
  assert.equal(oil.moq, 6, 'MOQ shipped to client');

  const detail = await api('GET', `/api/catalog/products/${oil.id}`);
  assert.ok(detail.body.product.tier_table.length >= 2, 'tier table for wholesale account');

  // Below MOQ: refused by the server.
  const below = await api('POST', '/api/cart/items', { product_id: oil.id, qty: 2 });
  assert.equal(below.status, 200, 'cart add bumps to MOQ instead of erroring');
  const moqLine = below.body.lines.find((l) => l.product_id === oil.id);
  assert.equal(moqLine.qty, 6, 'MOQ enforced server-side');
  const cart1 = await api('GET', '/api/cart');
  assert.equal(cart1.body.lines.length, 1);
  assert.equal(cart1.body.lines[0].qty, 6, 'qty clamped up to MOQ');
  assert.equal(cart1.body.lines[0].unit_price, 129, '6 units → slab price 129');
  assert.equal(cart1.body.subtotal, 774);

  // Change quantity → tier + unit price + total recomputed server-side.
  await api('PATCH', `/api/cart/items/${oil.id}`, { qty: 24 });
  const cart2 = await api('GET', '/api/cart');
  assert.equal(cart2.body.lines.length, 1);
  assert.equal(cart2.body.lines[0].unit_price, 124);
  assert.equal(cart2.body.lines[0].tier.label, '24-59 units');
  assert.equal(cart2.body.lines[0].line_total, 2976);

  await api('PATCH', `/api/cart/items/${oil.id}`, { qty: 60 });
  const cart3 = await api('GET', '/api/cart');
  assert.equal(cart3.body.lines[0].unit_price, 118);
  assert.equal(cart3.body.lines[0].line_total, 7080);
  assert.ok(cart3.body.delivery_charge === 0, 'free delivery above threshold');
});

test('checkout is driven entirely by the server', async () => {
  await api('POST', '/api/auth/login', { mobile: '9840034567', password: 'balaji@123' });
  const preview = await api('GET', '/api/orders/preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.can_checkout, true);
  const serverTotal = preview.body.cart.total;

  const placed = await api('POST', '/api/orders', {
    address_id: preview.body.addresses[0].id,
    payment_method: 'upi',
    payment_app: 'phonepe',
    // Everything below is nonsense that a tampering client might try. It must be ignored.
    total: 1,
    unit_price: 0.01,
    discount: 9999,
    status: 'delivered',
    user_id: 1,
  });
  assert.equal(placed.status, 201, 'extra fields ignored');
  assert.equal(placed.body.order.total, serverTotal, 'order total equals server-computed total');
  assert.equal(placed.body.order.status, 'placed', 'client cannot pre-set status');
  assert.equal(placed.body.order.payment_status, 'pending', 'UPI awaits reconciliation');
  assert.match(placed.body.order.public_id, /^SMV-\d{4}-\d{4}$/);
  assert.ok(placed.body.payment.intent.startsWith('upi://pay?'), 'UPI deep link generated');
  assert.ok(placed.body.payment.intent.includes(`am=${serverTotal.toFixed(2)}`));
  assert.ok(placed.body.order.address.line1.length > 5, 'address snapshot stored');
  assert.equal(placed.body.cart.item_count, 0, 'cart cleared');

  const mine = await api('GET', '/api/orders');
  assert.equal(mine.body.orders[0].public_id, placed.body.order.public_id);
  const track = await api('GET', `/api/orders/${placed.body.order.id}/track`);
  assert.equal(track.status, 200);
  assert.ok(track.body.messages.length >= 1, 'status notification queued');
});

test('minimum order value blocks checkout for retail', async () => {
  await api('POST', '/api/auth/login', { mobile: '9123456780', password: 'tester@123' });
  await api('DELETE', '/api/cart');
  const tiny = await api('GET', '/api/catalog/products?q=Iodised%20Salt');
  const salt = tiny.body.products[0];
  const add = await api('POST', '/api/cart/items', { product_id: salt.id, qty: 1 });
  assert.equal(add.body.subtotal < add.body.min_order_value, true, 'below minimum');
  assert.equal(add.body.min_order_met, false);
  assert.equal(add.body.min_order_short_by, Math.round(add.body.min_order_value - add.body.subtotal), 'short-by amount shown');

  const blocked = await api('POST', '/api/orders', { payment_method: 'cod', address: { line1: '1 Test Street, Chennai' } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error.message, /Minimum order/);

  const big = await api('PATCH', `/api/cart/items/${salt.id}`, { qty: 20 });
  assert.equal(big.body.min_order_met, true);
  const ok = await api('POST', '/api/orders', { payment_method: 'cod', address: { line1: '1 Test Street, Chennai' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.order.payment_method, 'cod');
  assert.equal(ok.body.order.payment_status, 'cash_due');
});

test('out-of-stock product cannot be ordered', async () => {
  const oos = await api('GET', '/api/catalog/products?stock=out_of_stock');
  assert.ok(oos.body.products.length >= 1);
  const product = oos.body.products[0];
  await api('POST', '/api/auth/login', { mobile: '9123456780', password: 'tester@123' });
  const add = await api('POST', '/api/cart/items', { product_id: product.id, qty: 1 });
  const cart = add.body;
  assert.ok(cart.blocking_lines.length === 0 || cart.blocking_lines[0].errors[0].includes('Out of stock'));
  const checkout = await api('POST', '/api/orders', { payment_method: 'cod', address: { line1: '1 Test Street' } });
  assert.ok([400, 409].includes(checkout.status), `checkout refused (${checkout.status})`);
});

test('reorder restores quantities and respects current stock', async () => {
  await api('POST', '/api/auth/login', { mobile: '9840034567', password: 'balaji@123' });
  const orders = await api('GET', '/api/orders');
  const target = orders.body.orders.find((o) => o.status === 'delivered');
  assert.ok(target, 'seeded delivered order found');
  const before = await api('GET', '/api/cart');
  const res = await api('POST', `/api/orders/${target.id}/reorder`, { mode: 'full', replace: true });
  assert.equal(res.status, 200);
  assert.ok(res.body.cart.lines.length > 0, 'cart repopulated');
  assert.equal(res.body.cart.account_type, 'wholesale', 'reorder re-prices at current scope');
  assert.ok(res.body.cart.total > 0);
  void before;

  const partial = await api('POST', `/api/orders/${target.id}/reorder`, { mode: 'partial', product_ids: [res.body.cart.lines[0].product_id], replace: true });
  assert.equal(partial.body.cart.lines.length, 1);
});

test('owner: PIN login for ops, password for sensitive actions', async () => {
  const owner = await api('POST', '/api/owner/login', { pin: '0000' });
  assert.equal(owner.status, 401, 'wrong PIN rejected');
  const login = await api('POST', '/api/owner/login', { pin: '4321' }, { jar: 'owner' });
  assert.equal(login.status, 200);
  assert.equal(login.body.level, 'ops');
  assert.ok(login.body.dashboard.cards.length === 4, 'four summary cards');
  const keys = login.body.dashboard.cards.map((c) => c.key).join(',');
  assert.equal(keys, 'shift_orders,online_received,grand_total,cod_received');
  assert.ok(login.body.dashboard.orders.length >= 1, 'shift orders listed');
  assert.ok(login.body.dashboard.low_stock.length >= 1, 'low-stock alert visible');
  assert.ok(login.body.dashboard.orders[0].maps_url.includes('google.com/maps'), 'navigate link ready');

  // PIN alone must NOT be able to change prices.
  const unauthorized = await api('PUT', '/api/admin/products/1', { retail_price: 5 }, { jar: 'owner' });
  assert.equal(unauthorized.status, 403, 'price edit blocked at PIN level');
  const pending = await api('GET', '/api/owner/wholesale', {}, { jar: 'owner' });
  assert.equal(pending.status, 200, 'approvals list readable with PIN');
  const approve = await api('POST', '/api/owner/wholesale/2', { action: 'approve' }, { jar: 'owner' });
  assert.equal(approve.status, 403, 'approval needs elevation');

  const elevate = await api('POST', '/api/owner/elevate', { password: 'not-the-password' }, { jar: 'owner' });
  assert.equal(elevate.status, 401);
  const good = await api('POST', '/api/owner/elevate', { password: 'sathvika@owner2026' }, { jar: 'owner' });
  assert.equal(good.status, 200);
  assert.equal(good.body.level, 'admin');
});

test('owner: approvals, payments, shop toggle, voiding, min-order change', async () => {
  const pending = await api('GET', '/api/owner/wholesale', {}, { jar: 'owner' });
  const account = pending.body.accounts.find((a) => a.status === 'pending_verification');
  assert.ok(account, 'seeded pending wholesale account');
  const approved = await api('POST', `/api/owner/wholesale/${account.id}`, { action: 'approve' }, { jar: 'owner' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.account.status, 'active');

  // The approved customer now sees wholesale pricing.
  await api('POST', '/api/auth/login', { mobile: account.mobile, password: 'newmumbai@123' });
  const after = await api('GET', '/api/auth/me');
  assert.equal(after.body.user.pricing_scope, 'wholesale', 'approval unlocks wholesale prices');

  const payments = await api('GET', '/api/owner/payments', {}, { jar: 'owner' });
  assert.ok(payments.body.pending.length >= 1, 'UPI reconciliation queue');
  const pay = payments.body.pending[0];
  const marked = await api('POST', `/api/owner/payments/${pay.id}`, { action: 'mark_paid', ref: 'TEST123' }, { jar: 'owner' });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.order.payment_status, 'paid');

  const shift = await api('GET', '/api/owner/dashboard', {}, { jar: 'owner' });
  const live = shift.body.orders.find((o) => o.status === 'placed' && !o.voided);
  if (live) {
    const moved = await api('POST', `/api/owner/orders/${live.id}/status`, { status: 'out_for_delivery' }, { jar: 'owner' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.order.status, 'out_for_delivery');
    const nav = await api('POST', `/api/owner/orders/${live.id}/navigate`, {}, { jar: 'owner' });
    assert.match(nav.body.url, /google\.com\/maps/);
    const voided = await api('POST', `/api/owner/scratch/${live.id}`, { reason: 'Customer called to cancel', notify: true }, { jar: 'owner' });
    assert.equal(voided.status, 200);
    assert.equal(voided.body.order.voided, true);
    const after2 = await api('GET', '/api/owner/dashboard', {}, { jar: 'owner' });
    assert.ok(after2.body.summary.grand_total < shift.body.summary.grand_total, 'voided order removed from totals');
    const customer = await api('GET', '/api/owner/notifications', {}, { jar: 'owner' });
    assert.ok(customer.body.messages.some((m) => m.body.includes('cancelled') || m.template === 'order_cancelled'), 'cancellation message logged');
  }

  const closeShop = await api('POST', '/api/owner/shop-status', { open: '0' }, { jar: 'owner' });
  assert.equal(closeShop.body.shop_open, false);
  await api('POST', '/api/auth/login', { mobile: '9123456780', password: 'tester@123' });
  await api('POST', '/api/cart/items', { product_id: 1, qty: 5 });
  const blocked = await api('POST', '/api/orders', { payment_method: 'cod', address: { line1: '1 Test Street' } });
  assert.equal(blocked.status, 409, 'ordering blocked while store closed');
  await api('POST', '/api/owner/shop-status', { open: '1' }, { jar: 'owner' });

  // Minimum order value change requires elevation and takes effect immediately.
  const patch = await api('PUT', '/api/owner/settings', { min_order_retail: '300' }, { jar: 'owner' });
  assert.equal(patch.status, 200);
  const cart = await api('GET', '/api/cart');
  assert.equal(cart.body.min_order_value, 300);
  await api('PUT', '/api/owner/settings', { min_order_retail: '150' }, { jar: 'owner' });
});

test('owner: product CRUD + tier validation', async () => {
  const created = await api('POST', '/api/admin/products', {
    name: 'Test Rice 5kg',
    brand: 'TestBrand',
    category_id: 2,
    pack_size: '5 kg',
    unit: 'kg',
    mrp: 400,
    retail_price: 360,
    wholesale_price: 330,
    moq_wholesale: 4,
    stock_qty: 10,
    tiers: [
      { min_qty: 4, max_qty: 9, unit_price: 320 },
      { min_qty: 10, max_qty: null, unit_price: 300 },
    ],
  }, { jar: 'owner' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.product.id;
  assert.equal(created.body.product.tiers.length, 2);

  const overlap = await api('POST', '/api/admin/products', {
    name: 'Bad Tiers',
    category_id: 2,
    mrp: 100,
    retail_price: 90,
    tiers: [
      { min_qty: 1, max_qty: 10, unit_price: 80 },
      { min_qty: 5, max_qty: null, unit_price: 70 },
    ],
  }, { jar: 'owner' });
  assert.equal(overlap.status, 400, 'overlapping slabs rejected');

  const badPrice = await api('PUT', `/api/admin/products/${id}`, { retail_price: 500, mrp: 400 }, { jar: 'owner' });
  assert.equal(badPrice.status, 400, 'retail above MRP rejected');

  const stock = await api('POST', `/api/admin/products/${id}/stock`, { delta: -9 }, { jar: 'owner' });
  assert.equal(stock.body.product.stock_status, 'low_stock', 'stock status auto-derived');

  const list = await api('GET', '/api/catalog/products?q=Test%20Rice');
  assert.equal(list.body.products.length, 1);

  // Retail cart picks up the tier price for a wholesale account only.
  const cart = await api('POST', '/api/cart/items', { product_id: id, qty: 10 });
  assert.equal(cart.body.lines.at(-1).unit_price, 360, 'retail account ignores wholesale slabs');

  const retired = await api('DELETE', `/api/admin/products/${id}`, {}, { jar: 'owner' });
  assert.equal(retired.status, 200);
});

test('owner: history, report, categories CRUD, and logout', async () => {
  const history = await api('GET', '/api/owner/history?limit=30', {}, { jar: 'owner' });
  assert.equal(history.status, 200);
  assert.ok(history.body.orders.length >= 5);
  assert.ok(history.body.shifts.length >= 3, 'past shifts listed');
  const byDate = await api('GET', `/api/owner/history?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`, {}, { jar: 'owner' });
  assert.ok(byDate.status === 200);

  const report = await api('GET', '/api/owner/report?period=month', {}, { jar: 'owner' });
  assert.ok(report.body.top_products.length > 0, 'top-selling products');
  assert.ok(report.body.revenue > 0);

  const cat = await api('POST', '/api/admin/categories', { name: 'Pet Supplies', name_ta: 'வீட்டு விலங்குகள்' }, { jar: 'owner' });
  assert.equal(cat.status, 201);
  const dup = await api('POST', '/api/admin/categories', { name: 'Pet Supplies' }, { jar: 'owner' });
  assert.equal(dup.status, 409);
  const sub = await api('POST', '/api/admin/categories', { name: 'Dog Food', parent_id: cat.body.category.id }, { jar: 'owner' });
  assert.equal(sub.status, 201);
  const del = await api('DELETE', `/api/admin/categories/${cat.body.category.id}`, {}, { jar: 'owner' });
  assert.equal(del.status, 409, 'category with children not deletable');
  await api('DELETE', `/api/admin/categories/${sub.body.category.id}`, {}, { jar: 'owner' });
  await api('DELETE', `/api/admin/categories/${cat.body.category.id}`, {}, { jar: 'owner' });

  const logout = await api('POST', '/api/owner/logout', {}, { jar: 'owner' });
  assert.equal(logout.status, 200);
  const gone = await api('GET', '/api/owner/dashboard', {}, { jar: 'owner' });
  assert.equal(gone.status, 401, 'session destroyed on logout');
});

test('auth boundaries: cart needs a session, orders are row-scoped', async () => {
  jar.set('anon', '');
  const cart = await api('GET', '/api/cart', undefined, { jar: 'anon' });
  assert.equal(cart.status, 401, 'anonymous cannot read a cart');
  const admin = await api('GET', '/api/owner/dashboard', undefined, { jar: 'anon' });
  assert.equal(admin.status, 401, 'anonymous cannot read the owner dashboard');

  await api('POST', '/api/auth/login', { mobile: '9840034567', password: 'balaji@123' }, { jar: 'other' });
  const peek = await api('GET', '/api/orders', undefined, { jar: 'other' });
  assert.equal(peek.status, 200);
  assert.ok(peek.body.orders.length >= 1, 'this account has seeded orders');
  const foreignId = peek.body.orders[0].id;

  const anonymous = await api('GET', `/api/orders/${foreignId}`, undefined, { jar: 'anon' });
  assert.equal(anonymous.status, 401, 'anonymous cannot open someone else’s order');

  // A different logged-in customer must not be able to read it either.
  await api('POST', '/api/auth/login', { mobile: '9223456781', password: 'deepa@123' }, { jar: 'third' });
  const someoneElse = await api('GET', `/api/orders/${foreignId}`, undefined, { jar: 'third' });
  assert.ok([403, 404].includes(someoneElse.status), `cross-account read refused (${someoneElse.status})`);

  // ...but the owner may, for fulfilment (re-login: test 13 ended with an owner logout).
  await api('POST', '/api/owner/login', { pin: '4321' }, { jar: 'owner' });
  const owner = await api('GET', `/api/owner/orders/${foreignId}`, undefined, { jar: 'owner' });
  assert.equal(owner.status, 200, 'owner can open any order');
});

test('search narrows results in both owner surfaces', async () => {
  await api('POST', '/api/owner/login', { pin: '4321' }, { jar: 'search' });
  const elev = await api('POST', '/api/owner/elevate', { password: 'sathvika@owner2026' }, { jar: 'search' });
  assert.equal(elev.status, 200, 'elevation for the admin product list');

  const hit = await api('GET', '/api/admin/products?search=sunflower', undefined, { jar: 'search' });
  assert.equal(hit.status, 200, 'admin product search must not 500');
  assert.ok(hit.body.products.length >= 1, 'a known term finds products');
  assert.ok(
    hit.body.products.every((p) => /sunflower/i.test(`${p.name} ${p.name_ta || ''} ${p.brand_name || ''}`)),
    'every admin search row really matches the term',
  );

  const miss = await api('GET', '/api/admin/products?search=zzzz-nothing', undefined, { jar: 'search' });
  assert.equal(miss.body.products.length, 0, 'a term nothing matches must return nothing');

  const all1 = await api('GET', '/api/owner/orders?scope=all', undefined, { jar: 'search' });
  assert.equal(all1.status, 200);
  assert.ok(all1.body.orders.length >= 2, 'there are orders to search across');
  const needle = all1.body.orders[0].public_id;
  const found = await api('GET', `/api/owner/orders?scope=all&q=${needle}`, undefined, { jar: 'search' });
  assert.equal(found.status, 200);
  assert.equal(found.body.orders.length, 1, 'searching an order number finds exactly it');
  assert.equal(found.body.orders[0].public_id, needle);

  const none = await api('GET', '/api/owner/orders?scope=all&q=zzzz-nothing', undefined, { jar: 'search' });
  assert.equal(none.status, 200);
  assert.equal(none.body.orders.length, 0, 'order search must not fall back to “everything”');
});

test('framed sessions: cookie upgrade, bearer mirror, CSRF guard', async () => {
  // A preview iframe / kiosk embed is a cross-site context: the browser refuses a
  // SameSite=Lax cookie there, which used to mean "signed in, but every write 401s".
  const framed = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-context': 'embedded' },
    body: JSON.stringify({ mobile: '9840012345', password: 'priya@123' }),
  });
  const framedBody = await framed.json();
  const cookie = (framed.headers.getSetCookie() || []).join(' ');
  assert.equal(framed.status, 200, 'framed login still works');
  assert.match(cookie, /SameSite=none/i, 'framed client gets a SameSite=None cookie');
  assert.match(cookie, /Secure/i, '…and it is marked Secure, as the browser demands');
  // Without CHIPS partitioning a browser that blocks third-party cookies drops this Set-Cookie
  // outright, and the shopper sees "Please sign in to continue" one request after signing in.
  assert.match(cookie, /Partitioned/i, '…and partitioned, so a cross-site frame may store it at all');
  const token = framedBody.session_token;
  assert.ok(token && token.length > 20, 'the response mirrors a bearer session token');

  const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, 'the bearer token authenticates on its own');
  assert.equal((await me.json()).user.mobile, '9840012345');

  // This is exactly the flow that used to fail for a shopper inside the frame.
  const add = await fetch(`${base}/api/cart/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ product_id: 1, qty: 2 }),
  });
  assert.equal(add.status, 200, 'adding to the cart works with only the bearer token');
  assert.ok((await add.json()).lines.length >= 1);

  // SameSite=None drops the browser's CSRF protection, so writes are origin-checked here.
  const crossSite = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ mobile: '9840012345', password: 'priya@123' }),
  });
  assert.equal(crossSite.status, 403, 'a write from a foreign origin is refused');
  assert.match((await crossSite.json()).error.message, /another site/i);

  // The normal (top-level) path must not change: Lax cookie, no token in the body.
  const plain = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: '9840012345', password: 'priya@123' }),
  });
  const plainCookie = (plain.headers.getSetCookie() || []).join(' ');
  const plainBody = await plain.json();
  assert.match(plainCookie, /SameSite=lax/i, 'top-level visitors keep the Lax cookie');
  assert.ok(!/Partitioned/i.test(plainCookie), 'a top-level session is not partitioned — it is a normal cookie');
  assert.ok(!('session_token' in plainBody), 'no token is handed out when it is not needed');

  // And when the frame cannot keep any storage at all, the cookie is the only transport:
  // replaying it without a bearer header or an X-App-Context hint must still authenticate.
  const framedCookie = /smv_session=([^;]*)/.exec(cookie)[1];
  const cookieOnly = await fetch(`${base}/api/cart/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `smv_session=${framedCookie}` },
    body: JSON.stringify({ product_id: 2, qty: 1 }),
  });
  assert.equal(cookieOnly.status, 200, 'the framed cookie authenticates a write on its own');

  // Revocation has to apply to both transports.
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const afterLogout = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(afterLogout.status, 401, 'logout kills the bearer session too');
});

test('session plumbing is introspectable, and browsing is not rate limited', async () => {
  // One shop, one broadband connection, one counter tablet: every customer would otherwise
  // share a single per-IP budget, and reading 57 products spends it. Idempotent catalogue
  // reads are exempt; writes and auth attempts still are not.
  const { rateLimit } = await import('../lib/ratelimit.js');
  const { config } = await import('../config.js');
  const wasEnabled = config.rateLimitEnabled;
  config.rateLimitEnabled = true;
  try {
    const mw = rateLimit({ name: 'unit-skip', max: 3, windowMs: 60_000, skip: (req) => req.method === 'GET' });
    const ask = (method) => {
      let passed = false;
      // next(err) means "refused", so the flag has to look at the argument, not the call.
      mw({ method, path: '/api/catalog/products', headers: {}, socket: { remoteAddress: '9.9.9.9' } }, { setHeader() {} }, (err) => { passed = !err; });
      return passed;
    };
    for (let i = 0; i < 40; i += 1) assert.equal(ask('GET'), true, 'a skipped request never spends budget');
    assert.equal(ask('POST'), true);
    assert.equal(ask('POST'), true);
    assert.equal(ask('POST'), true);
    assert.equal(ask('POST'), false, 'the fourth write inside a 3-per-window bucket is refused');
  } finally {
    config.rateLimitEnabled = wasEnabled;
  }

  // "Signed in, but it says I am not" should be answerable with one GET, not a debugger.
  const anon = await (await fetch(`${base}/api/auth/diag`)).json();
  assert.equal(anon.ok, true);
  assert.equal(anon.session_valid, false, 'anonymous diag reports no session');
  assert.equal(anon.cookie_present, false);
  assert.equal(anon.bearer_present, false);
  assert.equal(anon.policy.partitioned_when_embedded, true);
  assert.ok(Array.isArray(anon.policy.allowed_origins), 'the CORS allow-list is visible for auditing');
  assert.match(anon.request.storage, /persistent|ephemeral/, 'the deployment can see whether its disk will survive');

  const framed = await fetch(`${base}/api/auth/diag`, { headers: { 'x-app-context': 'embedded' } });
  assert.equal((await framed.json()).embedded, true, 'the framed context is reported honestly');

  const live = await api('GET', '/api/auth/diag', undefined, { jar: 'default' });
  assert.equal(live.status, 200);
  assert.equal(live.body.cookie_present, true, 'the jar we have been using is the one the server sees');
});
