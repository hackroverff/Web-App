/** Order list and live order tracking. */
import { h, mount } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { t, localName } from '../core/i18n.js';
import { state, set } from '../core/store.js';
import { api } from '../core/api.js';
import { page, pill, notice, toast, sheet, statusChip, emptyState, confirmSheet, section } from '../core/components.js';
import { money, money2, shortDate, dateTime, timeAgo, etaText } from '../core/format.js';
import { go } from '../core/router.js';

const FLOW = ['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered'];
export function docTitle() {
  return t('nav.orders');
}

/* ---------------------------------------------------------------- orders list */
export async function ordersView(root, { onRefresh }) {
  const TABS = [['all', t('common.all')], ['active', t('order.active')], ['done', t('order.done')], ['cancelled', t('order.cancelled')]];
  let tab = 'all';
  let orders = null;
  const list = h('div', { class: 'stack' });

  const load = async () => {
    try {
      orders = (await api.get('/api/orders?limit=40')).orders;
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const paint = () => {
    if (!orders) return mount(list, h('div', { class: 'sk', style: 'height:140px' }), h('div', { class: 'sk', style: 'height:140px' }));
    const shown = orders.filter((o) =>
      (tab === 'all' ? true : tab === 'active' ? !['delivered', 'cancelled', 'void'].includes(o.status) : tab === 'done' ? o.status === 'delivered' : ['cancelled', 'void'].includes(o.status)));
    mount(list,
      h('div', { class: 'chips' }, ...TABS.map(([key, label]) => h('button', {
        class: `chip ${tab === key ? 'on' : ''}`, 'aria-pressed': String(tab === key), onclick: () => { tab = key; paint(); }, text: label,
      }))),
      shown.length
        ? h('div', { class: 'stack' }, ...shown.map(orderCard))
        : emptyState('receipt', t('order.none'), 'Your orders will show up here — placed, packed, on the way.',
          h('button', { class: 'btn', text: t('cart.empty_cta'), onclick: () => go('/shop') })));
  };

  const orderCard = (o) => h('div', { class: 'order-card', onclick: () => go(`/orders/${o.id}`) },
    h('div', { class: 'row', style: 'justify-content:space-between;gap:8px' },
      h('strong', { style: 'font-family:var(--mono);letter-spacing:-.02em', text: o.public_id }),
      statusChip(o.status)),
    h('div', { class: 'row', style: 'justify-content:space-between;margin-top:3px' },
      h('span', { class: 'tiny muted', text: `${shortDate(o.placed_at)} · ${o.line_count || o.items?.length || ''}${o.line_count ? ' items' : ''}` }),
      h('span', { class: 'strong', text: money2(o.total) })),
    h('div', { class: 'divider' }),
    h('div', { class: 'row', style: 'justify-content:space-between;gap:8px' },
      h('span', { class: 'tiny', style: 'color:var(--ink-2)', text: o.status_label || summaryOf(o) }),
      h('span', { class: 'row', style: 'gap:6px' },
        ['placed', 'confirmed'].includes(o.status) ? h('button', {
          class: 'linklike tiny', text: t('order.cancel'),
          onclick: async (e) => { e.stopPropagation(); await cancel(o); },
        }) : null,
        h('button', {
          class: 'btn sm secondary', text: t('order.reorder'),
          onclick: async (e) => { e.stopPropagation(); await reorder(o); },
        }))),
    o.voided ? h('div', { class: 'tiny', style: 'margin-top:6px;color:var(--red-700)', text: t('order.voided') }) : null);

  const summaryOf = (o) => (o.items || []).map((i) => `${i.qty}× ${i.name}`).join(', ').slice(0, 90);

  const reorder = async (o) => {
    try {
      const res = await api.post(`/api/orders/${o.id}/reorder`, { mode: 'full' });
      set({ cart: res.cart });
      toast(res.message || 'Items added back to your cart', { kind: 'ok', action: { label: t('nav.cart'), run: () => go('/cart') } });
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const cancel = async (o) => {
    if (!(await confirmSheet({ title: t('order.cancel'), message: 'Cancel this order? The shop will be notified straight away.', confirmLabel: t('order.cancel'), danger: true }))) return;
    try {
      const res = await api.post(`/api/orders/${o.id}/cancel`, { reason: 'Cancelled from the app' });
      toast(res.message, { kind: 'ok' });
      load();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  page({
    root,
    tab: 'orders',
    header: { user: state.user, cart: state.cart },
    children: [h('h1', { style: 'font-size:21px;margin-bottom:10px', text: t('order.title') }), list],
  });
  paint();
  await load();
  onRefresh(() => load());
}

/* --------------------------------------------------------------- order detail */
export async function orderView(root, { params, query, onRefresh }) {
  const id = Number(params.id);
  let order = null;
  const body = h('div', {});
  let timer = null;
  let upi = null;

  page({
    root,
    tab: null,
    header: { user: state.user, cart: state.cart, back: '/orders' },
    children: [body],
  });

  const load = async () => {
    try {
      order = (await api.get(`/api/orders/${id}`)).order;
      if (order.payment_method === 'upi' && order.payment_status !== 'paid') {
        try {
          upi = await api.get(`/api/orders/${id}/upi`);
        } catch { upi = null; }
      } else {
        upi = null;
      }
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
      go('/orders');
    }
  };

  const paint = () => {
    const o = order;
    const stageIdx = FLOW.indexOf(o.status);
    const done = o.status === 'delivered';
    const dead = ['cancelled', 'void'].includes(o.status);
    mount(body,
      query.justPlaced === '1' ? notice('ok', t('order.placed'), h('div', { class: 'tiny', text: t('order.thanks') })) : null,
      h('div', { class: 'card pad' },
        h('div', { class: 'row', style: 'justify-content:space-between;gap:8px' },
          h('div', {},
            h('div', { class: 'tiny muted', text: t('order.number') }),
            h('div', { class: 'mono', style: 'font-size:19px;font-weight:800', text: o.public_id })),
          statusChip(o.status)),
        h('div', { class: 'tiny muted', style: 'margin-top:4px', text: `${t('order.placed_on')} ${dateTime(o.placed_at)}` }),
        dead ? null : h('div', { style: 'margin-top:12px' },
          h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' },
            h('span', { class: 'tiny strong', text: done ? t('order.delivered') : t('order.eta') }),
            h('span', { class: 'tiny muted', text: done ? timeAgo(o.updated_at) : etaText(o.promised_at, o.eta_minutes) })),
          h('div', { class: 'progress' }, h('i', { style: `width:${done ? 100 : Math.max(8, ((stageIdx + 1) / FLOW.length) * 100)}%` })),
          h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' },
            ...FLOW.map((s2, i) => h('span', {
              class: `tiny ${i <= stageIdx ? 'strong' : 'muted'}`,
              style: i <= stageIdx ? 'color:var(--green-700)' : '',
              text: t(`order.status.${s2}`),
            })))),
        o.voided ? notice('bad', t('order.voided'), o.void_reason ? h('div', { class: 'tiny', text: o.void_reason }) : null) : null),

      section(t('common.items'), h('span', { class: 'tiny muted', text: `${o.price_scope_label || ''}` }),
        h('div', { class: 'card', style: 'overflow:hidden' },
          ...o.items.map((i) => h('div', { class: 'item-row' },
            h('span', { style: 'flex:1' }, localName(i), h('span', { class: 'tiny muted', text: ` · ${i.qty} × ${money2(i.unit_price)}` })),
            i.tier_label ? pill(i.tier_label, 'info') : null,
            h('span', { class: 'strong', style: 'min-width:76px;text-align:right', text: money2(i.line_total) }))),
          h('div', { class: 'item-row', style: 'background:var(--paper-2)' },
            h('span', { style: 'flex:1', text: t('common.delivery') }),
            h('span', { class: 'strong', text: o.delivery_charge > 0 ? money2(o.delivery_charge) : 'Free' })),
          o.discount > 0 ? h('div', { class: 'item-row', style: 'background:var(--paper-2)' },
            h('span', { style: 'flex:1', text: t('common.discount') }),
            h('span', { class: 'strong', style: 'color:var(--green-700)', text: `− ${money2(o.discount)}` })) : null,
          h('div', { class: 'item-row', style: 'background:var(--green-50)' },
            h('span', { class: 'strong', style: 'flex:1', text: t('common.total') }),
            h('span', { class: 'price', text: money2(o.total) })))),

      section(t('order.payment'), null,
        h('div', { class: 'card pad' },
          h('div', { class: 'row', style: 'justify-content:space-between' },
            h('span', { class: 'small muted', text: o.payment_method === 'cod' ? t('checkout.cod') : `UPI · ${(o.payment_app || 'upi').toUpperCase()}` }),
            payPill(o.payment_status)),
          o.payment_status === 'pending' && o.payment_method === 'upi'
            ? h('div', { class: 'stack', style: 'margin-top:10px' },
              h('p', { class: 'small muted', text: 'Pay the amount to the store UPI ID, then send us the reference so the counter can confirm it.' }),
              h('div', { class: 'upibox' },
                h('div', { class: 'row', style: 'justify-content:space-between;gap:8px;flex-wrap:wrap' },
                  h('div', {},
                    h('div', { class: 'tiny muted', text: t('common.pay') }),
                    h('strong', { text: money2(upi?.amount ?? o.total) }),
                    h('div', { class: 'mono small', style: 'margin-top:2px', text: upi?.upi_id || state.settings?.upi_id || '' })),
                  h('a', { class: 'btn sm', href: upi?.intent || '#', rel: 'noopener' }, h('span', { style: 'width:15px', html: icons.wallet }), t('order.open_upi'))),
                upi ? h('button', {
                  class: 'btn sm ghost', text: t('owner.copy'),
                  onclick: async () => {
                    await navigator.clipboard?.writeText(upi.intent).catch(() => {});
                    toast('Payment link copied', { kind: 'ok' });
                  },
                }) : null,
                h('button', {
                  class: 'btn sm secondary block', style: 'margin-top:8px', text: t('order.claim'),
                  onclick: claimPayment,
                })))
            : null,
          o.payment_status === 'paid' ? notice('ok', t('order.paid_ok')) : null,
          o.payment_status === 'cash_due' ? notice('info', t('order.due')) : null)),

      section(t('order.delivery'), o.maps_url ? h('a', { class: 'linklike tiny', href: o.maps_url, target: '_blank', rel: 'noopener', text: t('order.maps') }) : null,
        h('div', { class: 'card pad' },
          h('div', { class: 'small', text: o.address ? `${o.address.line1}${o.address.line2 ? `, ${o.address.line2}` : ''}${o.address.area ? `, ${o.address.area}` : ''} ${o.address.pincode || ''}` : '—' }),
          o.address?.contact_name ? h('div', { class: 'tiny muted', style: 'margin-top:4px', text: `${o.address.contact_name} · ${o.address.contact_phone}` }) : null,
          o.instructions ? h('div', { class: 'demo-note', style: 'margin-top:8px', text: o.instructions }) : null)),

      section(t('order.timeline'), null,
        h('div', { class: 'card pad' },
          h('div', { class: 'timeline' },
            ...(() => {
              const rows = o.timeline || [];
              const nextUp = rows.findIndex((r) => !r.done);
              const currentIdx = nextUp === -1 ? rows.length - 1 : nextUp;
              return rows.map((s, i) => h('div', {
                class: `step${s.done ? ' done' : ''}${i === currentIdx ? ' current' : ''}`,
              },
              s.label || t(`order.status.${s.status}`),
              s.note ? h('div', { class: 'tiny', style: 'color:var(--ink-2)', text: s.note }) : null,
              s.at ? h('time', { text: `${dateTime(s.at)}${s.actor ? ` · ${s.actor}` : ''}` }) : null));
            })())),
        (o.notifications || []).length
          ? h('details', { class: 'card pad', style: 'margin-top:8px' },
            h('summary', { class: 'small strong', text: t('order.messages', { n: o.notifications.length }) }),
            h('div', { class: 'stack', style: 'margin-top:8px' },
              ...o.notifications.map((n) => h('div', { class: 'listrow' },
                h('span', { class: 'ico', html: n.channel === 'whatsapp' ? icons.whatsapp : icons.chat }),
                h('div', { style: 'flex:1' },
                  h('div', { class: 'tiny muted', text: `${n.channel.toUpperCase()} → ${n.to_number} · ${timeAgo(n.created_at)}` }),
                  h('div', { class: 'small', style: 'white-space:pre-wrap', text: n.body })),
                pill(n.status, n.status === 'sent' ? 'ok' : 'grey')))))
          : null),

      h('div', { class: 'row', style: 'gap:8px;margin-top:14px' },
        o.can_cancel ? h('button', { class: 'btn secondary', style: 'flex:1', text: t('order.cancel'), onclick: cancel }) : null,
        h('button', { class: o.can_cancel ? 'btn' : 'btn', style: 'flex:1', text: t('order.reorder'), onclick: reorder }),
        h('a', { class: 'btn ghost', href: `tel:${(state.settings?.store_phone || '').replace(/\s/g, '')}`, style: 'flex:0 0 auto;height:46px;padding:0 14px' }, h('span', { style: 'width:16px', html: icons.phone }))));
  };

  const PAY = {
    paid: ['order.paid_ok', 'ok'],
    pending: ['order.pay_pending', 'low'],
    cash_due: ['order.due', 'info'],
    failed: ['order.pay_failed', 'out'],
    refunded: ['order.refunded', 'grey'],
  };
  const payPill = (status) => {
    const [key, kind] = PAY[status] || [null, 'grey'];
    return key ? pill(t(key), kind) : pill(status, 'grey');
  };

  const claimPayment = async () => {
    let input;
    const handle = sheet({
      title: t('order.claim'),
      body: h('div', { class: 'stack' },
        h('p', { class: 'small muted', text: 'Type the 12-digit reference from your UPI app (it is in the payment receipt under “Ref No.”).' }),
        (input = h('input', { class: 'input', inputmode: 'numeric', maxlength: 18, placeholder: 'e.g. 412988713345' })),
        h('button', {
          class: 'btn block', text: t('common.save'),
          onclick: async () => {
            try {
              const res = await api.post(`/api/orders/${order.id}/claim-payment`, { upi_ref: input.value.trim() });
              handle.close();
              toast(res.message, { kind: 'ok' });
              order = res.order;
              paint();
            } catch (err) {
              toast(err.message, { kind: 'bad' });
            }
          },
        })),
    });
  };

  const reorder = async () => {
    try {
      const res = await api.post(`/api/orders/${order.id}/reorder`, { mode: 'full' });
      set({ cart: res.cart });
      toast(res.message || 'Added to cart', { kind: 'ok', action: { label: t('nav.cart'), run: () => go('/cart') } });
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const cancel = async () => {
    if (!(await confirmSheet({ title: t('order.cancel'), message: 'The shop is notified immediately. Any UPI payment is refunded within 2 working days.', confirmLabel: t('order.cancel'), danger: true }))) return;
    try {
      const res = await api.post(`/api/orders/${order.id}/cancel`, { reason: 'Cancelled from the app' });
      toast(res.message, { kind: 'ok' });
      order = res.order || order;
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  await load();
  if (!['delivered', 'cancelled', 'void'].includes(order?.status)) {
    timer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const fresh = await api.get(`/api/orders/${id}/track`);
        if (fresh.status !== order.status || fresh.payment_status !== order.payment_status) {
          await load();
          toast(`${t('order.updated')}: ${t(`order.status.${fresh.status}`)}`, { kind: 'info' });
        }
      } catch { /* offline — next tick retries */ }
    }, 20000);
  }
  onRefresh(() => load());
  return () => clearInterval(timer);
}
