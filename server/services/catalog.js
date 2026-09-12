/** Catalogue reads: categories, brands, product search, and price views. */
import { all, get, pluck } from '../db/index.js';
import { basePrice, scopeForUser, tierTable } from './pricing.js';
import { percentOff } from '../lib/money.js';
import { escapeLike } from '../lib/validate.js';
import { round2 } from '../lib/money.js';

const PRODUCT_JOIN = `
  FROM products p
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id
`;

const PRODUCT_SELECT = `
  SELECT p.*, b.name AS brand_name, c.name AS category_name, c.name_ta AS category_name_ta,
         c.parent_id AS category_parent_id
  ${PRODUCT_JOIN}
`;

export function attachTiers(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const tiers = all(
    `SELECT * FROM price_tiers WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY min_qty ASC`,
    ids,
  );
  const byProduct = new Map();
  for (const t of tiers) {
    if (!byProduct.has(t.product_id)) byProduct.set(t.product_id, []);
    byProduct.get(t.product_id).push(t);
  }
  for (const row of rows) row.tiers = byProduct.get(row.id) || [];
  return rows;
}

export function categoryTree({ includeInactive = false } = {}) {
  const rows = all(
    `SELECT id, name, name_ta, parent_id, sort_order, icon, is_active,
            (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS product_count
     FROM categories c ${includeInactive ? '' : 'WHERE c.is_active = 1'}
     ORDER BY sort_order ASC, name ASC`,
  );
  const roots = rows
    .filter((r) => !r.parent_id)
    .map((r) => {
      const children = rows
        .filter((c) => c.parent_id === r.id)
        .map((c) => ({ ...c, product_count: c.product_count + childCount(rows, c.id) }));
      return { ...r, children, product_count: r.product_count + children.reduce((s, c) => s + c.product_count, 0) };
    });
  return { flat: rows, roots };
}

function childCount(rows, parentId) {
  return rows
    .filter((r) => r.parent_id === parentId)
    .reduce((sum, r) => sum + r.product_count + childCount(rows, r.id), 0);
}

export function brandList() {
  return all(
    `SELECT b.id, b.name, (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id AND p.is_active = 1) AS product_count
     FROM brands b WHERE b.is_active = 1 ORDER BY b.name ASC`,
  );
}

export function searchProducts(params = {}, user = null) {
  const scope = params.forceScope || scopeForUser(user);
  const limit = Math.min(120, Math.max(1, Number(params.limit) || 60));
  const page = Math.max(1, Number(params.page) || 1);
  const where = ['p.is_active = 1'];
  const args = [];

  if (params.q) {
    const term = escapeLike(params.q);
    if (term) {
      where.push(`(p.search_text LIKE ? OR p.name LIKE ? OR IFNULL(p.name_ta,'') LIKE ? OR IFNULL(b.name,'') LIKE ? OR IFNULL(c.name,'') LIKE ?)`);
      const like = `%${term}%`;
      args.push(like, like, like, like, like);
    }
  }
  if (params.categoryId) {
    const id = Number(params.categoryId);
    where.push(`(p.category_id = ? OR c.parent_id = ?)`);
    args.push(id, id);
  }
  if (params.brandId) {
    where.push('p.brand_id = ?');
    args.push(Number(params.brandId));
  }
  if (params.stock && ['in_stock', 'low_stock', 'out_of_stock'].includes(params.stock)) {
    where.push('p.stock_status = ?');
    args.push(params.stock);
  }
  if (params.featured === '1' || params.featured === 1 || params.featured === true) where.push('p.is_featured = 1');
  if (params.onlyTiers === '1') where.push('EXISTS (SELECT 1 FROM price_tiers t WHERE t.product_id = p.id)');

  // Price filter is applied against the price the viewer actually pays.
  const priceExpr = scope === 'wholesale' ? 'IFNULL(p.wholesale_price, p.retail_price)' : 'p.retail_price';
  if (params.minPrice !== undefined && params.minPrice !== '' && !Number.isNaN(Number(params.minPrice))) {
    where.push(`${priceExpr} >= ?`);
    args.push(Number(params.minPrice));
  }
  if (params.maxPrice !== undefined && params.maxPrice !== '' && !Number.isNaN(Number(params.maxPrice))) {
    where.push(`${priceExpr} <= ?`);
    args.push(Number(params.maxPrice));
  }

  const sortMap = {
    'price-asc': `${priceExpr} ASC`,
    'price-desc': `${priceExpr} DESC`,
    name: 'p.name ASC',
    discount: '(p.mrp - ' + priceExpr + ') * 1.0 / NULLIF(p.mrp,0) DESC',
    newest: 'p.id DESC',
  };
  const orderSql = sortMap[params.sort] || 'p.is_featured DESC, p.name ASC';

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = Number(pluck(`SELECT COUNT(*) AS n ${PRODUCT_JOIN} ${whereSql}`, args) || 0);
  const rows = attachTiers(
    all(`${PRODUCT_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [
      ...args,
      limit,
      (page - 1) * limit,
    ]),
  );

  return {
    scope,
    total,
    page,
    page_size: limit,
    has_more: page * limit < total,
    products: rows.map((p) => cardView(p, scope)),
  };
}

export function getProduct(id, user = null) {
  const scope = scopeForUser(user);
  const row = attachTiers([get(`${PRODUCT_SELECT} WHERE p.id = ?`, [Number(id) || 0])]).filter(Boolean)[0];
  if (!row) return null;
  return {
    ...cardView(row, scope),
    description: row.description || '',
    stock_qty: row.stock_qty === null ? null : Number(row.stock_qty),
    min_qty_retail: Number(row.min_qty_retail || 1),
    max_qty_retail: row.max_qty_retail ? Number(row.max_qty_retail) : null,
    all_tiers: row.tiers,
    tier_table: tierTable(row, scope),
    retail_tier_table: tierTable(row, 'retail'),
    price_mrp: round2(row.mrp),
    is_active: !!row.is_active,
  };
}

/** Compact view the product card needs (brand → name → pack → price → discount → add). */
export function cardView(p, scope) {
  const price = basePrice(p, scope);
  const mrp = round2(p.mrp || 0);
  return {
    id: p.id,
    name: p.name,
    name_ta: p.name_ta || null,
    brand: p.brand_name || null,
    category: p.category_name || null,
    category_ta: p.category_name_ta || null,
    category_id: p.category_id,
    pack_size: p.pack_size || '',
    unit: p.unit || 'piece',
    image: p.image || '/img/products/placeholder-1.svg',
    mrp,
    price,
    price_scope: scope,
    retail_price: round2(p.retail_price),
    wholesale_price: p.wholesale_price === null || p.wholesale_price === undefined ? null : round2(p.wholesale_price),
    discount_pct: percentOff(mrp, price),
    save_amount: round2(Math.max(0, mrp - price)),
    moq: Number(p.moq_wholesale || 1),
    min_qty: scope === 'wholesale' ? Number(p.moq_wholesale || 1) : Number(p.min_qty_retail || 1),
    stock_status: p.stock_status,
    is_featured: !!Number(p.is_featured || 0),
    has_tiers: (p.tiers || []).length > 0,
    tiers: (p.tiers || []).map((t) => ({
      min_qty: Number(t.min_qty),
      max_qty: t.max_qty === null ? null : Number(t.max_qty),
      unit_price: round2(t.unit_price),
      scope: t.scope,
    })),
  };
}

export function relatedProducts(productId, categoryId, user, limit = 6) {
  const scope = scopeForUser(user);
  const rows = attachTiers(
    all(`${PRODUCT_SELECT} WHERE p.is_active = 1 AND p.category_id = ? AND p.id != ? ORDER BY RANDOM() LIMIT ?`, [
      Number(categoryId) || 0,
      Number(productId) || 0,
      limit,
    ]),
  );
  return rows.map((r) => cardView(r, scope));
}

export function allActiveProductsForAdmin(search) {
  const args = [];
  let where = '1=1';
  if (search) {
    where += ' AND (p.name LIKE ? OR IFNULL(b.name,\'\') LIKE ?)';
    args.push(`%${escapeLike(search)}%`, `%${escapeLike(search)}%`);
  }
  return all(
    `${PRODUCT_SELECT} WHERE ${where} ORDER BY p.name ASC LIMIT 500`,
    args,
  );
}
