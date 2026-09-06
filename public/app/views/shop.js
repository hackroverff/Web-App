/** Catalogue: search, filters, product grid, and the product detail screen. */
import { h, mount, debounce } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { t, localName } from '../core/i18n.js';
import { state, set, isWholesale, isWholesalePending } from '../core/store.js';
import { api, qs as buildQs } from '../core/api.js';
import { page, productCard, skeletonGrid, chipRow, notice, sheet, stepper, stockPill, pill, toast, emptyState } from '../core/components.js';
import { money, money2 } from '../core/format.js';
import { go } from '../core/router.js';

export function docTitle(params, query) {
  return query?.q ? `${query.q}` : t('nav.shop');
}

/* ----------------------------------------------------------------- shop view -- */
export async function shopView(root, { query, onRefresh }) {
  const filters = {
    q: query.q ?? state.catalog.q ?? '',
    category: query.category ? Number(query.category) : state.catalog.category,
    brand: query.brand ?? state.catalog.brand,
    minPrice: state.catalog.minPrice ?? '',
    maxPrice: state.catalog.maxPrice ?? '',
    stock: state.catalog.stock ?? null,
    sort: query.sort || state.catalog.sort || 'featured',
  };
  let results = null;
  let loading = true;
  const grid = h('div', {});

  const load = async (append = false) => {
    loading = true;
    paint();
    try {
      const data = await api.get(`/api/catalog/products${buildQs({
        q: filters.q,
        category: filters.category,
        brand: filters.brand,
        min_price: filters.minPrice,
        max_price: filters.maxPrice,
        sort: filters.sort === 'featured' ? '' : filters.sort,
        stock: filters.stock,
        page: append ? (results.page || 1) + 1 : 1,
        limit: 60,
      })}`);
      results = append ? { ...data, products: [...results.products, ...data.products] } : data;
      state.catalog = { ...filters, results };
    } catch (err) {
      toast(err.message, { kind: err.status === 0 ? 'warn' : 'bad' });
      results = results || { products: [], total: 0, has_more: false, page: 1 };
    }
    loading = false;
    paint();
  };

  const search = h('input', { type: 'search', placeholder: t('shop.search'), value: filters.q, 'aria-label': t('common.search') });
  search.addEventListener('input', debounce(() => {
    filters.q = search.value.trim();
    load();
  }, 320));

  const activeCount = [filters.category, filters.brand, filters.minPrice, filters.maxPrice, filters.stock].filter((v) => v !== null && v !== undefined && v !== '').length;
  const filterBtn = h('button', { class: 'chip', style: 'height:46px;padding:0 14px;flex:0 0 auto', onclick: () => openFilters() },
    h('span', { style: 'width:17px', html: icons.sliders }),
    t('shop.filters'),
    activeCount ? pill(String(activeCount), 'ok') : null);

  const sortRow = chipRow(
    [
      { value: 'featured', label: t('shop.sort.featured') },
      { value: 'price-asc', label: t('shop.sort.price_low') },
      { value: 'price-desc', label: t('shop.sort.price_high') },
      { value: 'discount', label: t('shop.sort.discount') },
      { value: 'name', label: t('shop.sort.name') },
    ],
    filters.sort,
    (value) => {
      filters.sort = value;
      load();
    },
  );

  /* filter sheet ---------------------------------------------------------- */
  function openFilters() {
    const cats = [];
    const walk = (list, depth = 0) => {
      for (const c of list) {
        cats.push({ id: c.id, label: `${depth ? '└ ' : ''}${state.lang === 'ta' && c.name_ta ? c.name_ta : c.name}`, count: c.product_count });
        if (c.children?.length) walk(c.children, depth + 1);
      }
    };
    walk(state.bootstrap?.categories || []);
    const temp = { ...filters };

    const chipSelect = (options, getVal, setVal) => {
      const row = h('div', { class: 'chips' });
      const buttons = options.map((opt) => {
        const btn = h('button', {
          class: 'chip row-scroll',
          type: 'button',
          'aria-pressed': String(String(getVal()) === String(opt.value ?? '')),
          onclick: () => {
            setVal(getVal() === opt.value ? null : opt.value);
            for (const b of buttons) b.setAttribute('aria-pressed', String(String(getVal()) === String(b.dataset.value)));
          },
          dataset: { value: String(opt.value ?? '') },
        }, opt.label);
        return btn;
      });
      row.append(...buttons);
      return row;
    };

    const minInput = h('input', { class: 'input', type: 'number', min: 0, placeholder: 'Min', value: temp.minPrice || '' });
    const maxInput = h('input', { class: 'input', type: 'number', min: 0, placeholder: 'Max', value: temp.maxPrice || '' });
    minInput.addEventListener('input', () => { temp.minPrice = minInput.value; });
    maxInput.addEventListener('input', () => { temp.maxPrice = maxInput.value; });

    const body = h('div', { class: 'stack', style: 'gap:16px' },
      h('div', {},
        h('h4', { style: 'margin-bottom:6px', text: t('shop.category') }),
        chipSelect([{ value: null, label: t('common.all') }, ...cats.map((c) => ({ value: c.id, label: `${c.label}${c.count ? ` · ${c.count}` : ''}` }))], () => temp.category, (v) => { temp.category = v; })),
      h('div', {},
        h('h4', { style: 'margin-bottom:6px', text: t('shop.brand') }),
        chipSelect([{ value: null, label: t('common.all') }, ...(state.bootstrap?.brands || []).map((b) => ({ value: b.id, label: b.name }))], () => temp.brand, (v) => { temp.brand = v; })),
      h('div', {},
        h('h4', { style: 'margin-bottom:6px', text: t('shop.price') }),
        h('div', { class: 'grid2' }, minInput, maxInput)),
      h('div', {},
        h('h4', { style: 'margin-bottom:6px', text: t('shop.stock') }),
        chipSelect([
          { value: null, label: t('common.all') },
          { value: 'in_stock', label: t('shop.in_stock') },
          { value: 'low_stock', label: t('shop.low_stock') },
          { value: 'out_of_stock', label: t('shop.out_of_stock') },
        ], () => temp.stock, (v) => { temp.stock = v; })));

    const handle = sheet({
      title: t('shop.filters'),
      body,
      actions: [
        h('button', {
          class: 'btn ghost', text: t('common.clear'),
          onclick: () => {
            Object.assign(filters, { category: null, brand: null, minPrice: '', maxPrice: '', stock: null, q: filters.q });
            search.value = filters.q;
            handle.close();
            load();
          },
        }),
        h('button', {
          class: 'btn', text: `${t('common.apply')}${''}`,
          onclick: () => {
            Object.assign(filters, { category: temp.category, brand: temp.brand, minPrice: temp.minPrice, maxPrice: temp.maxPrice, stock: temp.stock });
            handle.close();
            load();
          },
        }),
      ],
    });
  }

  /* paint ----------------------------------------------------------------- */
  const paint = () => {
    if (loading) return mount(grid, skeletonGrid(10));
    const items = results?.products || [];
    mount(grid,
      h('div', { class: 'row', style: 'justify-content:space-between;margin:2px 0 8px' },
        h('span', { class: 'small muted', text: t('shop.count', { n: results?.total ?? items.length }) }),
        results?.scope === 'wholesale' ? pill(t('shop.tier_applied'), 'info') : null),
      items.length
        ? h('div', { class: 'grid-products' }, ...items.map((p) => productCard(p, { onAdd: addToCart, onOpen: (prod) => go(`/product/${prod.id}`) })))
        : emptyState('search', t('shop.empty'), 'Try another word, or clear the filters.',
          h('button', {
            class: 'btn secondary sm', text: t('common.clear'),
            onclick: () => {
              Object.assign(filters, { q: '', category: null, brand: null, minPrice: '', maxPrice: '', stock: null });
              search.value = '';
              load();
            },
          })),
      results?.has_more ? h('button', { class: 'btn ghost block', style: 'margin-top:12px', text: 'Load more', onclick: () => load(true) }) : null);
  };

  const addToCart = async (product) => {
    if (!state.user) return window.smvRequireLogin();
    const wanted = Math.max(1, product.min_qty || 1);
    try {
      const cart = await api.post('/api/cart/items', { product_id: product.id, qty: wanted });
      set({ cart });
      const line = cart.lines.find((l) => l.product_id === product.id);
      toast(line && line.qty > wanted ? `${product.name}: ${t('cart.moq_fix')} ${line.qty}` : t('shop.added'), {
        kind: 'ok',
        action: { label: t('nav.cart'), run: () => go('/cart') },
      });
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  page({
    root,
    tab: 'shop',
    header: { user: state.user, cart: state.cart },
    children: [
      h('div', { class: 'row', style: 'gap:8px;margin-bottom:8px' }, h('div', { class: 'searchbar', style: 'flex:1' }, h('span', { html: icons.search }), search), filterBtn),
      isWholesale() ? notice('info', t('shop.wholesale_viewing')) : null,
      isWholesalePending() ? notice('warn', t('shop.locked_viewing')) : null,
      sortRow,
      grid,
    ],
  });
  paint();
  await load();
  onRefresh(() => paint());
}

/* --------------------------------------------------------------- product page -- */
export async function productView(root, { params, onRefresh }) {
  const id = Number(params.id);
  let data = null;
  let qty = 1;
  let preview = null;

  const pricingNode = h('div', { class: 'card pad' });
  const stepperNode = h('div', {});
  const addBtn = h('button', { class: 'btn block', style: 'margin-top:12px', text: t('shop.add') });
  const tiersNode = h('div', {});
  const relatedNode = h('div', {});
  const body = h('div', {});

  const pricePreview = debounce(async () => {
    try {
      preview = await api.get(`/api/catalog/products/${id}/price${buildQs({ qty })}`);
      paintPricing();
    } catch {
      /* offline: keep the last known numbers */
    }
  }, 180);

  const stepperFor = () =>
    stepper({
      value: qty,
      min: 1,
      max: 99,
      size: 'lg',
      onChange: (v) => {
        qty = v;
        pricePreview();
      },
    });

  const pricingBlock = () => {
    const p = data.product;
    const line = preview?.line;
    const unit = line ? line.unit_price : p.price;
    const total = line ? line.line_total : unit * qty;
    const mrp = line ? line.mrp : p.mrp;
    const save = line ? line.save_amount : Math.max(0, (mrp - unit) * qty);
    const discount = line ? line.discount_pct : p.discount_pct;
    return h('div', { class: 'stack', style: 'gap:8px' },
      h('div', { class: 'row', style: 'align-items:baseline;gap:8px;flex-wrap:wrap' },
        h('span', { class: 'price lg', text: money(unit) }),
        h('span', { class: 'tiny muted', text: `/ ${p.pack_size || p.unit}` }),
        mrp > unit ? h('span', { class: 'price strike', text: money(mrp) }) : null,
        discount > 0 ? pill(`−${discount}%`, 'save') : null),
      line?.tier
        ? h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
          pill(`${t('shop.tier_applied')}: ${line.tier.label}`, 'info'),
          h('span', { class: 'tiny muted', text: `${money2(line.tier.unit_price)} / unit` }))
        : h('span', { class: 'tiny muted', text: preview?.note || (data.scope === 'wholesale' ? 'Wholesale rate' : 'Retail rate') }),
      save > 0 ? h('div', { class: 'save-line' }, h('span', { html: icons.sparkles }), t('shop.save', { amt: money(save) })) : null,
      h('div', { class: 'row', style: 'justify-content:space-between;padding-top:6px;border-top:1px dashed var(--line)' },
        h('span', { class: 'small muted', text: `${qty} × ${money(unit)}` }),
        h('strong', { text: money2(total) })),
      preview && !preview.can_order ? notice('bad', preview.line.errors[0]) : null,
      preview?.line?.warnings?.length ? notice('warn', preview.line.warnings[0]) : null);
  };

  const paintPricing = () => {
    mount(pricingNode, pricingBlock());
    mount(stepperNode, stepperFor());
    paintTiers();
  };

  const paintTiers = () => {
    const p = data.product;
    if (data.scope !== 'wholesale' || !p.tier_table?.length) return mount(tiersNode, '');
    const best = preview?.line?.tier;
    mount(tiersNode,
      h('div', { class: 'card pad' },
        h('h3', { style: 'font-size:15px;margin-bottom:6px', text: t('shop.tiers') }),
        h('table', { class: 'tier-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Quantity' }), h('th', { text: t('shop.unit_price') }), h('th', { text: t('common.discount') }))),
          h('tbody', {}, ...p.tier_table.map((row) => h('tr', {
            class: best && money2(row.unit_price) === money2(best.unit_price) ? 'current' : '',
          },
          h('td', { text: row.label }),
          h('td', { text: money2(row.unit_price) }),
          h('td', { text: row.savings_vs_mrp ? `−${row.savings_vs_mrp}%` : '—' })))))
        ,
        h('div', { class: 'tiny muted', style: 'margin-top:6px', text: 'Slabs are applied automatically as you change quantity.' })));
  };

  const add = async () => {
    if (!state.user) return window.smvRequireLogin();
    try {
      const cart = await api.post('/api/cart/items', { product_id: id, qty });
      set({ cart });
      const line = cart.lines.find((l) => l.product_id === id);
      toast(line && line.qty > qty ? `${t('cart.moq_fix')}: ${line.qty}` : t('shop.added'), {
        kind: 'ok',
        action: { label: t('nav.cart'), run: () => go('/cart') },
      });
      qty = line?.qty || qty;
      paintPricing();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };
  addBtn.addEventListener('click', add);

  page({
    root,
    tab: null,
    header: { user: state.user, cart: state.cart },
    children: [body],
  });

  try {
    data = await api.get(`/api/catalog/products/${id}`);
  } catch (err) {
    toast(err.message, { kind: 'bad' });
    return go('/shop');
  }
  qty = Math.max(1, data.product.min_qty || 1);

  const p = data.product;
  mount(body,
    h('div', { class: 'detail-2col' },
      h('div', { class: 'detail-hero' },
        h('img', { src: p.image, alt: localName(p), width: 600, height: 450 }),
        h('div', { class: 'detail-body' },
          h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
            stockPill(p.stock_status),
            p.moq > 1 ? pill(`MOQ ${p.moq}`, 'info') : null,
            p.max_qty_retail ? pill(`${t('shop.max_qty')} ${p.max_qty_retail}`, 'grey') : null),
          h('div', { style: 'margin-top:8px' },
            h('div', { class: 'pcard-brand', text: p.brand || '' }),
            h('h1', { style: 'font-size:22px;margin:2px 0 2px', text: localName(p) }),
            h('div', { class: 'small muted', text: [p.pack_size, p.category].filter(Boolean).join(' · ') })),
          p.description ? h('p', { class: 'small', style: 'margin-top:8px', text: p.description }) : null,
          h('div', { class: 'row', style: 'gap:14px;margin-top:10px' },
            h('div', {}, h('div', { class: 'tiny muted', text: 'MRP' }), h('strong', { text: money2(p.mrp) })),
            h('div', {}, h('div', { class: 'tiny muted', text: 'Retail' }), h('strong', { text: money2(p.retail_price) })),
            p.wholesale_price !== null && p.wholesale_price !== undefined
              ? h('div', {}, h('div', { class: 'tiny muted', text: 'Wholesale' }), h('strong', { text: money2(p.wholesale_price) }))
              : null))),
      h('div', { class: 'stack' },
        pricingNode,
        h('div', { class: 'card pad' },
          h('div', { class: 'row', style: 'justify-content:space-between' },
            h('div', {}, h('div', { class: 'tiny muted', text: t('shop.qty') })),
            stepperNode),
          addBtn,
          h('div', { class: 'tiny muted', style: 'margin-top:8px;text-align:center', text: t('cart.priced_by') })),
        tiersNode,
        isWholesale() || isWholesalePending()
          ? null
          : notice('info', 'Wholesale buyers see slab prices automatically after approval.',
            h('button', { class: 'linklike', text: t('profile.apply_wholesale'), onclick: () => go('/profile') })),
        relatedNode)));

  paintPricing();
  mount(relatedNode,
    data.related?.length
      ? h('div', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', { style: 'font-size:16px', text: t('shop.related') })),
        h('div', { class: 'chips' }, ...data.related.map((r) => h('button', { class: 'chip', onclick: () => go(`/product/${r.id}`) }, `${localName(r)} · ${money(r.price)}`))))
      : '');

  addBtn.disabled = p.stock_status === 'out_of_stock';
  if (p.stock_status === 'out_of_stock') addBtn.textContent = t('shop.out_of_stock');

  onRefresh(() => productView(root, { params, onRefresh }));
}
