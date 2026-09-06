/**
 * Demo seed. Idempotent: runs once (tracked in the `meta` table) and can be
 * re-run from a clean slate with `npm run reset`.
 *
 * Everything the app needs for a full walkthrough lives here: a 57-SKU
 * catalogue with wholesale slabs, retail + wholesale accounts (one pending
 * approval, one suspended), saved addresses, live carts, and 13 orders spread
 * across the status pipeline and past shifts — all priced through the real
 * pricing engine so every number on screen is internally consistent.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, insert, run, setSettings, metaGet, metaSet, settings } from '../db/index.js';
import { hashPassword, hashPin } from '../lib/password.js';
import { config } from '../config.js';
import { round2 } from '../lib/money.js';
import { priceLine, summarise, scopeForUser } from '../services/pricing.js';
import { STATUS_FLOW } from '../services/orders.js';
import { render } from '../lib/notify.js';
import { ensureProductImages, ensureCategoryArt, categorySlug } from './images.js';
import { CATEGORY_TREE, PRODUCTS, SEED_ACCOUNTS, ADDRESSES, SEED_ORDERS } from './data.js';

export const SEED_VERSION = '2026-09-05.1';

const sqlTime = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
const hoursAgo = (h) => sqlTime(Date.now() - h * 3600_000);
const minsAfter = (base, mins) => sqlTime(new Date(`${base}Z`).getTime() + mins * 60_000);
const count = (sql, args = []) => Number(get(sql, args).n || 0);

export async function ensureSeeded({ force = false } = {}) {
  if (metaGet('seed_version') === SEED_VERSION && !force) return false;
  if (!force && count('SELECT COUNT(*) AS n FROM products') > 0 && metaGet('seed_version')) return false;
  return seed();
}

export async function resetDemo() {
  run('PRAGMA foreign_keys = OFF');
  for (const t of [
    'audit_log', 'payment_events', 'notifications', 'order_items', 'orders', 'shifts', 'cart_items', 'carts',
    'price_tiers', 'products', 'brands', 'categories', 'addresses', 'otps', 'sessions', 'users', 'staff', 'settings', 'meta',
  ]) {
    run(`DELETE FROM ${t}`);
  }
  run('DELETE FROM sqlite_sequence');
  run('PRAGMA foreign_keys = ON');
  return seed();
}

async function seed() {
  const started = Date.now();

  // ---------------------------------------------------------------- settings --
  setSettings({
    store_name: 'Sathvika MV',
    store_tagline: 'Groceries & provisions for homes and shops — T. Nagar, since 1994',
    store_phone: '+91 98400 12345',
    store_address: 'No. 14, Big Bazaar Street, T. Nagar, Chennai 600017',
    store_hours: 'Mon–Sat 7:30 am – 9:30 pm · Sun 8:00 am – 1:00 pm',
    google_maps_query: 'Big Bazaar Street, T. Nagar, Chennai',
    upi_id: 'sathvika.mv@okaxis',
    upi_display_name: 'Sathvika MV Provisions',
    cod_enabled: '1',
    delivery_charge: '30',
    free_delivery_above: '999',
    min_order_retail: '150',
    min_order_wholesale: '0',
    eta_minutes: '90',
    low_stock_threshold: '5',
    shop_open: '1',
    wholesale_requires_approval: '1',
    currency: 'INR',
  });

  // ---------------------------------------------------------------- taxonomy --
  const catIds = new Map();
  let sort = 0;
  for (const root of CATEGORY_TREE) {
    const parentId = insert('categories', { name: root.name, name_ta: root.name_ta, parent_id: null, sort_order: sort++, icon: root.icon });
    catIds.set(root.name, parentId);
    let child = 0;
    for (const sub of root.children || []) {
      const id = insert('categories', { name: sub, name_ta: null, parent_id: parentId, sort_order: child++ });
      catIds.set(`${root.name}/${sub}`, id);
    }
  }
  ensureCategoryArt();

  const brandIds = new Map();
  for (const p of PRODUCTS) if (!brandIds.has(p.b)) brandIds.set(p.b, insert('brands', { name: p.b }));

  // ---------------------------------------------------------------- products --
  const images = [];
  const productIdsByName = new Map();
  for (const p of PRODUCTS) {
    const categoryId = catIds.get(p.c) ?? catIds.get(p.c.split('/')[0]) ?? null;
    const stock = p.stock ?? 20;
    const threshold = p.low ?? Number(settings().low_stock_threshold || 5);
    const stockStatus = stock <= 0 ? 'out_of_stock' : stock <= threshold ? 'low_stock' : 'in_stock';
    const id = insert('products', {
      name: p.n,
      name_ta: p.ta || null,
      description: p.desc || null,
      brand_id: brandIds.get(p.b),
      category_id: categoryId,
      pack_size: p.p,
      unit: p.u,
      mrp: round2(p.mrp),
      retail_price: round2(p.r),
      wholesale_price: p.w === null || p.w === undefined ? null : round2(p.w),
      stock_status: stockStatus,
      stock_qty: stock,
      low_stock_qty: threshold,
      moq_wholesale: p.moq ?? 1,
      min_qty_retail: p.min ?? 1,
      max_qty_retail: p.max ?? null,
      is_active: 1,
      is_featured: p.feat ? 1 : 0,
      search_text: `${p.n} ${p.ta || ''} ${p.b} ${p.p}`.toLowerCase(),
      image: `/img/products/${categorySlug(p.n)}.svg`,
    });
    productIdsByName.set(p.n, id);
    images.push({ id, name: p.n, category: p.c.split('/')[0], packSize: p.p });

    for (const t of p.tiers || []) {
      insert('price_tiers', { product_id: id, scope: 'wholesale', min_qty: t[0], max_qty: t[1], unit_price: round2(t[2]) });
    }
  }
  ensureProductImages(images);

  // ------------------------------------------------------------------- staff --
  const ownerPasswordHash = await hashPassword(config.ownerPassword);
  const ownerId = insert('staff', {
    name: 'Lakshmi Narayanan',
    designation: 'Owner',
    username: 'owner',
    mobile: '9840012345',
    role: 'owner',
    pin_hash: await hashPin(config.ownerPin, config.pinPepper),
    password_hash: ownerPasswordHash,
  });
  insert('staff', {
    name: 'Karthik R',
    designation: 'Counter staff',
    username: 'karthik',
    mobile: '9840055555',
    role: 'staff',
    pin_hash: await hashPin('1234', config.pinPepper),
    password_hash: await hashPassword('Sathvika@staff2026'),
  });

  // ------------------------------------------------------------------- users --
  const usersByMobile = new Map();
  for (const r of SEED_ACCOUNTS.retail) {
    const id = insert('users', {
      role: 'retail',
      full_name: r.full_name,
      mobile: r.mobile,
      password_hash: await hashPassword(r.password),
      verified: 1,
      status: 'active',
      email: r.email || null,
      lang: r.lang || 'en',
      created_at: hoursAgo(90 * 24),
      last_login_at: hoursAgo(2 + Math.random() * 4),
    });
    usersByMobile.set(r.mobile, get('SELECT * FROM users WHERE id=?', [id]));
  }
  for (const w of SEED_ACCOUNTS.wholesale) {
    const id = insert('users', {
      role: 'wholesale',
      full_name: w.full_name,
      mobile: w.mobile,
      password_hash: await hashPassword(w.password),
      verified: 1,
      status: w.status,
      business_name: w.business_name,
      business_type: w.business_type,
      gst_number: w.gst_number,
      notes: w.notes,
      lang: w.lang || 'en',
      created_at: hoursAgo(70 * 24),
      approved_at: w.status === 'active' ? hoursAgo(68 * 24) : null,
      approved_by: w.status === 'active' ? 'Lakshmi Narayanan' : null,
      rejected_reason: w.status === 'suspended' ? 'Two UPI payments never reconciled — paused until cleared' : null,
      last_login_at: hoursAgo(1 + Math.random() * 18),
    });
    usersByMobile.set(w.mobile, get('SELECT * FROM users WHERE id=?', [id]));
  }

  for (const [mobile, list] of Object.entries(ADDRESSES)) {
    const user = usersByMobile.get(mobile);
    if (!user) continue;
    for (const a of list) {
      insert('addresses', {
        user_id: user.id,
        label: a.label,
        kind: a.kind || 'home',
        contact_name: user.full_name,
        contact_phone: mobile,
        line1: a.line1,
        line2: a.line2 || null,
        area: a.area || null,
        city: a.city || 'Chennai',
        pincode: a.pincode || null,
        landmark: a.landmark || null,
        lat: a.lat ?? null,
        lng: a.lng ?? null,
        is_default: a.is_default ? 1 : 0,
      });
    }
  }

  // ------------------------------------------------------------------ shifts --
  // Open shift for today + closed shifts for the previous days, so the owner
  // dashboard and the History screen both have real rows to show.
  const shiftByDay = new Map();
  const mkShift = (dayOffset, closed) => {
    const opened = sqlTime(Date.now() - dayOffset * 86_400_000 - 11 * 3600_000 + 8.5 * 3600_000);
    const id = insert('shifts', {
      opened_at: opened,
      closed_at: closed ? sqlTime(Date.now() - dayOffset * 86_400_000 - 0.5 * 3600_000) : null,
      opened_by: dayOffset === 0 ? 'owner' : 'karthik',
      note: closed ? 'Closed evening counter' : 'Opened at 8:30 am',
    });
    shiftByDay.set(dayOffset, id);
    return id;
  };
  mkShift(0, false);
  for (const day of [1, 2, 3, 4]) mkShift(day, true);
  const liveShiftId = shiftByDay.get(0);

  // ------------------------------------------------------------------ orders --
  const productsByName = new Map(PRODUCTS.map((p) => [p.n, p]));
  const tiersByProduct = new Map();
  for (const row of all('SELECT * FROM price_tiers ORDER BY min_qty')) {
    if (!tiersByProduct.has(row.product_id)) tiersByProduct.set(row.product_id, []);
    tiersByProduct.get(row.product_id).push(row);
  }
  const fullProduct = (id) =>
    get(
      `SELECT p.*, b.name AS brand_name, c.name AS category_name FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
      [id],
    );

  let seq = 0;
  for (const spec of SEED_ORDERS) {
    const user = usersByMobile.get(spec.account);
    if (!user) continue;
    const scope = scopeForUser(user);
    const lines = spec.items
      .map(([name, qty]) => {
        const id = productIdsByName.get(name);
        const product = id ? fullProduct(id) : null;
        if (!product) return null;
        return priceLine({ product, qty, scope, tiers: tiersByProduct.get(id) || [] });
      })
      .filter(Boolean);
    if (!lines.length) continue;

    const sum = summarise({ lines, user, settings: settings() });
    const placedAt = hoursAgo(spec.age_hours);
    const dayOffset = Math.min(Math.floor(spec.age_hours / 24), 4);
    const shiftId = shiftByDay.get(dayOffset) ?? liveShiftId;
    const voided = !!spec.voided;
    const status = voided ? 'cancelled' : spec.status;
    const cod = spec.payment === 'cod';
    const paymentStatus = voided
      ? 'refunded'
      : status === 'cancelled'
        ? cod
          ? 'failed'
          : 'refunded'
        : cod
          ? status === 'delivered'
            ? 'cash_collected'
            : 'cash_due'
          : ['confirmed', 'preparing', 'out_for_delivery', 'delivered'].includes(status)
            ? 'paid'
            : 'pending';

    seq += 1;
    const publicId = `SMV-${new Date().getUTCFullYear()}-${String(1000 + seq).slice(-4)}`;
    const idx = STATUS_FLOW.indexOf(status);
    const stamps = {};
    STATUS_FLOW.forEach((key, i) => {
      if (idx >= 0 && i <= idx) stamps[key] = minsAfter(placedAt, 16 * (i + 1) + 5);
    });

    const address = get('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id ASC', [user.id]);
    const snapshot = address
      ? {
          address_id: address.id,
          label: address.label,
          contact_name: user.full_name,
          contact_phone: user.mobile,
          line1: address.line1,
          line2: address.line2,
          area: address.area,
          city: address.city,
          pincode: address.pincode,
          landmark: address.landmark,
          lat: address.lat,
          lng: address.lng,
        }
      : { contact_name: user.full_name, contact_phone: user.mobile, line1: settings().store_address, city: 'Chennai' };

    const orderId = insert('orders', {
      public_id: publicId,
      user_id: user.id,
      shift_id: shiftId,
      account_type: scope,
      status,
      subtotal: sum.subtotal,
      mrp_value: sum.mrp_value,
      discount: sum.discount,
      delivery_charge: sum.delivery_charge,
      total: sum.total,
      payment_method: spec.payment,
      payment_app: spec.payment_app || (cod ? null : 'gpay'),
      payment_status: paymentStatus,
      upi_ref: spec.upi_ref || null,
      address_snapshot: JSON.stringify(snapshot),
      placed_at: placedAt,
      confirmed_at: stamps.confirmed || null,
      preparing_at: stamps.preparing || null,
      otd_at: stamps.out_for_delivery || null,
      delivered_at: stamps.delivered || null,
      cancelled_at: status === 'cancelled' ? stamps.confirmed || minsAfter(placedAt, 40) : null,
      cancel_reason: voided ? spec.void_note : spec.cancel_reason || null,
      voided: voided ? 1 : 0,
      void_note: voided ? spec.void_note : null,
      voided_at: voided ? minsAfter(placedAt, 90) : null,
      eta_minutes: Number(settings().eta_minutes || 90),
      promised_at: minsAfter(placedAt, Number(settings().eta_minutes || 90)),
    });

    for (const line of lines) {
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
    }

    if (!cod && paymentStatus === 'paid') {
      insert('payment_events', {
        order_id: orderId,
        actor: 'owner',
        action: 'mark_paid',
        amount: sum.total,
        ref: spec.upi_ref || `UPI${String(90000 + seq).slice(-5)}`,
        note: 'Verified against store UPI statement (demo)',
        created_at: stamps.confirmed || placedAt,
      });
    }

    const reached = status === 'cancelled' ? ['placed', 'cancelled'] : STATUS_FLOW.slice(0, Math.max(1, idx + 1));
    for (const key of reached) {
      const template = `order_${key}`;
      const at = stamps[key] || placedAt;
      insert('notifications', {
        user_id: user.id,
        order_id: orderId,
        channel: 'whatsapp',
        to_number: user.mobile,
        template,
        body: render(
          template,
          {
            order_no: publicId,
            total: Math.round(sum.total),
            eta: settings().eta_minutes,
            payment: cod ? 'Cash on delivery' : 'Paid by UPI',
            payment_note: cod ? `Keep ₹${Math.round(sum.total)} ready for the delivery boy.` : 'Payment received. Thank you!',
            reason: spec.void_note || spec.cancel_reason || 'see store for details',
          },
          user.lang === 'ta' ? 'ta' : 'en',
        ),
        status: 'sent',
        provider: 'log',
        provider_msg: 'demo outbox entry',
        created_at: at,
        sent_at: at,
      });
    }
  }

  // ------------------------------------------------- live carts for the demo --
  const seedCart = (mobile, items) => {
    const user = usersByMobile.get(mobile);
    if (!user) return;
    const cartId = insert('carts', { user_id: user.id, updated_at: hoursAgo(1) });
    for (const [name, qty] of items) {
      const id = productIdsByName.get(name);
      if (id) insert('cart_items', { cart_id: cartId, product_id: id, qty });
    }
  };
  seedCart('9840012345', [['Sesame Seed Ball (Ellu Urundai)', 2], ['Fresh Curd Cup', 4], ['Jaggery (Vellam)', 3]]);
  seedCart('9840034567', [['Refined Sunflower Oil', 8], ['Turmeric Powder', 12]]);

  // ------------------------------------------------------------- audit trail --
  const balaji = usersByMobile.get('9840034567');
  insert('audit_log', {
    actor_type: 'owner',
    actor_id: ownerId,
    actor_label: 'Lakshmi Narayanan',
    action: 'wholesale.approve',
    entity: 'user',
    entity_id: balaji ? balaji.id : null,
    detail: 'Sri Balaji Tiffin Room approved at slab prices',
    created_at: hoursAgo(68 * 24),
  });

  const counts = {
    products: count('SELECT COUNT(*) AS n FROM products'),
    categories: count('SELECT COUNT(*) AS n FROM categories'),
    brands: count('SELECT COUNT(*) AS n FROM brands'),
    tiered_products: count('SELECT COUNT(DISTINCT product_id) AS n FROM price_tiers'),
    users: count('SELECT COUNT(*) AS n FROM users'),
    staff: count('SELECT COUNT(*) AS n FROM staff'),
    orders: count('SELECT COUNT(*) AS n FROM orders'),
    order_items: count('SELECT COUNT(*) AS n FROM order_items'),
    messages: count('SELECT COUNT(*) AS n FROM notifications'),
    svg_images: images.length,
  };
  metaSet('seed_version', SEED_VERSION);
  metaSet('seeded_at', new Date().toISOString());
  if (config.env !== 'test') console.log(`  seeded in ${((Date.now() - started) / 1000).toFixed(2)}s`, counts);
  return counts;
}

// ------------------------------------------------------------------- CLI hook --
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const wantsReset = process.argv.includes('--reset');
  const result = wantsReset ? await resetDemo() : await ensureSeeded({ force: true });
  console.log(wantsReset ? '\n  Demo data reset and re-seeded.\n' : '\n  Demo data seeded.\n', result);
  process.exit(0);
}
