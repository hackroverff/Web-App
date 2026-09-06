/**
 * ── PRICING ENGINE (server-side only) ────────────────────────────────────────
 * This module is the single source of truth for every rupee in the app.
 * The frontend never multiplies a price by a quantity to arrive at a
 * chargeable total: cart/checkout responses are produced here and the order
 * row is written from here, so tampering with client state cannot change what
 * a customer pays.
 *
 * Rules
 *  • Retail customers (and wholesale accounts that are not yet approved) pay
 *    `retail_price`.
 *  • Approved wholesale accounts pay `wholesale_price` when one is set.
 *  • Quantity tiers (slabs) override the base price when the ordered quantity
 *    falls inside them, e.g. 6-20 → ₹95. Tiers are scoped: a `wholesale` slab
 *    only applies to wholesale accounts, a `retail` slab to retail carts.
 *  • MOQ (wholesale) and min/max quantity (retail) are enforced here too, so a
 *    hand-crafted API call cannot bypass them.
 */
import { round2, percentOff } from '../lib/money.js';

export const SCOPE_RETAIL = 'retail';
export const SCOPE_WHOLESALE = 'wholesale';

/** Which pricing scope applies to this user right now. */
export function scopeForUser(user) {
  if (!user) return SCOPE_RETAIL;
  const approved = user.role === 'wholesale' && user.status === 'active';
  return approved ? SCOPE_WHOLESALE : SCOPE_RETAIL;
}

export function basePrice(product, scope) {
  if (scope === SCOPE_WHOLESALE && product.wholesale_price !== null && product.wholesale_price !== undefined) {
    return round2(product.wholesale_price);
  }
  return round2(product.retail_price);
}

/** Find the slab a quantity falls into. `open` tiers have max_qty = NULL. */
export function findTier(tiers = [], qty, scope) {
  let best = null;
  for (const t of tiers) {
    if ((t.scope || SCOPE_WHOLESALE) !== scope) continue;
    const min = Number(t.min_qty);
    const max = t.max_qty === null || t.max_qty === undefined ? Infinity : Number(t.max_qty);
    if (qty >= min && qty <= max && (!best || min > Number(best.min_qty))) best = t;
  }
  return best;
}

export function tierLabel(tier) {
  if (!tier) return null;
  return tier.max_qty === null || tier.max_qty === undefined
    ? `${tier.min_qty}+ units`
    : `${tier.min_qty}-${tier.max_qty} units`;
}

/**
 * Price one cart/order line.
 * @returns {object} line + `errors` (blockers) + `warnings` (advisory)
 */
export function priceLine({ product, qty, scope = SCOPE_RETAIL, tiers = [] }) {
  const errors = [];
  const warnings = [];
  const quantity = Math.trunc(Number(qty) || 0);

  if (product.is_active === 0) errors.push('This product is no longer available.');
  if (product.stock_status === 'out_of_stock') errors.push('Out of stock — remove it to continue.');
  if (product.stock_status === 'low_stock') warnings.push('Low stock — quantity may change while packing.');

  const minQty = minQuantityFor(product, scope);
  const maxQty = maxQuantityFor(product, scope);

  if (quantity < 1) errors.push('Quantity must be at least 1.');
  if (quantity < minQty) {
    errors.push(
      scope === SCOPE_WHOLESALE
        ? `Wholesale minimum is ${minQty} ${packNoun(product, minQty)} for this item.`
        : `Minimum ${minQty} ${packNoun(product, minQty)} for this item.`,
    );
  }
  if (maxQty !== null && quantity > maxQty) {
    warnings.push(`Only ${maxQty} ${packNoun(product, maxQty)} per order for this item.`);
  }

  const tier = findTier(tiers, quantity, scope);
  const unitPrice = tier ? round2(tier.unit_price) : basePrice(product, scope);
  const lineTotal = round2(unitPrice * Math.max(quantity, 0));
  const mrp = round2(product.mrp || 0);
  const save = round2(Math.max(0, (mrp - unitPrice) * Math.max(quantity, 0)));

  return {
    product_id: product.id,
    name: product.name,
    name_ta: product.name_ta || null,
    brand: product.brand_name || null,
    category: product.category_name || null,
    category_id: product.category_id ?? null,
    pack_size: product.pack_size || '',
    unit: product.unit || 'piece',
    image: product.image || null,
    mrp,
    qty: quantity,
    unit_price: unitPrice,
    line_total: lineTotal,
    price_scope: scope,
    tier: tier
      ? { min_qty: Number(tier.min_qty), max_qty: tier.max_qty === null ? null : Number(tier.max_qty), unit_price: round2(tier.unit_price), label: tierLabel(tier) }
      : null,
    tier_label: tier ? tierLabel(tier) : null,
    discount_pct: percentOff(mrp, unitPrice),
    save_amount: save,
    stock_status: product.stock_status,
    min_qty: minQty,
    max_qty: maxQty,
    moq: Number(product.moq_wholesale || 1),
    errors,
    warnings,
    blocking: errors.length > 0,
  };
}

export function minQuantityFor(product, scope) {
  if (scope === SCOPE_WHOLESALE) return Math.max(1, Math.trunc(Number(product.moq_wholesale) || 1));
  return Math.max(1, Math.trunc(Number(product.min_qty_retail) || 1));
}

export function maxQuantityFor(product, scope) {
  const cap = scope === SCOPE_WHOLESALE ? null : product.max_qty_retail;
  const n = Math.trunc(Number(cap || 0));
  return n > 0 ? n : null;
}

function packNoun(product, qty) {
  const unit = product.unit || 'piece';
  const label = ['kg', 'g', 'litre', 'ml'].includes(unit) ? unit : `${unit}${Number(qty) === 1 ? '' : 's'}`;
  return `${label || 'units'}`;
}

/**
 * Full cart/order summary. Also where store-level rules (minimum order value,
 * delivery charge, free-delivery threshold) are applied.
 */
export function summarise({ lines, user, settings, enforceMinOrder = true }) {
  const scope = scopeForUser(user);
  const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
  const mrpValue = round2(lines.reduce((s, l) => s + (l.mrp || 0) * l.qty, 0));
  const wholesaleSave = round2(lines.reduce((s, l) => s + l.save_amount, 0));
  const deliveryCharge = subtotal > 0 && Number(settings.delivery_charge) > 0 && subtotal < Number(settings.free_delivery_above || 0)
    ? round2(Number(settings.delivery_charge))
    : 0;
  const total = round2(subtotal + deliveryCharge);

  const minOrder = scope === SCOPE_WHOLESALE
    ? Number(settings.min_order_wholesale || 0)
    : Number(settings.min_order_retail || 0);
  const shortBy = round2(Math.max(0, minOrder - subtotal));

  return {
    account_type: scope,
    item_count: lines.reduce((s, l) => s + l.qty, 0),
    line_count: lines.length,
    subtotal,
    mrp_value: mrpValue,
    discount: round2(Math.max(0, mrpValue - subtotal)),
    wholesale_savings: wholesaleSave,
    delivery_charge: deliveryCharge,
    free_delivery_above: Number(settings.free_delivery_above || 0),
    total,
    min_order_value: minOrder,
    min_order_met: !enforceMinOrder || subtotal === 0 || subtotal >= minOrder,
    min_order_short_by: subtotal > 0 ? shortBy : round2(Math.max(0, minOrder)),
    min_order_label: scope === SCOPE_WHOLESALE ? 'per-product MOQ' : `minimum order ₹${Math.round(minOrder)}`,
    blocking_lines: lines.filter((l) => l.blocking).map((l) => ({ product_id: l.product_id, name: l.name, errors: l.errors })),
    warnings: lines.flatMap((l) => l.warnings.map((w) => `${l.name}: ${w}`)),
  };
}

/** Tier table used by the product detail page (display only — pricing still runs server-side at cart time). */
export function tierTable(product, scope) {
  const tiers = (product.tiers || []).filter((t) => (t.scope || 'wholesale') === scope);
  const rows = [];
  const base = basePrice(product, scope);
  if (!tiers.length) return [{ label: '1+', unit_price: base, savings_vs_mrp: percentOff(product.mrp, base) }];
  const sorted = [...tiers].sort((a, b) => Number(a.min_qty) - Number(b.min_qty));
  let cursor = 1;
  for (const t of sorted) {
    if (Number(t.min_qty) > cursor) {
      rows.push({ label: `${cursor}-${Number(t.min_qty) - 1}`, unit_price: base, savings_vs_mrp: percentOff(product.mrp, base) });
    }
    rows.push({
      label: t.max_qty ? `${t.min_qty}-${t.max_qty}` : `${t.min_qty}+`,
      unit_price: round2(t.unit_price),
      savings_vs_mrp: percentOff(product.mrp, t.unit_price),
      current_best: false,
    });
    cursor = Number(t.max_qty || 1e9) + 1;
  }
  return rows;
}
