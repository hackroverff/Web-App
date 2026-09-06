/** Owner admin area: menu list, wholesale approvals, payment reconciliation, scratch, history, messages, settings. */
import { h, mount, debounce } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { t, localName } from '../core/i18n.js';
import { state, set } from '../core/store.js';
import { api, qs } from '../core/api.js';
import { sheet, toast, pill, notice, emptyState, section, buildForm, searchField, chipRow, confirmSheet, statusChip, kpiCard, kv } from '../core/components.js';
import { money, money2, shortDate, dateTime, timeAgo, plural, initials } from '../core/format.js';
import { ownerShell, elevateBar, elevate, lockNow } from './shared.js';

export function docTitle() {
  return t('owner.title');
}

/** Every admin screen starts the same way: shell + lock state + reload helper. */
async function adminShell(root, title, { reload, children }) {
  const body = h('div', { class: 'stack' }, ...children);
  const out = await ownerShell(root, { title, children: [body], reload });
  return { body, ...out };
}

const canEdit = () => state.owner.level === 'admin';
const priceOr = (v) => (canEdit() ? money2(v) : '•••');

/* ------------------------------------------------------------- menu list ----- */
export async function menuView(root, { query, onRefresh }) {
  let products = [];
  let counts = {};
  let filter = { search: query.search || '', low: query.low === '1' ? '1' : '', category: query.category ? Number(query.category) : null };

  const { body } = await adminShell(root, t('owner.menu_list'), {
    reload: () => load(),
    children: [h('div', { class: 'sk', style: 'height:220px' })],
  });

  const load = async () => {
    try {
      const res = await api.get(`/api/admin/products${qs({ search: filter.search, low: filter.low, category: filter.category, limit: 400 })}`);
      products = res.products;
      counts = res.counts;
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const search = searchField(t('menu.search'), debounce((v) => { filter.search = v; load(); }, 320), filter.search);

  const paint = () => {
    const session = state.owner.session || {};
    mount(body,
      h('div', { class: 'row', style: 'gap:8px' },
        h('div', { class: 'searchbar', style: 'flex:1' }, h('span', { html: icons.search }), search.input),
        h('button', { class: 'chip', style: 'height:46px', 'aria-pressed': String(!!filter.low), onclick: () => { filter.low = filter.low ? '' : '1'; search.setValue?.(filter.search); load(); } },
          h('span', { style: 'width:16px', html: icons.alert }), t('owner.low_only'))),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        pill(`${counts.total || 0} ${t('menu.items')}`, 'grey'),
        counts.low ? pill(`${counts.low} ${t('owner.low_stock')}`, 'low') : null,
        counts.inactive ? pill(`${counts.inactive} ${t('menu.hidden')}`, 'grey') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', text: t('menu.add'), onclick: () => (canEdit() ? productSheet(null) : needUnlock()) })),
      elevateBar({
        level: state.owner.level,
        minutesLeft: session.minutes_left || 0,
        onElevate: () => elevate(() => load(), session),
        onLock: () => lockNow(() => load()),
        note: canEdit() ? t('menu.elevated_note') : t('menu.locked_note'),
      }),
      products.length
        ? h('div', { class: 'stack' }, ...products.map(productRow))
        : emptyState('list', t('menu.none'), 'Nothing matches that search.'),
      h('p', { class: 'tiny muted', style: 'text-align:center', text: t('menu.tax_note') }));
  };

  const productRow = (p) => h('div', { class: 'listrow', style: 'gap:10px;align-items:flex-start' },
    h('img', { src: p.image || '/img/products/placeholder-1.svg', alt: '', width: 46, height: 40, style: 'border-radius:8px;background:var(--paper-2);flex:0 0 auto', loading: 'lazy' }),
    h('div', { style: 'flex:1;min-width:0' },
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        h('strong', { style: 'font-size:14px', text: localName(p) }),
        p.is_active ? null : pill(t('menu.hidden'), 'grey'),
        p.is_featured ? pill(t('menu.featured'), 'info') : null,
        p.tiers?.length && canEdit() ? pill(`${p.tiers.length} ${t('menu.slabs')}`, 'save') : null),
      h('div', { class: 'tiny muted', text: `${p.brand_name || '—'} · ${p.category_name || '—'} · ${p.pack_size || p.unit}` }),
      h('div', { class: 'row', style: 'gap:8px;margin-top:4px;flex-wrap:wrap' },
        h('span', { class: 'mono tiny', text: `MRP ${priceOr(p.mrp)}` }),
        h('span', { class: 'mono tiny strong', text: `${t('menu.retail')} ${priceOr(p.retail_price)}` }),
        p.wholesale_price !== null ? h('span', { class: 'mono tiny', style: 'color:var(--green-700)', text: `${t('menu.wholesale')} ${priceOr(p.wholesale_price)}` }) : null,
        h('span', { class: 'tiny muted', text: `MOQ ${p.moq_wholesale || 1} · min ${p.min_qty_retail || 1}` })),
      h('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' },
        stockPillFor(p),
        p.stock_qty === null ? pill(t('menu.untracked'), 'grey') : null)),
    h('div', { class: 'stack', style: 'gap:6px;align-items:flex-end' },
      h('button', { class: 'btn sm secondary', text: t('owner.stock'), onclick: () => stockSheet(p) }),
      h('button', { class: 'btn sm ghost', text: t('common.edit'), onclick: () => (canEdit() ? productSheet(p) : needUnlock()) })),
    );

  const stockSheet = (p) => {
    let qty = Number(p.stock_qty ?? 0);
    let status = p.stock_status;
    const qtyInput = h('input', { class: 'input mono', type: 'number', min: 0, step: '0.25', value: String(p.stock_qty ?? '') });
    const handle = sheet({
      title: `${t('owner.stock')} · ${p.name}`,
      body: h('div', { class: 'stack' },
        h('p', { class: 'small muted', text: `Low-stock alert at ${p.low_stock_qty ?? 5} ${p.unit}. Counting stock here never exposes prices.` }),
        h('div', { class: 'field' }, h('label', { text: `${t('menu.stock_qty')} (${p.unit})` }), qtyInput),
        h('div', { class: 'chips' }, ...[['in_stock', t('shop.in_stock')], ['low_stock', t('shop.low_stock')], ['out_of_stock', t('shop.out_of_stock')]].map(([v, label]) => h('button', {
          class: 'chip', 'aria-pressed': String(status === v), onclick: (e) => { status = v; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', 'false'); e.currentTarget.setAttribute('aria-pressed', 'true'); if (v === 'out_of_stock') qtyInput.value = '0'; },
        }, label))),
        h('div', { class: 'row', style: 'gap:8px' },
          h('button', { class: 'btn ghost', text: t('menu.counted'), onclick: () => { qtyInput.value = String((Number(p.stock_qty) || 0) + 10); } }),
          h('button', { class: 'btn', style: 'flex:1', text: t('common.save'), onclick: async () => {
            try {
              const patch = status === 'out_of_stock' ? { stock_status: 'out_of_stock', low_stock_qty: p.low_stock_qty } : { stock_qty: qtyInput.value === '' ? '' : Number(qtyInput.value), stock_status: status };
              const res = await api.post(`/api/admin/products/${p.id}/stock`, patch);
              handle.close();
              toast(res.message, { kind: 'ok' });
              load();
            } catch (err) {
              toast(err.message, { kind: 'bad' });
            }
          } }))),
    });
    void qty;
  };

  const productSheet = (p) => {
    const cats = flattenCategories(state.bootstrap?.categories || []);
    const tiers = (p?.tiers || []).map((x) => ({ ...x }));
    const tierRows = h('div', { class: 'stack', style: 'gap:6px' });
    const paintTiers = () => {
      mount(tierRows,
        ...tiers.map((row, idx) => h('div', { class: 'row', style: 'gap:6px;align-items:center' },
          h('input', { class: 'input mono', style: 'flex:1', type: 'number', min: 1, placeholder: 'from', value: row.min_qty, oninput: (e) => { row.min_qty = e.target.value; } }),
          h('input', { class: 'input mono', style: 'flex:1', type: 'number', placeholder: 'to (blank = ∞)', value: row.max_qty ?? '', oninput: (e) => { row.max_qty = e.target.value; } }),
          h('input', { class: 'input mono', style: 'flex:1.2', type: 'number', step: '0.01', placeholder: 'price', value: row.unit_price, oninput: (e) => { row.unit_price = e.target.value; } }),
          h('button', { class: 'iconbtn', type: 'button', 'aria-label': t('common.remove'), html: icons.close, onclick: () => { tiers.splice(idx, 1); paintTiers(); } }))),
        h('button', { class: 'btn sm ghost block', type: 'button', text: t('menu.add_slab'), onclick: () => { tiers.push({ scope: 'wholesale', min_qty: '', max_qty: '', unit_price: '' }); paintTiers(); } }));
    };
    paintTiers();

    const form = buildForm([
      { name: 'section_a', type: 'section', label: t('menu.details') },
      { name: 'name', label: t('menu.name'), required: true, maxlength: 120, value: p?.name || '' },
      { name: 'name_ta', label: t('menu.name_ta'), maxlength: 120, value: p?.name_ta || '' },
      { name: 'category_id', label: t('menu.category'), type: 'select', value: p?.category_id || '', placeholder: 'Choose category', options: cats.map((c) => ({ value: c.id, label: c.label })) },
      { name: 'brand', label: t('menu.brand'), maxlength: 60, value: p?.brand_name || p?.brand || '' },
      { name: 'pack_size', label: t('menu.pack'), maxlength: 40, value: p?.pack_size || '' },
      { name: 'unit', label: t('menu.unit'), type: 'select', value: p?.unit || 'kg', options: ['kg', 'g', 'l', 'ml', 'piece', 'packet', 'dozen'].map((v) => ({ value: v, label: v })) },
      { name: 'description', label: t('common.description'), type: 'textarea', rows: 2, maxlength: 600, value: p?.description || '' },
      { name: 'section_b', type: 'section', label: t('menu.pricing') },
      { name: 'mrp', label: t('menu.mrp'), type: 'number', step: '0.01', required: true, value: p?.mrp ?? '' },
      { name: 'retail_price', label: t('menu.retail'), type: 'number', step: '0.01', required: true, value: p?.retail_price ?? '' },
      { name: 'wholesale_price', label: t('menu.wholesale'), type: 'number', step: '0.01', value: p?.wholesale_price ?? '', hint: t('menu.wholesale_hint') },
      { name: 'section_c', type: 'section', label: t('menu.limits') },
      { name: 'min_qty_retail', label: t('menu.min_retail'), type: 'number', min: 1, value: p?.min_qty_retail ?? 1 },
      { name: 'max_qty_retail', label: t('menu.max_retail'), type: 'number', min: 1, value: p?.max_qty_retail ?? '' },
      { name: 'moq_wholesale', label: t('menu.moq'), type: 'number', min: 1, value: p?.moq_wholesale ?? 1 },
      { name: 'low_stock_qty', label: t('menu.low_alert'), type: 'number', min: 0, value: p?.low_stock_qty ?? 5 },
      { name: 'section_d', type: 'section', label: t('menu.slabs') },
      { name: '__tiers', label: 'Quantity → price', type: 'html', el: tierRows },
      { name: 'is_active', label: t('menu.visible'), type: 'checkbox', value: p ? !!p.is_active : true },
      { name: 'is_featured', label: t('menu.featured'), type: 'checkbox', value: p ? !!p.is_featured : false },
    ], {
      submitLabel: p ? t('common.save') : t('menu.add'),
      onSubmit: async (values, { setError }) => {
        const payload = { ...values, tiers: tiers.filter((x) => x.min_qty !== '' && x.unit_price !== '') };
        try {
          const res = p ? await api.put(`/api/admin/products/${p.id}`, payload) : await api.post('/api/admin/products', payload);
          handle.close();
          toast(res.message, { kind: 'ok' });
          load();
        } catch (err) {
          const field = err.fields ? Object.keys(err.fields)[0] : null;
          setError(field || 'name', err.message);
        }
      },
    });
    const handle = sheet({
      title: p ? `${t('common.edit')} · ${p.name}` : t('menu.add'),
      size: 'wide',
      body: h('div', { class: 'stack' }, form.el, p
        ? h('button', {
          class: 'btn ghost block', style: 'color:var(--red-700)', text: t('menu.retire'),
          onclick: async () => {
            if (!(await confirmSheet({ title: t('menu.retire'), message: `If ${p.name} appears in past orders it is hidden from the menu instead of deleted, so history stays intact.`, confirmLabel: t('common.delete'), danger: true }))) return;
            try {
              const res = await api.del(`/api/admin/products/${p.id}`);
              handle.close();
              toast(res.message, { kind: 'ok' });
              load();
            } catch (err) {
              toast(err.message, { kind: 'bad' });
            }
          },
        })
        : null),
    });
  };

  const needUnlock = () => {
    toast(t('menu.need_unlock'), {
      kind: 'warn',
      action: { label: t('owner.unlock'), run: () => elevate(() => load(), state.owner.session) },
    });
  };

  search.input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; filter.search = ''; load(); } });
  paint();
  await load();
  onRefresh(() => paint());
}

function stockPillFor(p) {
  const kind = p.stock_status === 'out_of_stock' ? 'out' : p.stock_status === 'low_stock' ? 'low' : 'ok';
  return pill(p.stock_qty === null ? t('menu.on_call') : `${p.stock_qty ?? 0} ${p.unit}`, kind);
}

function flattenCategories(list, depth = 0, out = []) {
  for (const c of list) {
    out.push({ id: c.id, label: `${depth ? '└ ' : ''}${c.name}` });
    if (c.children?.length) flattenCategories(c.children, depth + 1, out);
  }
  return out;
}

/* --------------------------------------------------------------- approvals --- */
export async function approvalsView(root, { onRefresh }) {
  let tab = 'pending_verification';
  let accounts = [];
  let pendingCount = 0;

  const { body } = await adminShell(root, t('owner.approvals'), {
    reload: () => load(),
    children: [h('div', { class: 'sk', style: 'height:220px' })],
  });

  const load = async () => {
    try {
      const res = await api.get(`/api/owner/wholesale${qs({ status: tab })}`);
      accounts = res.accounts;
      pendingCount = res.pending_count;
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const paint = () => {
    mount(body,
      chipRow([
        { value: 'pending_verification', label: `${t('appr.pending')}${pendingCount ? ` (${pendingCount})` : ''}` },
        { value: 'active', label: t('appr.approved') },
        { value: 'suspended', label: t('appr.suspended') },
        { value: 'rejected', label: t('appr.rejected') },
        { value: 'all', label: t('common.all') },
      ], tab, (v) => { tab = v; load(); }),
      !canEdit() ? notice('warn', t('appr.locked_note'), h('button', { class: 'linklike', text: t('owner.unlock'), onclick: () => elevate(() => load(), state.owner.session) })) : null,
      accounts.length
        ? h('div', { class: 'stack' }, ...accounts.map(accountCard))
        : emptyState('building', t('appr.none'), 'Wholesale signups land here for a GST check before prices switch over.'));
  };

  const accountCard = (a) => {
    const head = h('div', { style: 'flex:1;min-width:0' },
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        h('strong', { style: 'font-size:15px', text: a.business_name || a.full_name }),
        apprPill(a.status)),
      h('div', { class: 'tiny muted', text: `${a.full_name} · +91 ${a.mobile} · ${a.business_type || 'business'}` }),
      h('div', { class: 'mono tiny', style: 'margin-top:2px', text: a.gst_number ? `GSTIN ${a.gst_number}` : t('appr.no_gst') }));

    const totals = h('div', { style: 'text-align:right' },
      h('div', { class: 'small strong', text: money2(a.lifetime_value) }),
      h('div', { class: 'tiny muted', text: plural(Number(a.orders_count), 'order', 'orders') }));

    const buttons = h('span', { class: 'row', style: 'gap:6px' });
    if (a.status === 'pending_verification') {
      buttons.append(h('button', { class: 'btn sm', text: t('appr.reject'), onclick: () => act(a, 'reject') }));
    }
    if (['pending_verification', 'rejected'].includes(a.status)) {
      buttons.append(h('button', { class: 'btn sm', style: 'background:var(--green-600)', text: t('appr.approve'), onclick: () => act(a, 'approve') }));
    }
    if (a.status === 'active') {
      buttons.append(h('button', { class: 'btn sm secondary', text: t('appr.suspend'), onclick: () => act(a, 'suspend') }));
    }
    if (['suspended', 'rejected'].includes(a.status)) {
      buttons.append(h('button', { class: 'btn sm secondary', text: t('appr.reinstate'), onclick: () => act(a, 'reinstate') }));
    }

    const meta = h('span', { class: 'tiny muted', text: `${t('appr.applied')} ${shortDate(a.created_at)}${a.approved_at ? ` · ${t('appr.approved')} ${shortDate(a.approved_at)}` : ''}${a.addresses ? ` · ${plural(Number(a.addresses), 'address', 'addresses')}` : ''}` });

    const card = h('div', { class: 'card pad' },
      h('div', { class: 'row', style: 'gap:10px;align-items:flex-start' },
        h('div', { style: 'width:44px;height:44px;border-radius:13px;background:var(--green-50);color:var(--green-700);display:grid;place-items:center;font-weight:800;flex:0 0 auto' }, a.initials || initials(a.business_name || a.full_name)),
        head,
        totals),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px;gap:10px;flex-wrap:wrap' }, meta, buttons));
    if (a.rejected_reason) {
      card.append(h('div', { class: 'demo-note', style: 'margin-top:8px', text: `${t('appr.reason')}: ${a.rejected_reason}` }));
    }
    return card;
  };

  const act = async (a, action) => {
    if (!canEdit()) return needUnlockAdmin(() => load());
    let reason = '';
    const run = async () => {
      try {
        const res = await api.post(`/api/owner/wholesale/${a.id}`, { action, reason: reason || null });
        toast(res.message, { kind: action === 'reject' || action === 'suspend' ? 'warn' : 'ok' });
        handle?.close?.();
        load();
      } catch (err) {
        toast(err.message, { kind: 'bad' });
      }
    };
    let handle = null;
    if (action === 'reject' || action === 'suspend') {
      const input = h('textarea', { class: 'input', rows: 2, placeholder: action === 'reject' ? 'GST number did not match the shop board' : 'Paused until stock is confirmed' });
      handle = sheet({
        title: `${action === 'reject' ? t('appr.reject') : t('appr.suspend')} · ${a.business_name || a.full_name}`,
        body: h('div', { class: 'stack' },
          h('p', { class: 'small muted', text: 'The customer gets this as an SMS/WhatsApp message, in their language.' }),
          input,
          h('button', { class: 'btn block', style: action === 'reject' ? 'background:var(--red-600)' : '', text: t('common.confirm'), onclick: () => { reason = input.value.trim(); run(); } })),
      });
      return;
    }
    if (!(await confirmSheet({ title: action === 'approve' ? t('appr.approve') : t('appr.reinstate'), message: `${a.business_name || a.full_name} — wholesale prices and slabs go live for this account immediately.`, confirmLabel: t('common.confirm') }))) return;
    await run();
  };

  paint();
  await load();
  onRefresh(() => paint());
}

const APPR = {
  pending_verification: ['appr.pending', 'low'],
  active: ['appr.approved', 'ok'],
  rejected: ['appr.rejected', 'out'],
  suspended: ['appr.suspended', 'out'],
};
const apprPill = (status) => {
  const [key, kind] = APPR[status] || [null, 'grey'];
  return key ? pill(t(key), kind) : pill(status, 'grey');
};

function needUnlockAdmin(reload) {
  toast(t('menu.need_unlock'), { kind: 'warn', action: { label: t('owner.unlock'), run: () => elevate(reload, state.owner.session) } });
}

/* ---------------------------------------------------------------- payments --- */
export async function paymentsView(root, { onRefresh }) {
  let data = { pending: [], recent_events: [], online_today: 0 };
  const { body } = await adminShell(root, t('owner.payments'), {
    reload: () => load(),
    children: [h('div', { class: 'sk', style: 'height:220px' })],
  });

  const load = async () => {
    try {
      data = await api.get('/api/owner/payments');
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const paint = () => {
    mount(body,
      h('div', { class: 'kpis' },
        kpiCard({ label: t('pay.awaiting'), value: data.pending.length, kind: 'count', accent: true, hint: t('pay.awaiting_hint') }),
        kpiCard({ label: t('pay.online_today'), value: data.online_today, kind: 'money', hint: t('pay.verified') })),
      notice('info', data.bank_hint),
      data.pending.length
        ? h('div', { class: 'stack' }, ...data.pending.map(paymentRow))
        : emptyState('wallet', t('pay.none'), 'Nothing is waiting for reconciliation right now.'),
      data.recent_events?.length
        ? section(t('pay.events'), h('span', { class: 'tiny muted', text: t('pay.events_hint') }),
          h('div', { class: 'card', style: 'overflow:hidden' },
            ...data.recent_events.slice(0, 14).map((e, i) => h('div', { class: 'listrow', style: i === 0 ? 'border-top:0' : '' },
              h('span', { class: 'ico', style: `color:${e.action.includes('paid') ? 'var(--green-700)' : e.action.includes('fail') ? 'var(--red-700)' : 'var(--ink-2)'}`, html: icons[e.action.includes('paid') ? 'check' : e.action.includes('fail') ? 'close' : 'receipt'] }),
              h('div', { style: 'flex:1' },
                h('div', { class: 'row', style: 'gap:6px' }, h('strong', { style: 'font-size:13px;font-family:var(--mono)', text: e.public_id }), pill(e.action.replace(/_/g, ' '), e.action.includes('paid') ? 'ok' : 'grey')),
                h('div', { class: 'tiny muted', text: `${e.actor}${e.ref ? ` · ${e.ref}` : ''}${e.note ? ` · ${e.note}` : ''}` }),
              h('span', { class: 'tiny muted', style: 'white-space:nowrap', text: `${money2(e.amount)} · ${timeAgo(e.created_at)}` }))))))
        : null);
  };

  const paymentRow = (o) => h('div', { class: 'card pad' },
    h('div', { class: 'row', style: 'justify-content:space-between;gap:8px' },
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { class: 'row', style: 'gap:6px' },
          h('strong', { style: 'font-family:var(--mono)', text: o.public_id }),
          o.upi_ref ? pill(`REF ${o.upi_ref}`, 'info') : pill(t('pay.no_ref'), 'low'),
          o.payment_status === 'failed' ? pill(t('pay.failed'), 'out') : null),
        h('div', { class: 'small muted', style: 'margin-top:2px', text: `${o.customer || '—'} · +91 ${o.mobile || ''}` }),
        h('div', { class: 'tiny muted', text: `${t('pay.placed')} ${dateTime(o.placed_at)} · ${t(`order.status.${o.status}`)}` })),
      h('div', { style: 'text-align:right' }, h('div', { class: 'price', text: money2(o.total) }))),
    h('div', { class: 'row', style: 'gap:6px;margin-top:8px;flex-wrap:wrap' },
      h('button', { class: 'btn sm', text: t('owner.mark_paid'), onclick: () => mark(o, 'mark_paid') }),
      h('button', { class: 'btn sm secondary', text: t('pay.mark_failed'), onclick: () => mark(o, 'mark_failed') }),
      o.payment_status === 'paid' ? h('button', { class: 'btn sm ghost', text: t('pay.refund'), onclick: () => mark(o, 'refund') }) : null,
      h('button', { class: 'btn sm ghost', text: t('pay.call'), onclick: () => { window.location.href = `tel:${o.mobile}`; } })));

  const mark = async (o, action) => {
    const ref = h('input', { class: 'input mono', inputmode: 'numeric', maxlength: 18, placeholder: action === 'mark_paid' ? 'UTR from the bank statement' : 'note (optional)' });
    const note = h('input', { class: 'input', maxlength: 120, placeholder: action === 'mark_failed' ? 'Amount not received / name mismatch' : 'Optional note' });
    const handle = sheet({
      title: `${action === 'mark_paid' ? t('owner.confirm_paid') : action === 'refund' ? t('pay.refund') : t('pay.mark_failed')} · ${o.public_id}`,
      body: h('div', { class: 'stack' },
        h('p', { class: 'small muted', text: `${o.customer} · ${money2(o.total)} · ${t('pay.record_note')}` }),
        h('div', { class: 'field' }, h('label', { text: t('pay.reference') }), ref),
        h('div', { class: 'field' }, h('label', { text: t('common.note') }), note),
        h('button', {
          class: 'btn block', text: t('common.confirm'),
          onclick: async () => {
            try {
              const res = await api.post(`/api/owner/payments/${o.id}`, { action, ref: ref.value.trim(), note: note.value.trim() });
              handle.close();
              toast(res.message, { kind: 'ok' });
              load();
            } catch (err) {
              toast(err.message, { kind: 'bad' });
            }
          },
        })),
    });
  };

  paint();
  await load();
  onRefresh(() => paint());
}

/* ------------------------------------------------------------------ scratch --- */
export async function scratchView(root, { onRefresh }) {
  let tab = 'active';
  let data = { active: [], delivered: [], voided: [] };
  const { body } = await adminShell(root, t('owner.scratch'), {
    reload: () => load(),
    children: [h('div', { class: 'sk', style: 'height:220px' })],
  });

  const load = async () => {
    try {
      data = await api.get('/api/owner/scratch');
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const paint = () => {
    const rows = data[tab] || [];
    mount(body,
      notice('info', t('scratch.note')),
      chipRow([
        { value: 'active', label: `${t('scratch.active')} (${data.active.length})` },
        { value: 'delivered', label: `${t('scratch.done')} (${data.delivered.length})` },
        { value: 'voided', label: `${t('scratch.voided')} (${data.voided.length})` },
      ], tab, (v) => { tab = v; paint(); }),
      rows.length
        ? h('div', { class: 'stack' }, ...rows.map((o) => h('div', { class: 'order-card' },
          h('div', { class: 'row', style: 'justify-content:space-between;gap:8px' },
            h('div', { style: 'flex:1' },
              h('div', { class: 'row', style: 'gap:6px' }, h('strong', { style: 'font-family:var(--mono)', text: o.public_id }), o.status ? statusChip(o.status) : null, o.voided ? pill(t('scratch.voided_tag'), 'out') : null),
              h('div', { class: 'small muted', style: 'margin-top:2px', text: `${(o.customer && o.customer.name) || o.customer_name || 'Walk-in'} · ${o.placed_at ? timeAgo(o.placed_at) : ''}` }),
              o.items_summary ? h('div', { class: 'tiny', style: 'margin-top:2px;color:var(--ink-2)', text: o.items_summary }) : null,
              o.void_reason ? h('div', { class: 'tiny', style: 'margin-top:4px;color:var(--red-700)', text: `${t('owner.void')}: ${o.void_reason}${o.voided_by ? ` · ${o.voided_by}` : ''}` }) : null),
            h('div', { style: 'text-align:right' },
              h('div', { class: 'strong', text: money2(o.total) }),
              h('div', { class: 'tiny muted', text: o.payment_method === 'cod' ? t('checkout.cod') : 'UPI' }))),
          tab === 'voided' ? null : h('div', { class: 'ops' },
            o.can_move_forward ? h('button', { class: 'btn sm', text: t('owner.mark', { status: t(`order.status.${o.next_status}`) }), onclick: () => advance(o, o.next_status) }) : null,
            h('button', { class: 'btn sm ghost', style: 'color:var(--red-700)', text: t('owner.void'), onclick: () => voidSheet(o) })))))
        : emptyState('trash', t('scratch.empty'), 'Voided orders keep an audit trail here — stock and totals are corrected automatically.'));
  };

  const advance = async (o, status) => {
    try {
      const res = await api.post(`/api/owner/orders/${o.id}/status`, { status });
      toast(res.message, { kind: 'ok' });
      load();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const voidSheet = (o) => {
    const input = h('textarea', { class: 'input', rows: 2, placeholder: 'e.g. customer called off, item unavailable' });
    const notify = h('input', { type: 'checkbox', class: 'check', checked: true });
    const handle = sheet({
      title: `${t('scratch.void_title')} · ${o.public_id}`,
      body: h('div', { class: 'stack' },
        h('p', { class: 'small muted', text: 'Stock goes back and shift totals drop this order. The audit log keeps who voided it and why.' }),
        input,
        h('label', { class: 'row', style: 'gap:8px' }, notify, h('span', { class: 'small', text: t('scratch.notify') })),
        h('button', {
          class: 'btn block', style: 'background:var(--red-600)', text: t('owner.void_confirm'),
          onclick: async () => {
            const reason = input.value.trim();
            if (reason.length < 3) return toast(t('scratch.reason_short'), { kind: 'bad' });
            try {
              const res = await api.post(`/api/owner/scratch/${o.id}`, { reason, notify: notify.checked });
              handle.close();
              toast(res.message, { kind: 'ok' });
              load();
            } catch (err) {
              toast(err.message, { kind: 'bad' });
            }
          },
        })),
    });
  };

  paint();
  await load();
  onRefresh(() => paint());
}

/* ------------------------------------------------------------------ history --- */
export async function historyView(root, { onRefresh }) {
  const f = { from: '', to: '', q: '', status: 'all' };
  let data = null;
  const { body } = await adminShell(root, t('owner.history'), {
    reload: () => load(),
    children: [h('div', { class: 'sk', style: 'height:220px' })],
  });

  const load = async () => {
    try {
      data = await api.get(`/api/owner/history${qs({ ...f, status: f.status === 'all' ? '' : f.status, limit: 120 })}`);
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const search = searchField(t('hist.search'), debounce((v) => { f.q = v; load(); }, 340), '');

  const paint = () => {
    if (!data) return;
    const sales = data.sales || {};
    const rows = [...(data.orders || []), ...(data.voided || []).map((o) => ({ ...o, voided: true }))].sort((a, b) => b.id - a.id);
    mount(body,
      h('div', { class: 'kpis' },
        kpiCard({ label: t('hist.today'), value: sales.today?.revenue || 0, kind: 'money', accent: true, hint: plural(sales.today?.orders || 0, 'order', 'orders') }),
        kpiCard({ label: t('hist.week'), value: sales.week?.revenue || 0, kind: 'money', hint: `${sales.week?.customers || 0} ${t('hist.customers')}` }),
        kpiCard({ label: t('hist.month'), value: sales.month?.revenue || 0, kind: 'money', hint: `${t('hist.aov')} ${money(sales.month?.average_order_value || 0)}` }),
        kpiCard({ label: t('hist.saved'), value: sales.month?.customer_savings || 0, kind: 'money', hint: t('hist.saved_hint') })),
      h('div', { class: 'card pad' },
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
          h('div', { class: 'searchbar', style: 'flex:1;min-width:180px' }, h('span', { html: icons.search }), search.input),
          h('input', { class: 'input mono', type: 'date', style: 'flex:0 0 auto;width:150px', value: f.from, 'aria-label': 'From', onchange: (e) => { f.from = e.target.value; load(); } }),
          h('input', { class: 'input mono', type: 'date', style: 'flex:0 0 auto;width:150px', value: f.to, 'aria-label': 'To', onchange: (e) => { f.to = e.target.value; load(); } })),
        chipRow([
          { value: 'all', label: t('common.all') },
          { value: 'placed', label: t('order.status.placed') },
          { value: 'confirmed', label: t('order.status.confirmed') },
          { value: 'preparing', label: t('order.status.preparing') },
          { value: 'out_for_delivery', label: t('order.status.out_for_delivery') },
          { value: 'delivered', label: t('order.status.delivered') },
          { value: 'cancelled', label: t('order.status.cancelled') },
        ], f.status, (v) => { f.status = v; load(); })),
      rows.length
        ? h('div', { class: 'card', style: 'overflow:hidden' },
          ...rows.slice(0, 60).map((o, i) => h('div', { class: 'listrow', style: i === 0 ? 'border-top:0' : '' },
            h('div', { style: 'flex:1' },
              h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
                h('strong', { style: 'font-family:var(--mono);font-size:13px', text: o.public_id }),
                o.voided ? pill(t('scratch.voided_tag'), 'out') : statusChip(o.status),
                o.account_type === 'wholesale' ? pill('WS', 'info') : null),
              h('div', { class: 'tiny muted', style: 'margin-top:2px', text: `${(o.customer && o.customer.name) || o.customer_name || 'Walk-in'} · ${shortDate(o.placed_at)} · ${money2(o.subtotal)} subtotal · ${money2(o.discount)} saved` })),
            h('div', { style: 'text-align:right' },
              h('div', { class: 'small strong', text: money2(o.total) }),
              h('div', { class: 'tiny muted', text: `${t('hist.payment')}: ${o.payment_status.replace(/_/g, ' ')}` })),
            h('button', { class: 'btn sm ghost', text: t('common.view'), onclick: () => openInvoice(o) }))))
        : emptyState('history', t('hist.none'), 'Try a wider date range.'),
      data.shifts?.length
        ? section(t('owner.shifts'), h('span', { class: 'tiny muted', text: t('hist.shifts_hint') }),
          h('div', { class: 'card', style: 'overflow:hidden' },
            ...data.shifts.slice(0, 8).map((sh, i) => h('div', { class: 'listrow', style: i === 0 ? 'border-top:0' : '' },
              h('span', { class: 'ico', html: icons.clock }),
              h('div', { style: 'flex:1' },
                h('strong', { style: 'font-size:13px', text: `Shift #${sh.id} · ${sh.opened_by}` }),
                h('div', { class: 'tiny muted', text: `${dateTime(sh.opened_at)} → ${sh.closed_at ? dateTime(sh.closed_at) : t('hist.open_now')}` })),
              h('div', { style: 'text-align:right' },
                h('div', { class: 'small strong', text: money2(sh.summary?.grand_total || 0) }),
                h('div', { class: 'tiny muted', text: plural(sh.summary?.orders || 0, 'order', 'orders') }))))))
        : null);
  };

  const openInvoice = async (o) => {
    const handle = sheet({ title: o.public_id, body: h('div', { class: 'sk', style: 'height:160px' }) });
    let full;
    try {
      full = (await api.get(`/api/owner/orders/${o.id}`)).order;
    } catch (err) {
      mount(handle.body, notice('bad', err.message));
      return;
    }
    const meta = kv([
      [t('order.placed_on'), dateTime(full.placed_at)],
      [t('common.customer'), `${full.customer?.full_name || '\u2014'}${full.customer?.business_name ? ` \u00b7 ${full.customer.business_name}` : ''}`],
      [t('common.mobile'), full.customer?.mobile || '\u2014'],
      [t('order.payment'), `${String(full.payment_method).toUpperCase()} \u00b7 ${full.payment_status.replace(/_/g, ' ')}${full.upi_ref ? ` \u00b7 ${full.upi_ref}` : ''}`],
      [t('hist.scope'), full.price_scope_label || full.account_type],
    ]);
    const lines = full.items.map((it) => h('div', { class: 'item-row' },
      h('span', { style: 'flex:1', text: `${it.name}${it.pack_size ? ` \u00b7 ${it.pack_size}` : ''}` }),
      h('span', { class: 'tiny muted', text: `\u00d7${it.qty} @ ${money2(it.unit_price)}` }),
      h('span', { class: 'strong', style: 'min-width:70px;text-align:right', text: money2(it.line_total) })));
    lines.push(h('div', { class: 'item-row', style: 'background:var(--green-50)' },
      h('span', { class: 'strong', style: 'flex:1', text: t('common.total') }),
      h('span', { class: 'price', text: money2(full.total) })));
    const itemsCard = h('div', { class: 'card', style: 'overflow:hidden' }, ...lines);
    const foot = h('div', { class: 'row', style: 'gap:8px' },
      h('button', { class: 'btn secondary', style: 'flex:1', text: t('hist.print'), onclick: () => window.print() }),
      full.maps_url ? h('a', { class: 'btn ghost', style: 'flex:1', href: full.maps_url, target: '_blank', rel: 'noopener', text: t('owner.navigate') }) : null);
    mount(handle.body, h('div', { class: 'stack' }, meta, itemsCard, foot));
  };

  paint();
  await load();
  onRefresh(() => paint());
}

/* ----------------------------------------------------------------- messages --- */
export async function messagesView(root, { onRefresh }) {
  let data = { messages: [] };
  const { body } = await adminShell(root, t('owner.messages'), {
    reload: () => load(),
    children: [h('div', { class: 'sk', style: 'height:220px' })],
  });

  const load = async () => {
    try {
      data = await api.get('/api/owner/notifications?limit=80');
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const paint = () => {
    const counts = data.messages.reduce((acc, m) => ({ ...acc, [m.status]: (acc[m.status] || 0) + 1 }), {});
    mount(body,
      h('div', { class: 'kpis' },
        kpiCard({ label: t('msg.sent'), value: counts.sent || 0, kind: 'count', accent: true, hint: t('msg.sent_hint') }),
        kpiCard({ label: t('msg.queued'), value: counts.queued || 0, kind: 'count', hint: t('msg.queued_hint') }),
        kpiCard({ label: t('msg.failed'), value: counts.failed || 0, kind: 'count', hint: t('msg.failed_hint') })),
      notice('info', data.hint),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        pill(`provider: ${data.provider}`, 'grey'),
        pill(t('msg.languages'), 'info')),
      data.messages.length
        ? h('div', { class: 'card', style: 'overflow:hidden' },
          ...data.messages.map((m, i) => h('div', { class: 'listrow', style: i === 0 ? 'border-top:0' : '' },
            h('span', { class: 'ico', html: m.channel === 'whatsapp' ? icons.whatsapp : icons.chat }),
            h('div', { style: 'flex:1;min-width:0' },
              h('div', { class: 'row', style: 'gap:6px' },
                h('strong', { style: 'font-size:13px', text: `+91 ${m.to_number}` }),
                pill(m.status, m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'out' : 'grey'),
                m.order_id ? h('button', { class: 'linklike tiny', text: `#${m.order_id}`, onclick: () => openMsg(m) }) : null),
              h('div', { class: 'small', style: 'margin-top:4px;white-space:pre-wrap;color:var(--ink-2)', text: m.body }),
              h('div', { class: 'tiny muted', style: 'margin-top:4px', text: `${m.template || ''} · ${dateTime(m.created_at)}` }))))
          )
        : emptyState('chat', t('msg.none'), 'Order, approval and payment messages appear here as soon as anything is sent.'));
  };

  const openMsg = (m) => sheet({
    title: `${m.channel.toUpperCase()} → +91 ${m.to_number}`,
    body: h('div', { class: 'stack' },
      h('div', { class: 'card pad' }, h('div', { class: 'small', style: 'white-space:pre-wrap', text: m.body })),
      kv([[t('common.status'), m.status], ['Template', m.template || '—'], [t('common.sent'), dateTime(m.created_at)], [m.error ? 'Error' : null, m.error || null]])),
  });

  paint();
  await load();
  onRefresh(() => paint());
}

/* ------------------------------------------------------------------ settings --- */
export async function settingsView(root, { onRefresh }) {
  let data = { settings: {}, staff: [] };
  let auditEntries = [];
  const { body } = await adminShell(root, t('owner.settings'), {
    reload: () => load(),
    children: [h('div', { class: 'sk', style: 'height:220px' })],
  });

  const load = async () => {
    try {
      data = await api.get('/api/owner/settings');
      try {
        auditEntries = (await api.get('/api/owner/audit?limit=25')).entries;
      } catch { auditEntries = []; }
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const paint = () => {
    const s = data.settings;
    const form = buildForm([
      { name: 'section_store', type: 'section', label: t('set.store') },
      { name: 'store_name', label: t('set.name'), required: true, maxlength: 60, value: s.store_name || '' },
      { name: 'store_tagline', label: t('set.tagline'), maxlength: 120, value: s.store_tagline || '' },
      { name: 'store_phone', label: t('set.phone'), maxlength: 20, value: s.store_phone || '' },
      { name: 'store_address', label: t('set.address'), type: 'textarea', rows: 2, maxlength: 200, value: s.store_address || '' },
      { name: 'store_hours', label: t('set.hours'), maxlength: 120, value: s.store_hours || '' },
      { name: 'google_maps_query', label: t('set.maps'), maxlength: 160, value: s.google_maps_query || '' },
      { name: 'section_pay', type: 'section', label: t('set.payments') },
      { name: 'upi_id', label: t('set.upi'), required: true, maxlength: 60, value: s.upi_id || '' },
      { name: 'upi_display_name', label: t('set.upi_name'), maxlength: 60, value: s.upi_display_name || '' },
      { name: 'cod_enabled', label: t('set.cod'), type: 'checkbox', value: String(s.cod_enabled) === '1' },
      { name: 'section_terms', type: 'section', label: t('set.terms') },
      { name: 'delivery_charge', label: t('set.delivery'), type: 'number', step: '0.01', value: s.delivery_charge ?? '0' },
      { name: 'free_delivery_above', label: t('set.free_above'), type: 'number', step: '0.01', value: s.free_delivery_above ?? '0' },
      { name: 'min_order_retail', label: t('set.min_retail'), type: 'number', value: s.min_order_retail ?? '0' },
      { name: 'min_order_wholesale', label: t('set.min_wholesale'), type: 'number', value: s.min_order_wholesale ?? '0' },
      { name: 'eta_minutes', label: t('set.eta'), type: 'number', min: 10, value: s.eta_minutes ?? '90' },
      { name: 'low_stock_threshold', label: t('set.low_alert'), type: 'number', min: 0, value: s.low_stock_threshold ?? '5' },
      { name: 'wholesale_requires_approval', label: t('set.approval'), type: 'checkbox', value: String(s.wholesale_requires_approval) === '1' },
      { name: 'shop_open', label: t('set.shop_open'), type: 'checkbox', value: String(s.shop_open) !== '0' },
    ], {
      submitLabel: t('common.save'),
      buttonsBefore: null,
      onSubmit: async (values, { setError }) => {
        if (!canEdit()) return needUnlockAdmin(() => load());
        try {
          const res = await api.put('/api/owner/settings', values);
          toast(res.message, { kind: 'ok' });
          set({ settings: { ...(state.settings || {}), ...res.settings, shop_open: String(res.settings?.shop_open) !== '0' } });
          load();
        } catch (err) {
          setError(err.fields ? Object.keys(err.fields)[0] : 'store_name', err.message);
        }
      },
    });

    mount(body,
      elevateBar({
        level: state.owner.level,
        minutesLeft: (state.owner.session || {}).minutes_left || 0,
        onElevate: () => elevate(() => load(), state.owner.session),
        onLock: () => lockNow(() => load()),
        note: canEdit() ? t('set.elevated_note') : t('set.locked_note'),
      }),
      h('div', { class: 'grid2', style: 'align-items:start' },
        h('div', { class: 'card pad' }, form.el),
        h('div', { class: 'stack' },
          h('div', { class: 'card pad' },
            h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' },
              h('strong', { text: t('set.staff') }),
              h('span', { class: 'tiny muted', text: t('set.staff_hint') })),
            ...data.staff.map((st) => h('div', { class: 'listrow', style: 'padding:8px 0;border-top:1px solid var(--line)' },
              h('span', { class: 'ico', style: 'width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--green-50);color:var(--green-700);font-weight:800;font-size:12px' }, initials(st.name)),
              h('div', { style: 'flex:1' },
                h('strong', { style: 'font-size:13px', text: st.name }),
                h('div', { class: 'tiny muted', text: `${st.designation} · @${st.username} · ${st.role}` })),
              st.is_active ? pill(t('set.active'), 'ok') : pill(t('set.inactive'), 'grey'),
              st.last_pin_login_at ? h('span', { class: 'tiny muted', text: timeAgo(st.last_pin_login_at) }) : null))),
          h('div', { class: 'card pad' },
            h('strong', { text: t('set.pin') }),
            h('p', { class: 'tiny muted', style: 'margin:4px 0 8px', text: t('set.pin_hint') }),
            h('button', { class: 'btn sm secondary', text: t('set.change_pin'), onclick: changePin })),
          h('div', { class: 'card pad' },
            h('strong', { text: t('set.export') }),
            h('p', { class: 'tiny muted', style: 'margin:4px 0 8px', text: t('set.export_hint') }),
            h('button', { class: 'btn sm secondary', text: t('set.download'), onclick: downloadExport }))),
      ),
      section(t('set.audit'), h('span', { class: 'tiny muted', text: t('set.audit_hint') }),
        auditEntries.length
          ? h('div', { class: 'card', style: 'overflow:hidden;max-height:340px;overflow:auto' },
            ...auditEntries.map((e, i) => h('div', { class: 'listrow', style: `padding:7px 12px;${i === 0 ? 'border-top:0' : ''}` },
              h('span', { class: 'tiny mono muted', style: 'min-width:112px', text: dateTime(e.created_at) }),
              h('span', { style: 'flex:1' }, h('strong', { style: 'font-size:12px;font-family:var(--mono)', text: e.action }), h('span', { class: 'tiny muted', text: e.detail ? ` · ${e.detail}` : '' })),
              h('span', { class: 'tiny muted', text: e.actor_label || e.actor_type }))))
          : notice('info', t('set.no_audit'))));
  };

  const changePin = () => {
    const form = buildForm([
      { name: 'pin', label: t('owner.pin'), inputmode: 'numeric', maxlength: 6, required: true, hint: t('set.pin_rule') },
      { name: 'confirm_pin', label: t('auth.confirm'), inputmode: 'numeric', maxlength: 6, required: true },
      { name: 'password', label: t('owner.password'), type: 'password', required: true, hint: t('owner.elevate_hint') },
    ], {
      submitLabel: t('set.change_pin'),
      onSubmit: async (values, { setError }) => {
        if (values.pin !== values.confirm_pin) return setError('confirm_pin', 'The two PINs do not match.');
        try {
          const res = await api.post('/api/owner/pin', { pin: values.pin, password: values.password });
          handle.close();
          toast(res.message, { kind: 'ok' });
        } catch (err) {
          setError(err.fields ? Object.keys(err.fields)[0] : 'password', err.message);
        }
      },
    });
    const handle = sheet({ title: t('set.change_pin'), body: form.el });
  };

  const downloadExport = async () => {
    if (!canEdit()) return needUnlockAdmin(() => load());
    try {
      const res = await api.get('/api/admin/export');
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `sathvika-catalogue-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(t('set.exported'), { kind: 'ok' });
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  paint();
  await load();
  onRefresh(() => paint());
}
