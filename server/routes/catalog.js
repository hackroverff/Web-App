/** Public catalogue reads. Prices shown here are display-only hints; the cart is authoritative. */
import express from 'express';
import { badRequest, notFound } from '../lib/errors.js';
import { categoryTree, brandList, searchProducts, getProduct, relatedProducts } from '../services/catalog.js';
import { priceLine, scopeForUser, tierTable } from '../services/pricing.js';
import { all, get, getSetting, getBoolSetting, getNumberSetting } from '../db/index.js';
import { intIn } from '../lib/validate.js';
import { clientSettings } from './auth.js';

export const router = express.Router();

/** One round-trip for the app to boot: filters, categories, brands, store settings. */
router.get('/bootstrap', (req, res) => {
  const scope = scopeForUser(req.user);
  const bounds = get('SELECT MIN(IFNULL(p.wholesale_price, p.retail_price)) AS min_price, MAX(p.retail_price) AS max_price FROM products p WHERE p.is_active = 1');
  res.json({
    settings: clientSettings(),
    scope,
    wholesale_locked: req.user ? req.user.role === 'wholesale' && req.user.status === 'pending_verification' : false,
    categories: categoryTree().roots,
    brands: brandList(),
    price_bounds: { min: Math.floor(Number(bounds.min_price) || 0), max: Math.ceil(Number(bounds.max_price) || 1000) },
    featured: searchProducts({ featured: '1', limit: 8, forceScope: scope }, req.user).products,
    total_products: Number(get('SELECT COUNT(*) AS n FROM products WHERE is_active=1').n || 0),
  });
});

router.get('/categories', (req, res) => res.json(categoryTree()));
router.get('/brands', (req, res) => res.json({ brands: brandList() }));

router.get('/products', (req, res) => {
  const q = req.query;
  const result = searchProducts(
    {
      q: typeof q.q === 'string' ? q.q : '',
      categoryId: q.category,
      brandId: q.brand,
      minPrice: q.min_price,
      maxPrice: q.max_price,
      sort: q.sort,
      stock: q.stock,
      featured: q.featured,
      onlyTiers: q.tiers,
      page: intIn(q.page, { field: 'page', min: 1, max: 500, fallback: 1 }),
      limit: intIn(q.limit, { field: 'limit', min: 1, max: 120, fallback: 60 }),
    },
    req.user,
  );
  res.json(result);
});

router.get('/products/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return next(badRequest('Unknown product.'));
  const product = getProduct(id, req.user);
  if (!product) return next(notFound('Product not found.'));
  const scope = scopeForUser(req.user);
  const raw = get('SELECT * FROM products WHERE id = ?', [id]);
  const brands = all('SELECT DISTINCT b.name FROM brands b JOIN products p ON p.brand_id=b.id WHERE p.is_active=1 ORDER BY b.name');
  res.json({
    product: {
      ...product,
      description: raw.description,
      is_active: !!raw.is_active,
    },
    scope,
    retail_price: Number(raw.retail_price),
    wholesale_price: raw.wholesale_price === null ? null : Number(raw.wholesale_price),
    tier_preview: tierTable({ ...raw, tiers: all('SELECT * FROM price_tiers WHERE product_id=? ORDER BY min_qty', [id]) }, scope),
    retail_tiers: tierTable({ ...raw, tiers: all("SELECT * FROM price_tiers WHERE product_id=? AND scope='retail' ORDER BY min_qty", [id]) }, 'retail'),
    brands: brands.map((b) => b.name),
    related: relatedProducts(id, raw.category_id, req.user, 6),
  });
});

/**
 * Server-side price preview for the quantity stepper. The client asks "what does
 * N units cost?" and the engine answers — so the product page's live total is
 * computed by the same code that later writes the order row.
 */
router.get('/products/:id/price', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const qty = intIn(req.query.qty, { field: 'qty', min: 1, max: 999, fallback: 1 });
    const scope = scopeForUser(req.user);
    const product = get(
      `SELECT p.*, b.name AS brand_name, c.name AS category_name FROM products p
       LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?`,
      [id],
    );
    if (!product) throw notFound('Product not found.');
    const tiers = all('SELECT * FROM price_tiers WHERE product_id=? ORDER BY min_qty', [id]);
    const line = priceLine({ product, qty, scope, tiers });
    res.json({
      line,
      moq: line.moq,
      min_qty: line.min_qty,
      can_order: !line.blocking,
      wholesale_locked: req.user ? req.user.role === 'wholesale' && req.user.status === 'pending_verification' : false,
      note: line.tier ? `Slab ${line.tier.label} applied` : scope === 'wholesale' ? 'Flat wholesale rate' : 'Retail rate',
    });
  } catch (err) {
    next(err);
  }
});

/** Store info for the "about/help" sheet. */
router.get('/store', (req, res) => {
  res.json({
    name: getSetting('store_name', 'Sathvika MV'),
    tagline: getSetting('store_tagline', ''),
    phone: getSetting('store_phone', ''),
    address: getSetting('store_address', ''),
    open: getBoolSetting('shop_open', true),
    eta_minutes: getNumberSetting('eta_minutes', 90),
    hours: getSetting('store_hours', 'Mon–Sat 7:30am–9:30pm · Sun 8:00am–1:00pm'),
  });
});
