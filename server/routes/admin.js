/**
 * Admin catalogue management.
 *  • Reading the menu list = PIN (ops) level — convenient at the counter.
 *  • Stock counts / availability toggles = PIN level (no pricing exposure).
 *  • Prices, tiers, MOQ, product edit/create/delete, categories, brands = elevated (password).
 */
import express from 'express';
import { all, get, insert, run, tx, update, settings, getNumberSetting } from '../db/index.js';
import { requireOwner, requireElevated } from '../middleware/session.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { str, optStr, oneOf, intIn, amount, UNITS, escapeLike } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { attachTiers } from '../services/catalog.js';
import { refreshStockStatus } from '../services/orders.js';
import { round2, percentOff } from '../lib/money.js';

export const router = express.Router();
router.use(requireOwner);

const STOCK = ['in_stock', 'low_stock', 'out_of_stock'];

// ------------------------------------------------------------------ products --
router.get('/products', (req, res) => {
  const args = [];
  const where = ['1=1'];
  if (req.query.search) {
    // one bound pattern per column — never use the pattern as the IFNULL default,
    // or every row without a Tamil name/brand matches every search.
    where.push("(p.name LIKE ? OR IFNULL(p.name_ta, '') LIKE ? OR IFNULL(b.name, '') LIKE ?)");
    const like = `%${escapeLike(String(req.query.search))}%`;
    args.push(like, like, like);
  }
  if (req.query.category) {
    where.push('(p.category_id = ? OR c.parent_id = ?)');
    args.push(Number(req.query.category), Number(req.query.category));
  }
  if (req.query.stock && STOCK.includes(req.query.stock)) {
    where.push('p.stock_status = ?');
    args.push(req.query.stock);
  }
  if (req.query.low === '1') where.push("p.stock_status IN ('low_stock','out_of_stock')");
  const limit = intIn(req.query.limit, { field: 'limit', min: 10, max: 400, fallback: 150 });
  const rows = attachTiers(
    all(
      `SELECT p.*, b.name AS brand_name, c.name AS category_name, c.name_ta AS category_name_ta
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')} ORDER BY p.name ASC LIMIT ?`,
      [...args, limit],
    ),
  );
  res.json({
    products: rows.map((r) => ({
      ...r,
      mrp: round2(r.mrp),
      retail_price: round2(r.retail_price),
      wholesale_price: r.wholesale_price === null ? null : round2(r.wholesale_price),
      retail_discount_pct: percentOff(r.mrp, r.retail_price),
      wholesale_discount_pct: r.wholesale_price === null ? 0 : percentOff(r.mrp, r.wholesale_price),
      is_active: !!r.is_active,
      is_featured: !!r.is_featured,
      tiers: (r.tiers || []).map((t) => ({ ...t, min_qty: Number(t.min_qty), max_qty: t.max_qty === null ? null : Number(t.max_qty), unit_price: round2(t.unit_price) })),
    })),
    counts: {
      total: Number(get('SELECT COUNT(*) AS n FROM products').n || 0),
      low: Number(get("SELECT COUNT(*) AS n FROM products WHERE stock_status IN ('low_stock','out_of_stock')").n || 0),
      inactive: Number(get('SELECT COUNT(*) AS n FROM products WHERE is_active=0').n || 0),
    },
  });
});

function productInput(body, existing = null) {
  const name = str(body.name ?? existing?.name, { field: 'Product name', max: 120, min: 2 });
  const retail = amount(body.retail_price ?? existing?.retail_price, { field: 'Retail price', min: 0.5, max: 200000 });
  const mrpRaw = body.mrp ?? existing?.mrp;
  const mrp = mrpRaw === '' || mrpRaw === null || mrpRaw === undefined ? retail : amount(mrpRaw, { field: 'MRP', min: 0.5, max: 250000 });
  if (retail > mrp) throw badRequest('Retail price cannot be higher than MRP.', { fields: { retail_price: 'gt_mrp' } });
  const wholesaleRaw = body.wholesale_price === undefined ? existing?.wholesale_price : body.wholesale_price;
  const wholesale = wholesaleRaw === '' || wholesaleRaw === null || wholesaleRaw === undefined ? null : amount(wholesaleRaw, { field: 'Wholesale price', min: 0.2, max: 200000 });
  if (wholesale !== null && wholesale > retail) {
    throw badRequest('Wholesale price should not be higher than retail price.', { fields: { wholesale_price: 'gt_retail' } });
  }
  const brandName = optStr(body.brand, { field: 'Brand', max: 60 });
  return {
    name,
    name_ta: optStr(body.name_ta ?? existing?.name_ta, { field: 'Tamil name', max: 120 }),
    description: optStr(body.description ?? existing?.description, { field: 'Description', max: 600 }),
    category_id: body.category_id === undefined || body.category_id === '' ? existing?.category_id ?? null : Number(body.category_id) || null,
    brand_id: brandName ? ensureBrand(brandName) : body.brand_id !== undefined ? Number(body.brand_id) || null : existing?.brand_id ?? null,
    pack_size: optStr(body.pack_size ?? existing?.pack_size, { field: 'Pack size', max: 40 }),
    unit: oneOf(body.unit ?? existing?.unit ?? 'piece', UNITS, { field: 'Unit', fallback: 'piece' }),
    mrp,
    retail_price: retail,
    wholesale_price: wholesale,
    moq_wholesale: intIn(body.moq_wholesale ?? existing?.moq_wholesale ?? 1, { field: 'Wholesale MOQ', min: 1, max: 500, fallback: 1 }),
    min_qty_retail: intIn(body.min_qty_retail ?? existing?.min_qty_retail ?? 1, { field: 'Retail min qty', min: 1, max: 100, fallback: 1 }),
    max_qty_retail: body.max_qty_retail === '' || body.max_qty_retail === undefined || body.max_qty_retail === null ? (existing?.max_qty_retail ?? null) : intIn(body.max_qty_retail, { field: 'Max qty', min: 1, max: 500, fallback: null }),
    stock_qty: body.stock_qty === '' || body.stock_qty === undefined ? (existing?.stock_qty ?? null) : Number(body.stock_qty),
    low_stock_qty: intIn(body.low_stock_qty ?? existing?.low_stock_qty ?? getNumberSetting('low_stock_threshold', 5), { field: 'Low stock alert', min: 0, max: 100000, fallback: 5 }),
    image: optStr(body.image ?? existing?.image, { field: 'Image', max: 200 }),
    is_active: body.is_active === undefined ? (existing ? !!existing.is_active : true) : !!body.is_active,
    is_featured: body.is_featured === undefined ? (existing ? !!existing.is_featured : false) : !!body.is_featured,
  };
}

function ensureBrand(name) {
  const clean = String(name).trim().replace(/\s+/g, ' ').slice(0, 60);
  const existing = get('SELECT id FROM brands WHERE name = ? COLLATE NOCASE', [clean]);
  if (existing) return existing.id;
  return insert('brands', { name: clean });
}

function validateCategory(id) {
  if (id === null || id === undefined) return null;
  const row = get('SELECT id FROM categories WHERE id=?', [Number(id)]);
  if (!row) throw badRequest('Choose a valid category.');
  return row.id;
}

function tiersFromBody(body) {
  const raw = Array.isArray(body.tiers) ? body.tiers : [];
  const out = [];
  for (const t of raw) {
    const minQty = intIn(t.min_qty, { field: 'Tier from qty', min: 1, max: 500, required: true });
    const maxQty = t.max_qty === '' || t.max_qty === null || t.max_qty === undefined ? null : intIn(t.max_qty, { field: 'Tier to qty', min: minQty, max: 1000, required: false });
    if (maxQty !== null && maxQty < minQty) throw badRequest(`Tier ${minQty}-${maxQty}: the “to” quantity is smaller than the “from”.`);
    const price = amount(t.unit_price, { field: 'Tier price', min: 0.2, max: 200000 });
    out.push({ scope: oneOf(t.scope || 'wholesale', ['retail', 'wholesale'], { field: 'Tier scope', fallback: 'wholesale' }), min_qty: minQty, max_qty: maxQty, unit_price: price });
  }
  out.sort((a, b) => a.min_qty - b.min_qty);
  for (let i = 0; i < out.length; i += 1) {
    const next = out[i + 1];
    if (next && out[i].max_qty !== null && next.min_qty <= out[i].max_qty) {
      throw badRequest(`Quantity slabs overlap (${out[i].min_qty}-${out[i].max_qty} and ${next.min_qty}+). Fix the ranges.`);
    }
    if (next && out[i].max_qty === null) throw badRequest('An open-ended slab (e.g. 51+) must be the last one.');
  }
  return out;
}

function writeTiers(productId, tiers) {
  run('DELETE FROM price_tiers WHERE product_id = ?', [productId]);
  for (const t of tiers) insert('price_tiers', { product_id: productId, ...t });
}

router.post('/products', requireElevated, (req, res, next) => {
  try {
    const data = productInput(req.body || {});
    if (!data.category_id) throw badRequest('Choose a category for this product.', { fields: { category_id: 'required' } });
    data.category_id = validateCategory(data.category_id);
    const tiers = tiersFromBody(req.body || {});
    const id = tx(() => {
      const newId = insert('products', { ...data, is_active: data.is_active ? 1 : 0, is_featured: data.is_featured ? 1 : 0, search_text: searchText(data) });
      writeTiers(newId, tiers);
      return newId;
    });
    refreshStockStatus([id]);
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'product.create', entity: 'product', entityId: id, detail: `${data.name} ₹${data.retail_price}/₹${data.wholesale_price ?? '-'}` });
    res.status(201).json({ product: adminProduct(id), message: `${data.name} added to the menu list.` });
  } catch (err) {
    next(err);
  }
});

router.put('/products/:id', requireElevated, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = get('SELECT * FROM products WHERE id=?', [id]);
    if (!existing) throw notFound('Product not found.');
    const data = productInput(req.body || {}, existing);
    data.category_id = validateCategory(data.category_id);
    const tiers = Array.isArray(req.body?.tiers) ? tiersFromBody(req.body) : null;
    const priceChanged = Number(existing.retail_price) !== data.retail_price || Number(existing.wholesale_price || 0) !== Number(data.wholesale_price || 0) || Number(existing.mrp) !== data.mrp;
    tx(() => {
      update('products', id, { ...data, is_active: data.is_active ? 1 : 0, is_featured: data.is_featured ? 1 : 0, search_text: searchText(data), updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
      if (tiers) writeTiers(id, tiers);
    });
    refreshStockStatus([id]);
    if (priceChanged) {
      audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'product.price_change', entity: 'product', entityId: id, detail: `retail ₹${existing.retail_price}→₹${data.retail_price}, wholesale ₹${existing.wholesale_price ?? '-'}→₹${data.wholesale_price ?? '-'}` });
    } else {
      audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'product.update', entity: 'product', entityId: id, detail: data.name });
    }
    res.json({ product: adminProduct(id), message: priceChanged ? 'Prices updated — live carts re-price on next refresh.' : 'Product updated.' });
  } catch (err) {
    next(err);
  }
});

/** Stock + availability at counter speed (PIN level, no pricing involved). */
router.post('/products/:id/stock', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = get('SELECT * FROM products WHERE id=?', [id]);
    if (!existing) throw notFound('Product not found.');
    const patch = {};
    if (req.body?.stock_qty !== undefined && req.body.stock_qty !== '') patch.stock_qty = Number(req.body.stock_qty);
    if (req.body?.delta !== undefined && req.body.delta !== '') patch.stock_qty = round2(Number(existing.stock_qty ?? 0) + Number(req.body.delta));
    if (req.body?.low_stock_qty !== undefined) patch.low_stock_qty = Number(req.body.low_stock_qty);
    if (req.body?.stock_status && STOCK.includes(req.body.stock_status)) {
      patch.stock_status = req.body.stock_status;
      if (req.body.stock_status === 'out_of_stock') patch.stock_qty = 0;
    }
    if (!Object.keys(patch).length) throw badRequest('Nothing to update.');
    tx(() => update('products', id, patch));
    if (patch.stock_qty !== undefined || patch.low_stock_qty !== undefined) refreshStockStatus([id]);
    run("UPDATE products SET updated_at=datetime('now') WHERE id=?", [id]);
    const after = get('SELECT * FROM products WHERE id=?', [id]);
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'product.stock', entity: 'product', entityId: id, detail: `qty ${existing.stock_qty ?? '-'}→${after.stock_qty ?? '-'}, status ${after.stock_status}` });
    res.json({ product: adminProduct(id), message: `${after.name}: ${after.stock_qty ?? '—'} ${after.unit} · ${after.stock_status.replace('_', ' ')}` });
  } catch (err) {
    next(err);
  }
});

router.post('/products/:id/active', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = get('SELECT * FROM products WHERE id=?', [id]);
    if (!existing) throw notFound('Product not found.');
    const value = req.body?.is_active === undefined ? !existing.is_active : !!req.body.is_active;
    update('products', id, { is_active: value ? 1 : 0, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    res.json({ product: adminProduct(id), message: value ? `${existing.name} is on the menu again.` : `${existing.name} hidden from customers.` });
  } catch (err) {
    next(err);
  }
});

router.delete('/products/:id', requireElevated, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = get('SELECT * FROM products WHERE id=?', [id]);
    if (!existing) throw notFound('Product not found.');
    const sold = Number(get('SELECT COUNT(*) AS n FROM order_items WHERE product_id=?', [id]).n || 0);
    if (sold > 0) {
      // Keep order history intact: deactivate instead of hard delete.
      update('products', id, { is_active: 0 });
      audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'product.retire', entity: 'product', entityId: id, detail: `${sold} past order line(s)` });
      return res.json({ retired: true, product: adminProduct(id), message: `${existing.name} appears in ${sold} past order(s), so it was hidden from the menu instead of deleted.` });
    }
    run('DELETE FROM products WHERE id=?', [id]);
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'product.delete', entity: 'product', entityId: id, detail: existing.name });
    res.json({ deleted: true, message: `${existing.name} deleted.` });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- taxonomy ----
router.post('/categories', requireElevated, (req, res, next) => {
  try {
    const name = str(req.body?.name, { field: 'Category name', max: 60, min: 2 });
    const parentId = req.body?.parent_id ? Number(req.body.parent_id) : null;
    if (parentId && !get('SELECT id FROM categories WHERE id=?', [parentId])) throw badRequest('Parent category not found.');
    const clash = get('SELECT id FROM categories WHERE name=? COLLATE NOCASE AND IFNULL(parent_id,0)=IFNULL(?,0)', [name, parentId]);
    if (clash) throw conflict('A category with that name already exists here.');
    const sortOrder = intIn(req.body?.sort_order ?? 99, { field: 'sort_order', min: 0, max: 999, fallback: 99 });
    const id = insert('categories', { name, name_ta: optStr(req.body?.name_ta, { field: 'Tamil name', max: 60 }), parent_id: parentId, sort_order: sortOrder, icon: optStr(req.body?.icon, { field: 'icon', max: 8 }) });
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'category.create', entity: 'category', entityId: id, detail: name });
    res.status(201).json({ category: get('SELECT * FROM categories WHERE id=?', [id]), tree: all('SELECT * FROM categories ORDER BY sort_order, name') });
  } catch (err) {
    next(err);
  }
});

router.put('/categories/:id', requireElevated, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = get('SELECT * FROM categories WHERE id=?', [id]);
    if (!row) throw notFound('Category not found.');
    const patch = {};
    if (req.body?.name !== undefined) patch.name = str(req.body.name, { field: 'Category name', max: 60, min: 2 });
    if (req.body?.name_ta !== undefined) patch.name_ta = optStr(req.body.name_ta, { field: 'Tamil name', max: 60 });
    if (req.body?.icon !== undefined) patch.icon = optStr(req.body.icon, { field: 'icon', max: 8 });
    if (req.body?.sort_order !== undefined) patch.sort_order = intIn(req.body.sort_order, { field: 'sort_order', min: 0, max: 999, fallback: 0 });
    if (req.body?.is_active !== undefined) patch.is_active = req.body.is_active ? 1 : 0;
    update('categories', id, patch);
    res.json({ category: get('SELECT * FROM categories WHERE id=?', [id]) });
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', requireElevated, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const products = Number(get('SELECT COUNT(*) AS n FROM products WHERE category_id=?', [id]).n || 0);
    const children = Number(get('SELECT COUNT(*) AS n FROM categories WHERE parent_id=?', [id]).n || 0);
    if (products || children) {
      throw conflict(`Move ${products} product(s) and ${children} sub-category(s) out of this category first.`);
    }
    run('DELETE FROM categories WHERE id=?', [id]);
    audit({ actorType: 'owner', actorId: req.staff.id, actorLabel: req.staff.name, action: 'category.delete', entity: 'category', entityId: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/brands', (req, res, next) => {
  try {
    const name = str(req.body?.name, { field: 'Brand name', max: 60, min: 2 });
    const id = ensureBrand(name);
    res.status(201).json({ brand: get('SELECT * FROM brands WHERE id=?', [id]) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- misc reads ---
router.get('/summary', (req, res) => {
  res.json({
    products: Number(get('SELECT COUNT(*) AS n FROM products WHERE is_active=1').n || 0),
    categories: Number(get('SELECT COUNT(*) AS n FROM categories').n || 0),
    brands: Number(get('SELECT COUNT(*) AS n FROM brands').n || 0),
    customers: Number(get("SELECT COUNT(*) AS n FROM users WHERE role='retail'").n || 0),
    wholesale: Number(get("SELECT COUNT(*) AS n FROM users WHERE role='wholesale'").n || 0),
    orders: Number(get('SELECT COUNT(*) AS n FROM orders').n || 0),
    tiered_products: Number(get('SELECT COUNT(DISTINCT product_id) AS n FROM price_tiers').n || 0),
    low_stock: Number(get("SELECT COUNT(*) AS n FROM products WHERE stock_status IN ('low_stock','out_of_stock')").n || 0),
    store_name: settings().store_name,
  });
});

/** Catalogue snapshot for backup / future CSV import (Phase 2) handoff. */
router.get('/export', requireElevated, (req, res) => {
  const rows = attachTiers(all('SELECT p.*, b.name AS brand_name, c.name AS category_name FROM products p LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.name'));
  res.json({
    exported_at: new Date().toISOString(),
    categories: all('SELECT * FROM categories ORDER BY sort_order, name'),
    brands: all('SELECT * FROM brands ORDER BY name'),
    products: rows,
  });
});

// ------------------------------------------------------------------ helpers --
function adminProduct(id) {
  const row = attachTiers([
    get(
      `SELECT p.*, b.name AS brand_name, c.name AS category_name FROM products p
       LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?`,
      [id],
    ),
  ])[0];
  if (!row) throw notFound('Product not found.');
  return {
    ...row,
    is_active: !!row.is_active,
    is_featured: !!row.is_featured,
    mrp: round2(row.mrp),
    retail_price: round2(row.retail_price),
    wholesale_price: row.wholesale_price === null ? null : round2(row.wholesale_price),
    retail_discount_pct: percentOff(row.mrp, row.retail_price),
    wholesale_discount_pct: row.wholesale_price === null ? 0 : percentOff(row.mrp, row.wholesale_price),
    tiers: (row.tiers || []).map((t) => ({ min_qty: Number(t.min_qty), max_qty: t.max_qty === null ? null : Number(t.max_qty), unit_price: round2(t.unit_price), scope: t.scope })),
  };
}

function searchText(data) {
  return `${data.name} ${data.name_ta || ''} ${data.pack_size || ''} ${data.description || ''}`.toLowerCase().slice(0, 400);
}
