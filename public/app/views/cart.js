/** Cart, two-step checkout (address → payment) and the order-confirmation screen. */
import { h, mount, debounce } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { t, localName } from '../core/i18n.js';
import { state, set } from '../core/store.js';
import { api } from '../core/api.js';
import { page, notice, pill, toast, sheet, stepper, buildForm, priceLines, emptyState, confirmSheet } from '../core/components.js';
import { money, money2, plural, etaText, addressOneLine } from '../core/format.js';
import { go } from '../core/router.js';

export function docTitle() {
  return t('nav.cart');
}

/* -------------------------------------------------------------------- cart -- */
export async function cartView(root, { onRefresh }) {
  const body = h('div', {});
  const paint = (cart) => {
    if (!cart) return mount(body, h('div', { class: 'sk', style: 'height:180px' }));
    if (!cart.lines.length) {
      return mount(body, emptyState('cart', t('cart.empty'), 'Add rice, oil, dal or anything your kitchen needs.',
        h('button', { class: 'btn', text: t('cart.empty_cta'), onclick: () => go('/shop') })));
    }
    const progress = cart.min_order_value ? Math.min(100, Math.round((cart.subtotal / cart.min_order_value) * 100)) : 100;
    const rows = h('div', { class: 'card', style: 'overflow:hidden' });
    for (const line of cart.lines) rows.append(cartRow(line, cart, paint));

    mount(body,
      rows,
      cart.warnings.length ? notice('warn', cart.warnings[0]) : null,
      h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { style: 'font-size:16px', text: 'Bill summary' })), summaryBlock(cart)),
      cart.min_order_value && !cart.min_order_met
        ? h('div', { class: 'card pad' },
          h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' },
            h('span', { class: 'small strong', text: t('shop.min_order', { amt: money(cart.min_order_value) }) }),
            h('span', { class: 'tiny muted', text: `${Math.round(progress)}%` })),
          h('div', { class: 'progress' }, h('i', { style: `width:${progress}%` })),
          h('div', { class: 'small', style: 'margin-top:8px;color:var(--amber-700)', text: t('cart.min_short', { amt: money(cart.min_order_short_by) }) }))
        : null,
      h('div', { class: 'row', style: 'gap:8px' },
        h('button', { class: 'btn ghost', style: 'flex:0 0 auto', text: t('common.continue'), onclick: () => go('/shop') }),
        h('button', {
          class: 'btn', style: 'flex:1',
          disabled: !cart.min_order_met || cart.blocking_lines.length > 0 || !state.settings?.shop_open,
          text: t('cart.checkout'),
          onclick: () => go('/checkout'),
        })),
      h('p', { class: 'tiny muted', style: 'text-align:center;margin-top:10px', text: t('cart.priced_by') }));
  };

  const clearAll = async () => {
    if (!(await confirmSheet({ title: 'Clear the cart?', message: 'This removes every item.', confirmLabel: t('common.clear'), danger: true }))) return;
    try {
      const cart = await api.del('/api/cart');
      set({ cart });
      paint(cart);
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  page({
    root,
    tab: 'cart',
    header: { user: state.user, cart: state.cart },
    children: [
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' },
        h('h1', { style: 'font-size:21px', text: t('cart.title') }),
        h('button', { class: 'linklike', text: 'Clear cart', onclick: () => clearAll() })),
      state.settings && !state.settings.shop_open ? notice('warn', t('closed.banner')) : null,
      body,
    ],
  });

  try {
    const cart = state.cart || (await api.get('/api/cart'));
    set({ cart });
    paint(cart);
  } catch (err) {
    paint(null);
    toast(err.message, { kind: 'bad' });
  }
  onRefresh(() => cartView(root, { onRefresh }));
}

function cartRow(line, cart, repaint) {
  const qtyCtrl = stepper({
    value: line.qty,
    min: line.min_qty || 1,
    max: line.max_qty || 99,
    onChange: debounce(async (qty) => {
      try {
        const next = await api.patch(`/api/cart/items/${line.product_id}`, { qty });
        set({ cart: next });
        repaint(next);
      } catch (err) {
        toast(err.message, { kind: 'bad' });
      }
    }, 260),
  });
  return h('div', { class: 'cartline' },
    h('img', { src: line.image || '/img/products/placeholder-1.svg', alt: '', width: 62, height: 54, loading: 'lazy' }),
    h('div', { class: 'stack', style: 'gap:4px' },
      h('div', { class: 'row', style: 'align-items:flex-start;gap:8px' },
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { class: 'pcard-brand', text: line.brand || '' }),
          h('strong', { style: 'font-size:14px;display:block', text: localName(line) }),
          h('div', { class: 'tiny muted', text: line.pack_size || '' })),
        h('button', {
          class: 'iconbtn', style: 'width:32px;height:32px', 'aria-label': t('common.remove'), title: t('common.remove'),
          html: icons.trash,
          onclick: async () => {
            const next = await api.del(`/api/cart/items/${line.product_id}`);
            set({ cart: next });
            repaint(next);
          },
        })),
      h('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-top:2px' },
        qtyCtrl,
        h('div', { style: 'text-align:right' },
          h('div', { class: 'strong', text: money2(line.line_total) }),
          h('div', { class: 'tiny muted', text: `${money2(line.unit_price)} / unit` }))),
      (line.tier?.label || line.tier_label) ? pill(line.tier?.label || line.tier_label, 'info') : null,
      line.errors.length ? notice('bad', line.errors[0]) : null,
      line.warnings.length ? notice('warn', line.warnings[0]) : null));
}

function summaryBlock(cart) {
  return h('div', {},
    priceLines({ subtotal: cart.subtotal, discount: cart.discount, delivery: cart.delivery_charge, total: cart.total, savings: cart.total_savings }),
    cart.account_type === 'wholesale' && cart.wholesale_savings > 0
      ? h('div', { class: 'line', style: 'margin-top:6px' }, h('span', { class: 'k', text: t('shop.wholesale_viewing') }), h('span', { text: money2(cart.wholesale_savings) }))
      : null,
    cart.delivery_charge === 0 && cart.free_delivery_above
      ? h('div', { class: 'tiny muted', style: 'margin-top:6px', text: t('shop.free_delivery', { amt: money(cart.free_delivery_above) }) })
      : null);
}

/* ---------------------------------------------------------------- checkout -- */
export async function checkoutView(root, { query }) {
  let step = query.step === 'payment' ? 2 : 1;
  let preview = null;
  let selectedAddress = null;
  let payment = { method: 'upi', app: 'gpay' };
  let upiRef = '';
  let instructions = '';
  const body = h('div', {});

  const paint = () => {
    if (!preview) return mount(body, h('div', { class: 'sk', style: 'height:260px' }));
    const cart = preview.cart;
    const stepsBar = h('div', { class: 'steps' },
      ...[['1', t('checkout.address'), 1], ['2', t('checkout.payment'), 2], ['3', t('checkout.review'), 3]].flatMap(([n, label, idx], i, arr) => [
        h('div', { class: `s ${step === idx ? 'active' : step > idx ? 'done' : ''}` }, h('i', { text: step > idx ? '✓' : n }), h('span', { text: label })),
        i < arr.length - 1 ? h('div', { class: 'bar' }) : null,
      ]));

    const content = step === 1 ? addressStep() : step === 2 ? paymentStep() : reviewStep();
    mount(body,
      stepsBar,
      cart.blocking_lines.length ? notice('bad', `${cart.blocking_lines.length} item(s) need attention — remove them to continue.`) : null,
      content,
      h('div', { class: 'card pad', style: 'margin-top:14px' },
        h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' },
          h('strong', { text: t('common.total') }),
          h('span', { class: 'price lg', text: money2(cart.total) })),
        priceLines({ subtotal: cart.subtotal, discount: cart.discount, delivery: cart.delivery_charge, total: cart.total, savings: cart.total_savings }),
        h('div', { class: 'tiny muted', style: 'margin-top:8px', text: t('checkout.total_note') })));
  };

  /* step 1 — address ------------------------------------------------------ */
  function addressStep() {
    const list = h('div', { class: 'stack' });
    if (!preview.addresses.length) {
      list.append(notice('info', t('checkout.need_address')));
    }
    for (const a of preview.addresses) {
      const checked = selectedAddress?.id === a.id;
      list.append(h('button', {
        class: 'addr', 'aria-checked': String(checked), type: 'button',
        onclick: () => {
          selectedAddress = a;
          paint();
        },
      },
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('strong', { text: a.label || 'Address' }),
        checked ? pill('Selected', 'ok') : null,
        a.kind === 'business' ? pill('Business', 'info') : null),
      h('div', { class: 'small', style: 'margin-top:4px', text: addressOneLine(a) }),
      a.landmark ? h('div', { class: 'tiny muted', text: `Near ${a.landmark}` }) : null,
      h('div', { class: 'row', style: 'margin-top:6px;gap:6px' },
        h('span', { class: 'tiny muted', text: `${a.contact_name || ''} · ${a.contact_phone || ''}` }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'linklike tiny', onclick: (e) => { e.stopPropagation(); editAddress(a); }, text: t('common.edit') }))));
    }
    if (!selectedAddress && preview.addresses.length) selectedAddress = preview.addresses.find((a) => a.is_default) || preview.addresses[0];

    return h('div', { class: 'stack' },
      h('div', { class: 'section-head' }, h('h2', { style: 'font-size:17px', text: t('checkout.address') }),
        h('button', { class: 'linklike spacer', text: t('checkout.new_address'), onclick: () => editAddress(null) })),
      list,
      h('button', {
        class: 'btn block', disabled: !selectedAddress, text: t('common.next'),
        onclick: () => { step = 2; paint(); },
      }));
  }

  function editAddress(existing) {
    const isBusiness = state.user?.role === 'wholesale';
    const form = buildForm([
      { name: 'label', label: t('checkout.label'), value: existing?.label || (isBusiness ? 'Shop' : 'Home'), maxlength: 30 },
      ...(isBusiness ? [{ name: 'kind', label: 'Address kind', type: 'select', value: existing?.kind || 'business', options: [{ value: 'home', label: 'Home' }, { value: 'business', label: 'Business / shop' }] }] : []),
      { name: 'line1', label: t('checkout.line1'), required: true, value: existing?.line1 || '', autocomplete: 'address-line1' },
      { name: 'line2', label: t('checkout.line2'), value: existing?.line2 || '' },
      { name: 'area', label: t('checkout.area'), value: existing?.area || '' },
      { name: 'pincode', label: t('checkout.pincode'), inputmode: 'numeric', maxlength: 6, value: existing?.pincode || '' },
      { name: 'landmark', label: t('checkout.landmark'), value: existing?.landmark || '' },
      { name: 'contact_name', label: t('checkout.contact'), value: existing?.contact_name || state.user?.full_name || '' },
      { name: 'contact_phone', label: t('checkout.contact_phone'), type: 'tel', inputmode: 'numeric', maxlength: 14, value: existing?.contact_phone || state.user?.mobile || '' },
      { name: 'is_default', label: 'Make this my default', type: 'checkbox', value: !existing && !preview.addresses.length },
    ], {
      submitLabel: t('common.save'),
      onSubmit: async (values, { setError }) => {
        try {
          const res = existing
            ? await api.patch(`/api/auth/me/addresses/${existing.id}`, values)
            : await api.post('/api/auth/me/addresses', values);
          preview.addresses = res.addresses;
          selectedAddress = res.addresses.find((a) => a.id === (res.address?.id || existing?.id)) || res.addresses[0];
          handle.close();
          toast('Address saved', { kind: 'ok' });
          paint();
        } catch (err) {
          const field = err.fields ? Object.keys(err.fields)[0] : 'line1';
          setError(field === 'Pincode' ? 'pincode' : field, err.message);
        }
      },
    });
    const handle = sheet({ title: existing ? t('common.edit') : t('checkout.new_address'), body: form.el });
  }

  /* step 2 — payment ------------------------------------------------------ */
  function paymentStep() {
    const apps = [
      { key: 'gpay', label: 'Google Pay', colour: '#1a73e8' },
      { key: 'phonepe', label: 'PhonePe', colour: '#5f259f' },
      { key: 'paytm', label: 'Paytm', colour: '#00b9f1' },
      { key: 'other', label: 'Any UPI app', colour: '#0f7b4f' },
    ];
    const codAllowed = state.settings?.cod_enabled !== false;
    const pick = (kind, app) => {
      payment = { ...payment, method: kind, app: app || payment.app };
      paint();
    };
    return h('div', { class: 'stack' },
      h('h2', { style: 'font-size:17px', text: t('checkout.payment') }),
      ...apps.map((a) => h('button', {
        class: 'payopt', type: 'button', 'aria-checked': String(payment.method === 'upi' && payment.app === a.key),
        onclick: () => pick('upi', a.key),
      },
      h('span', { class: 'mark', style: `background:${a.colour}` }, a.label.slice(0, 2).toUpperCase()),
      h('div', {}, h('strong', { text: a.label }), h('div', { class: 'tiny muted', text: a.key === 'other' ? 'Generic UPI deep link' : 'Opens in the app to pay' })),
      h('span', { class: 'radio' }))),
      codAllowed
        ? h('button', { class: 'payopt', type: 'button', 'aria-checked': String(payment.method === 'cod'), onclick: () => pick('cod') },
          h('span', { class: 'mark', style: 'background:#8a6d3b', html: icons.wallet }),
          h('div', {}, h('strong', { text: t('checkout.cod') }), h('div', { class: 'tiny muted', text: `Pay ${money2(preview.cart.total)} to the delivery person` })),
          h('span', { class: 'radio' }))
        : notice('info', 'Cash on delivery is disabled by the shop right now.'),
      h('div', { class: 'field' },
        h('label', { text: t('checkout.instructions') }),
        h('textarea', { class: 'input', rows: 2, placeholder: 'e.g. ring the bell twice, leave with the guard', oninput: (e) => { instructions = e.target.value; } })),
      h('div', { class: 'row', style: 'gap:8px' },
        h('button', { class: 'btn ghost', text: t('common.back'), onclick: () => { step = 1; paint(); } }),
        h('button', { class: 'btn', style: 'flex:1', text: t('common.next'), onclick: () => { step = 3; paint(); } })));
  }

  /* step 3 — review + place ---------------------------------------------- */
  function reviewStep() {
    const cart = preview.cart;
    const eta = state.settings?.eta_minutes || 90;
    return h('div', { class: 'stack' },
      h('div', { class: 'card pad' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('strong', { text: t('checkout.address') }),
          h('button', { class: 'linklike', text: t('common.edit'), onclick: () => { step = 1; paint(); } })),
        h('div', { class: 'small', style: 'margin-top:4px', text: selectedAddress ? addressOneLine(selectedAddress) : '—' })),
      h('div', { class: 'card pad' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('strong', { text: t('checkout.payment') }),
          h('button', { class: 'linklike', text: t('common.edit'), onclick: () => { step = 2; paint(); } })),
        h('div', { class: 'small', style: 'margin-top:4px', text: payment.method === 'cod' ? t('checkout.cod') : `UPI · ${payment.app}` }),
        payment.method === 'upi'
          ? h('div', { class: 'field', style: 'margin-top:10px' },
            h('label', { text: t('checkout.upi_ref') }),
            h('input', { class: 'input', inputmode: 'numeric', maxlength: 18, placeholder: 'e.g. 412988713345', value: upiRef, oninput: (e) => { upiRef = e.target.value; } }),
            h('div', { class: 'hint', text: t('checkout.pay_hint') }))
          : null),
      h('div', { class: 'card pad' },
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('strong', { text: t('common.items') }), h('span', { class: 'tiny muted', text: plural(cart.item_count, 'item', 'items') })),
        h('div', { style: 'margin-top:6px' }, ...cart.lines.map((l) => h('div', { class: 'item-row' },
          h('span', { style: 'flex:1', text: `${localName(l)}${l.pack_size ? ` · ${l.pack_size}` : ''}` }),
          h('span', { class: 'tiny muted', text: `×${l.qty}` }),
          h('span', { class: 'strong', style: 'min-width:74px;text-align:right', text: money2(l.line_total) }))))),
      h('div', { class: 'demo-note', text: `${t('checkout.eta', { time: `~${eta} min` })} · ${t('shop.min_order', { amt: money(cart.min_order_value) })}` }),
      h('button', {
        class: 'btn block', style: 'min-height:52px', disabled: !preview.can_checkout,
        onclick: place,
        text: `${t('checkout.place')} · ${money2(cart.total)}`,
      }));
  }

  const place = async () => {
    if (!navigator.onLine) return toast(t('offline.cannot_order'), { kind: 'bad' });
    try {
      const res = await api.post('/api/orders', {
        address_id: selectedAddress?.id || null,
        payment_method: payment.method,
        payment_app: payment.app,
        upi_ref: payment.method === 'upi' ? upiRef.trim() : null,
        instructions,
      });
      set({ cart: res.cart });
      window.__smvPlaced = res;
      go(`/order/${res.order.id}?justPlaced=1`);
    } catch (err) {
      if (err.cart) {
        preview = { ...preview, cart: err.cart, can_checkout: false };
        paint();
      }
      toast(err.message, { kind: 'bad' });
    }
  };

  page({
    root,
    tab: null,
    header: { user: state.user, cart: state.cart, back: '/cart' },
    children: [body],
  });
  try {
    preview = await api.get('/api/orders/preview');
    selectedAddress = preview.addresses.find((a) => a.is_default) || preview.addresses[0] || null;
    if (!preview.addresses.length) step = 1;
    paint();
  } catch (err) {
    toast(err.message, { kind: 'bad' });
    go('/cart');
  }
}

/* ---------------------------------------------------- order confirmation ------ */
export async function placedView(root, { params }) {
  const body = h('div', {});
  mount(body, h('div', { class: 'sk', style: 'height:300px' }));
  page({ root, tab: null, header: { user: state.user, cart: state.cart }, children: [body] });

  let order;
  try {
    order = (await api.get(`/api/orders/${params.id}`)).order;
  } catch (err) {
    toast(err.message, { kind: 'bad' });
    return go('/orders');
  }
  const placed = window.__smvPlaced;
  window.__smvPlaced = null;
  const upi = placed?.payment;

  mount(body,
    h('div', { class: 'center', style: 'padding:8px 0 14px' },
      h('div', { style: 'width:64px;height:64px;border-radius:50%;background:var(--green-100);display:grid;place-items:center;margin:0 auto 10px;color:var(--green-700)', html: icons.check }),
      h('h1', { style: 'font-size:22px', text: t('order.placed') }),
      h('p', { class: 'small muted', text: t('order.thanks') })),
    h('div', { class: 'card pad', style: 'text-align:center' },
      h('div', { class: 'tiny muted', text: t('order.number') }),
      h('div', { class: 'mono', style: 'font-size:20px;font-weight:800', text: order.public_id }),
      h('div', { class: 'row', style: 'justify-content:center;gap:8px;margin-top:8px' },
        pill(t(`order.status.${order.status}`), 'info'),
        h('span', { class: 'tiny muted', text: `${t('order.eta')}: ${order.eta_minutes || 90} min` })),
      h('div', { class: 'divider' }),
      h('div', { class: 'small', text: `${t('common.total')}: ${money2(order.total)}` }),
      h('div', { class: 'tiny muted', text: order.payment_method === 'cod' ? t('order.due') : t('order.paid_pending') })),
    upi
      ? h('div', { class: 'upibox', style: 'margin-top:12px' },
        h('div', { class: 'small strong', text: `Pay ${money2(upi.amount)} to ${upi.upi_id}` }),
        h('p', { class: 'tiny muted', text: upi.note }),
        h('div', { class: 'row', style: 'justify-content:center;gap:8px;flex-wrap:wrap' },
          h('a', { class: 'btn sm', href: upi.intent, rel: 'noopener' }, h('span', { html: icons.wallet }), 'Open UPI app'),
          h('button', {
            class: 'btn sm secondary', text: t('owner.copy'),
            onclick: async () => {
              await navigator.clipboard?.writeText(upi.intent).catch(() => {});
              toast('Payment link copied', { kind: 'ok' });
            },
          })))
      : null,
    h('div', { class: 'stack', style: 'margin-top:12px' },
      h('button', { class: 'btn block', text: t('order.track'), onclick: () => go(`/orders/${order.id}`) }),
      h('div', { class: 'row', style: 'gap:8px' },
        h('a', { class: 'btn ghost', style: 'flex:1', href: '/shop', 'data-link': '', text: t('cart.empty_cta') }),
        h('a', { class: 'chip', style: 'height:46px', href: `tel:${(state.settings?.store_phone || '').replace(/\s/g, '')}` }, h('span', { style: 'width:16px', html: icons.phone }), t('order.call')))),
    h('div', { class: 'demo-note', style: 'margin-top:12px', text: 'A WhatsApp/SMS confirmation is queued for your number — you can see exactly what was sent on the order tracking screen.' }));
}
