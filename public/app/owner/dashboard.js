/** Counter PIN gate and the shift dashboard. */
import { h, mount } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { state, set, hydrateOwner } from '../core/store.js';
import { api, inFrame } from '../core/api.js';
import { page, sheet, toast, pill, notice, kpiCard, statusChip, emptyState, section, confirmSheet, stepper } from '../core/components.js';
import { money, money2, timeAgo, shortDate, dateTime } from '../core/format.js';
import { go } from '../core/router.js';
import { storageAvailable } from '../core/storage.js';
import { ownerShell, elevateBar, elevate, lockNow, closeShift } from './shared.js';

export function docTitle() {
  return t('owner.pin_title');
}

/* ------------------------------------------------------------------ PIN gate -- */
export function pinView(root) {
  let pin = '';
  let busy = false;
  const dots = h('div', { class: 'pins' });
  const error = h('div', { class: 'small', style: 'min-height:20px;text-align:center;color:#ff9d94' });
  const keys = h('div', { class: 'keys' });
  const wrap = h('div', { class: 'keypad-wrap' });

  const paintDots = () => {
    mount(dots, ...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('i', { class: i < pin.length ? 'on' : '' })));
  };

  // A keypad that submits on its own must also *stop* submitting: without the cancel, a 6-digit
  // PIN fires a login at digit four, fails, and burns the counter's rate budget for nothing.
  let autoTimer = null;
  const cancelAuto = () => {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
  };
  const setBusy = (on) => {
    busy = on;
    keys.classList.toggle('busy', on);
    demoBtn.disabled = on;
  };

  const submit = async () => {
    if (busy || pin.length < 4) return;
    cancelAuto();
    setBusy(true);
    error.textContent = '';
    try {
      const res = await api.post('/api/owner/login', { pin });
      set({ owner: { ...state.owner, signedIn: true, level: res.level, staff: res.staff, shift: res.shift, dashboard: res.dashboard } });
      toast(res.message, { kind: 'ok' });
      go('/owner/dashboard');
    } catch (err) {
      error.textContent = err.message;
      wrap.classList.remove('shake');
      void wrap.offsetWidth;
      wrap.classList.add('shake');
      pin = '';
      paintDots();
    } finally {
      setBusy(false);
    }
  };

  const press = (d) => {
    if (busy || pin.length >= 6) return;
    cancelAuto();
    pin += d;
    paintDots();
    if (navigator.vibrate) navigator.vibrate(8);
    if (pin.length >= 4) autoTimer = setTimeout(submit, 320);
  };

  const demoBtn = h('button', {
    class: 'chip',
    type: 'button',
    text: 'Demo PIN 4321',
    onclick: () => {
      if (busy) return;
      cancelAuto();
      pin = '4321';
      paintDots();
      submit();
    },
  });

  mount(keys,
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h('button', { class: 'key', type: 'button', onclick: () => press(String(n)) }, h('span', { text: String(n) }))),
    h('button', { class: 'key fn', type: 'button', 'aria-label': t('common.clear'), onclick: () => { cancelAuto(); pin = ''; paintDots(); }, html: icons.backspace }),
    h('button', { class: 'key', type: 'button', onclick: () => press('0') }, h('span', { text: '0' })),
    h('button', { class: 'key go', type: 'button', 'aria-label': t('auth.signin'), onclick: () => { cancelAuto(); submit(); }, html: icons.enter }));

  document.addEventListener('keydown', onKey);
  function onKey(e) {
    if (e.key >= '0' && e.key <= '9') press(e.key);
    else if (e.key === 'Backspace') {
      if (busy) return;
      cancelAuto();
      pin = pin.slice(0, -1);
      paintDots();
    } else if (e.key === 'Enter') {
      cancelAuto();
      submit();
    } else if (e.key === 'Escape') go('/');
  }

  paintDots();
  mount(root, wrap,
    h('div', { class: 'keypad-card' },
      h('div', { class: 'center', style: 'margin-bottom:6px' },
        h('img', { class: 'brandmark', src: '/img/logo.svg', alt: '', width: 54, height: 54, style: 'margin-bottom:8px' }),
        h('h1', { style: 'font-size:20px', text: t('owner.pin_title') }),
        h('p', { class: 'small muted', text: t('owner.pin_sub') })),
      dots,
      error,
      keys,
      h('div', { class: 'row', style: 'justify-content:center;gap:10px;margin-top:14px' },
        h('a', { class: 'chip', href: '/', 'data-link': '' }, h('span', { style: 'width:15px', html: icons.chevL }), t('owner.back_to_store')),
        demoBtn,
        // Counter tablets live inside kiosks and previews; the one thing that must always be
        // reachable is a way to leave the frame, because that is where sessions get dropped.
        inFrame ? h('a', { class: 'chip', href: location.href, target: '_blank', rel: 'noopener' }, t('common.open_new_tab')) : null),
      !storageAvailable()
        ? h('div', { class: 'notice warn', style: 'margin-top:12px', text: t('auth.storage_blocked') })
        : null,
      h('p', { class: 'tiny muted center', style: 'margin-top:10px', text: t('owner.pin_hint') })));

  return () => {
    document.removeEventListener('keydown', onKey);
    cancelAuto();
  };
}

/* --------------------------------------------------------------- dashboard ----- */
export async function dashboardView(root, { onRefresh }) {
  const body = h('div', { class: 'stack' });
  let model = null;

  const reload = () => load().catch(() => {});

  const load = async () => {
    try {
      model = await api.get('/api/owner/dashboard');
      set({ owner: { ...state.owner, dashboard: model } });
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const paint = () => {
    if (!model) return;
    const s = model.summary || {};
    const session = state.owner.session || {};
    const minutesLeft = session.minutes_left || 0;
    mount(body,
      h('div', { class: 'kpis' }, ...(model.cards || []).map((c) => kpiCard({ label: c.label, value: c.value, hint: c.hint, kind: c.kind, accent: c.key === 'grand_total' }))),
      elevateBar({
        level: state.owner.level,
        minutesLeft,
        onElevate: () => elevate(reload, session),
        onLock: () => lockNow(reload),
        note: state.owner.level === 'admin' ? `${t('owner.staff')}: ${state.owner.staff?.name || ''} · unlocked for ${minutesLeft} min` : `${t('owner.staff')}: ${state.owner.staff?.name || ''} (${state.owner.staff?.designation || 'counter'})`,
      }),
      !model.shop_open ? notice('warn', t('owner.closed_banner')) : null,

      section(t('owner.shift'), h('button', { class: 'btn sm secondary', text: t('owner.close_shift'), onclick: () => closeShift(reload) }),
        h('div', { class: 'card pad' },
          h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap;gap:10px' },
            h('div', {},
              h('div', { class: 'tiny muted', text: `${t('owner.shift')} #${model.shift?.id ?? '—'}` }),
              h('strong', { text: model.shift?.opened_at ? `${t('owner.opened_at')} ${dateTime(model.shift.opened_at)}` : t('owner.no_shift') }),
              model.shift?.note ? h('div', { class: 'tiny muted', text: model.shift.note }) : null),
            h('div', { style: 'text-align:right' },
              h('div', { class: 'tiny muted', text: t('owner.collected') }),
              h('strong', { style: 'font-size:18px', text: money2(Number(s.online_received || 0) + Number(s.cod_received || 0)) }),
              h('div', { class: 'tiny muted', text: `${t('owner.online')} ${money(s.online_received)} · ${t('owner.cash')} ${money(s.cod_received)}` }))),
          h('div', { class: 'divider' }),
          h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
            pill(`${s.active_orders || 0} ${t('owner.active')}`, 'info'),
            s.awaiting_payment ? pill(`${s.awaiting_payment} ${t('owner.awaiting_payment')}`, 'low') : null,
            s.cod_pending ? pill(`${t('owner.cod_pending')} ${money(s.cod_pending)}`, 'grey') : null,
            model.pending_approvals ? pill(`${model.pending_approvals} ${t('owner.approvals')}`, 'low') : null,
            h('span', { class: 'spacer' }),
            h('button', { class: 'linklike tiny', text: t('owner.open_orders'), onclick: () => go('/owner/history') })))),

      section(t('owner.new_orders'), h('span', { class: 'tiny muted', text: `${(model.orders || []).length} ${t('owner.in_shift')}` }), orderList(model.orders || [])),

      model.low_stock?.length
        ? section(t('owner.low_stock'), h('a', { class: 'linklike', href: '/owner/menu?low=1', 'data-link': '', text: t('owner.restock') }),
          h('div', { class: 'card pad' },
            h('div', { class: 'chips' }, ...model.low_stock.map((p) => h('button', {
              class: 'chip', onclick: () => restock(p, reload),
            }, `${p.name} `, pill(`${p.stock_qty ?? 0}`, p.stock_status === 'out_of_stock' ? 'out' : 'low'))))))
        : null);
  };

  const orderList = (orders) => {
    if (!orders.length) return emptyState('receipt', t('owner.no_orders'), 'Online orders land here the moment a customer places one.', h('button', { class: 'btn sm secondary', text: t('common.refresh'), onclick: reload }));
    return h('div', { class: 'stack' }, ...orders.map((o) => h('div', { class: 'order-card' },
      h('div', { class: 'row', style: 'justify-content:space-between;gap:8px;cursor:pointer', onclick: () => openOrder(o) },
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { class: 'row', style: 'gap:6px' },
            h('strong', { style: 'font-family:var(--mono)', text: o.public_id }),
            statusChip(o.status),
            o.account_type === 'wholesale' ? pill('WS', 'info') : null,
            o.payment_status === 'pending' ? pill(t('owner.pay_pending'), 'low') : null),
          h('div', { class: 'small muted', style: 'margin-top:2px', text: `${o.customer?.name || 'Walk-in'} · ${timeAgo(o.placed_at)}` }),
          o.items_summary ? h('div', { class: 'tiny', style: 'margin-top:2px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: o.items_summary }) : null),
        h('div', { style: 'text-align:right' },
          h('div', { class: 'strong', text: money2(o.total) }),
          h('div', { class: 'tiny muted', text: o.payment_method === 'cod' ? t('checkout.cod') : 'UPI' }))),
      h('div', { class: 'ops' },
        o.can_move_forward
          ? h('button', { class: 'btn sm', onclick: () => advance(o, o.next_status), text: t('owner.mark', { status: t(`order.status.${o.next_status}`) }) })
          : null,
        o.status === 'placed' ? h('button', { class: 'btn sm secondary', text: t('owner.call'), onclick: () => callCustomer(o) }) : null,
        o.payment_status === 'pending' ? h('button', { class: 'btn sm secondary', text: t('owner.mark_paid'), onclick: () => markPaid(o) }) : null,
        o.maps_url ? h('a', { class: 'btn sm ghost', href: o.maps_url, target: '_blank', rel: 'noopener', text: t('owner.navigate') }) : null,
        h('button', { class: 'btn sm ghost', style: 'color:var(--red-700)', text: t('owner.void'), onclick: () => voidOrder(o) })))));
  };

  const advance = async (o, status) => {
    try {
      const res = await api.post(`/api/owner/orders/${o.id}/status`, { status });
      toast(res.message, { kind: 'ok' });
      if (res.dashboard) { model = res.dashboard; paint(); } else reload();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const markPaid = async (o) => {
    const ref = h('input', { class: 'input', placeholder: 'UTR / 12-digit ref (optional)', inputmode: 'numeric', maxlength: 18 });
    const handle = sheet({
      title: `${t('owner.mark_paid')} · ${o.public_id}`,
      body: h('div', { class: 'stack' },
        h('p', { class: 'small muted', text: `Confirm ₹${o.total} has actually landed in the store UPI account before marking this paid.` }),
        ref,
        h('button', {
          class: 'btn block', text: t('owner.confirm_paid'),
          onclick: async () => {
            try {
              const res = await api.post(`/api/owner/payments/${o.id}`, { action: 'mark_paid', ref: ref.value.trim() });
              handle.close();
              toast(res.message, { kind: 'ok' });
              if (res.dashboard) { model = res.dashboard; paint(); } else reload();
            } catch (err) {
              toast(err.message, { kind: 'bad' });
            }
          },
        })),
    });
  };

  const voidOrder = async (o) => {
    let reason = '';
    const input = h('textarea', { class: 'input', rows: 2, placeholder: 'Why is this order being voided? Stock goes back and the customer is told.' });
    const handle = sheet({
      title: `${t('owner.void')} ${o.public_id}`,
      body: h('div', { class: 'stack' },
        h('p', { class: 'small muted', text: 'Voiding removes the order from shift totals and returns stock. It stays in history for audit.' }),
        input,
        h('button', {
          class: 'btn block', style: 'background:var(--red-600)', text: t('owner.void_confirm'),
          onclick: async () => {
            reason = input.value.trim();
            if (reason.length < 3) return toast('Give a short reason so the audit trail makes sense.', { kind: 'bad' });
            try {
              const res = await api.post(`/api/owner/scratch/${o.id}`, { reason, notify: true });
              handle.close();
              toast(res.message, { kind: 'ok' });
              if (res.dashboard) { model = res.dashboard; paint(); } else reload();
            } catch (err) {
              toast(err.message, { kind: 'bad' });
            }
          },
        })),
    });
  };

  const callCustomer = (o) => {
    const mobile = o.customer?.mobile;
    if (!mobile) return toast('No phone number on this account.', { kind: 'warn' });
    window.location.href = `tel:${mobile}`;
  };

  const openOrder = async (o) => {
    const handle = sheet({
      title: `${o.public_id} · ${o.status_label || t(`order.status.${o.status}`)}`,
      body: h('div', { class: 'sk', style: 'height:200px' }),
    });
    let full;
    try {
      full = (await api.get(`/api/owner/orders/${o.id}`)).order;
    } catch (err) {
      mount(handle.body, notice('bad', err.message));
      return;
    }
    const badges = [
      statusChip(full.status),
      pill(full.price_scope_label || full.account_type, 'grey'),
      pill(full.payment_status === 'paid' ? t('owner.paid') : t('owner.pay_pending'), full.payment_status === 'paid' ? 'ok' : 'low'),
      full.voided ? pill(t('order.voided'), 'out') : null,
    ];
    const addr = full.address;
    const addrText = addr ? `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ''}${addr.area ? `, ${addr.area}` : ''} ${addr.pincode || ''}` : '—';
    const customerCard = h('div', { class: 'card pad' },
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('strong', { text: full.customer?.name || 'Walk-in' }),
        h('span', { class: 'mono small', text: full.customer?.mobile || '' })),
      h('div', { class: 'small muted', style: 'margin-top:4px', text: addrText }),
      full.instructions ? h('div', { class: 'demo-note', style: 'margin-top:6px', text: full.instructions }) : null);

    const itemRows = full.items.map((it) => h('div', { class: 'item-row' },
      h('span', { style: 'flex:1', text: `${it.name}${it.pack_size ? ` · ${it.pack_size}` : ''}` }),
      h('span', { class: 'tiny muted', text: `×${it.qty} @ ${money2(it.unit_price)}` }),
      h('span', { class: 'strong', style: 'min-width:70px;text-align:right', text: money2(it.line_total) })));
    itemRows.push(h('div', { class: 'item-row', style: 'background:var(--green-50)' },
      h('span', { class: 'strong', style: 'flex:1', text: t('common.total') }),
      h('span', { class: 'price', text: money2(full.total) })));
    const itemsCard = h('div', { class: 'card', style: 'overflow:hidden' }, ...itemRows);

    const tlRows = full.timeline || [];
    const nextUp = tlRows.findIndex((n) => !n.done);
    const currentIdx = nextUp === -1 ? tlRows.length - 1 : nextUp;
    const timelineCard = tlRows.length
      ? h('div', { class: 'card pad' },
        h('h3', { style: 'font-size:14px;margin-bottom:4px', text: t('order.timeline') }),
        h('div', { class: 'timeline' }, ...tlRows.map((n, i) => h('div', {
          class: `step${n.done ? ' done' : ''}${i === currentIdx ? ' current' : ''}`,
        },
        n.label || t(`order.status.${n.status}`),
        n.note ? h('div', { class: 'tiny', style: 'color:var(--ink-3)', text: n.note }) : null,
        n.at ? h('time', { text: dateTime(n.at) }) : null))))
      : null;

    const navBtn = h('button', {
      class: 'btn ghost',
      text: t('owner.navigate'),
      onclick: async () => {
        try {
          const res = await api.post(`/api/owner/orders/${o.id}/navigate`, {});
          if (res.url) window.open(res.url, '_blank', 'noopener');
        } catch (err) {
          toast(err.message, { kind: 'bad' });
        }
      },
    });
    const actionRow = h('div', { class: 'row', style: 'gap:8px' },
      full.can_move_forward
        ? h('button', { class: 'btn', style: 'flex:1', text: t('owner.mark', { status: t(`order.status.${full.next_status}`) }), onclick: () => { handle.close(); advance(o, full.next_status); } })
        : null,
      full.payment_status !== 'paid' && full.payment_method === 'upi'
        ? h('button', { class: 'btn secondary', style: 'flex:1', text: t('owner.mark_paid'), onclick: () => { handle.close(); markPaid(o); } })
        : null,
      navBtn);

    mount(handle.body, h('div', { class: 'stack' },
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, ...badges),
      customerCard,
      itemsCard,
      timelineCard,
      actionRow));
  };

  const { model: shellModel } = await ownerShell(root, {
    title: t('owner.title'),
    children: [body],
    reload,
  });
  model = model || shellModel;
  paint();

  const tick = setInterval(() => {
    if (!document.hidden && state.owner.signedIn) reload();
  }, 30000);
  onRefresh(() => paint());
  return () => clearInterval(tick);
}

export async function restock(product, reload) {
  let qty = Number(product.stock_qty || 0);
  const handle = sheet({
    title: `${t('owner.restock')} · ${product.name}`,
    body: h('div', { class: 'stack' },
      h('p', { class: 'small muted', text: `Currently ${product.stock_qty ?? '—'} in stock (alert at ${product.low_stock_qty ?? 0}).` }),
      stepper({
        value: qty,
        min: 0,
        max: 9999,
        step: 5,
        size: 'lg',
        onChange: (v) => { qty = v; },
      }),
      h('div', { class: 'row', style: 'gap:8px' },
        h('button', { class: 'btn ghost', text: t('owner.mark_out'), onclick: async () => { await save({ stock_status: 'out_of_stock' }); } }),
        h('button', { class: 'btn', style: 'flex:1', text: t('common.save'), onclick: async () => { await save({ stock_qty: qty }); } }))),
  });
  const save = async (patch) => {
    try {
      const res = await api.post(`/api/admin/products/${product.id}/stock`, patch);
      handle.close();
      toast(res.message, { kind: 'ok' });
      reload();
    } catch (err) {
      toast(err.message, { kind: state.owner.level === 'admin' ? 'bad' : 'warn' });
    }
  };
}
