/** Account home: identity, language, addresses, wholesale status, password, PWA extras. */
import { h, mount } from '../core/dom.js';
import { icons } from '../core/icons.js';
import { t, localName } from '../core/i18n.js';
import { state, set, setLang } from '../core/store.js';
import { api } from '../core/api.js';
import { page, pill, notice, toast, sheet, buildForm, section, confirmSheet, statusChip } from '../core/components.js';
import { money2, shortDate, initials } from '../core/format.js';
import { go } from '../core/router.js';
import { localGet, localSet } from '../core/storage.js';

export function docTitle() {
  return t('nav.profile');
}

export default async function profileView(root, { query, onRefresh }) {
  if (!state.user) {
    go(`/login?next=${encodeURIComponent('/profile')}`);
    return;
  }
  const u = state.user;
  let orders = [];
  try {
    orders = (await api.get('/api/orders?limit=5')).orders;
  } catch { /* offline: show what we know */ }
  const lifetime = orders.reduce((s, o) => s + Number(o.total || 0), 0);

  const body = h('div', { class: 'stack' });

  mount(body,
    h('div', { class: 'card pad' },
      h('div', { class: 'row', style: 'gap:12px;align-items:flex-start' },
        h('div', { style: 'width:52px;height:52px;border-radius:16px;background:var(--green-600);color:#fff;display:grid;place-items:center;font-weight:800;font-size:18px;flex:0 0 auto' }, initials(u.full_name)),
        h('div', { style: 'flex:1;min-width:0' },
          h('strong', { style: 'font-size:17px;display:block', text: u.full_name }),
          h('div', { class: 'small muted', text: `+91 ${u.mobile}` }),
          h('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' },
            pill(u.role === 'wholesale' ? t('auth.wholesale') : t('auth.retail'), u.role === 'wholesale' ? 'info' : 'grey'),
            u.verified ? pill(t('profile.verified'), 'ok') : pill(t('profile.unverified'), 'low'),
            u.pricing_scope === 'wholesale' ? pill(t('profile.wholesale_prices'), 'save') : null)),
        h('button', { class: 'iconbtn', 'aria-label': t('common.edit'), html: icons.pencil, onclick: () => editProfile() })),
      h('div', { class: 'divider' }),
      h('div', { class: 'row', style: 'justify-content:space-around;text-align:center' },
        h('div', {}, h('strong', { text: String(u.order_count || 0) }), h('div', { class: 'tiny muted', text: t('profile.orders') })),
        h('div', {}, h('strong', { text: money2(lifetime) }), h('div', { class: 'tiny muted', text: t('profile.lifetime') })),
        h('div', {}, h('strong', { text: String(u.address_count || 0) }), h('div', { class: 'tiny muted', text: t('profile.addresses') })))),

    wholesaleCard(u),

    section(t('profile.language'), null,
      h('div', { class: 'card pad' },
        h('div', { class: 'seg' },
          ...[['en', 'English'], ['ta', 'தமிழ்']].map(([code, label]) => h('button', {
            class: state.lang === code ? 'on' : '',
            onclick: () => {
              setLang(code);
              api.patch('/api/auth/profile', { lang: code }).then((res) => set({ user: res.user })).catch(() => {});
              toast(code === 'ta' ? 'மொழி மாற்றப்பட்டது' : 'Language switched', { kind: 'ok' });
            },
            text: label,
          }))),
        h('div', { class: 'tiny muted', style: 'margin-top:8px', text: 'Product names, categories and order messages follow the language you pick.' }))),

    section(t('profile.addresses'), h('button', { class: 'linklike', text: t('profile.manage'), onclick: () => go('/addresses') }), addressCard()),

    section(t('common.notifications'), null,
      h('div', { class: 'card pad', style: 'overflow:hidden' },
        toggleRow('bell', t('profile.notify_sms'), 'Order updates by SMS / WhatsApp to your number', 'sms', true),
        toggleRow('phone', t('profile.notify_calls'), 'Call me if the order is running late', 'calls', false))),

    section(t('profile.app'), null,
      h('div', { class: 'card pad', style: 'overflow:hidden' },
        h('button', { class: 'listrow', onclick: installApp },
          h('span', { class: 'ico', html: icons.download }),
          h('span', { style: 'flex:1' }, h('strong', { text: t('profile.install') }), h('div', { class: 'tiny muted', text: t('profile.install_sub') })),
          h('span', { class: 'go', html: icons.chevR })),
        h('button', { class: 'listrow', onclick: checkUpdate },
          h('span', { class: 'ico', html: icons.refresh }),
          h('span', { style: 'flex:1' }, h('strong', { text: t('profile.update') }), h('div', { class: 'tiny muted', text: t('profile.update_sub') })),
          h('span', { class: 'go', html: icons.chevR })),
        h('button', { class: 'listrow', onclick: () => go('/offline') },
          h('span', { class: 'ico', html: icons.wifiOff }),
          h('span', { style: 'flex:1' }, h('strong', { text: 'Offline preview' }), h('div', { class: 'tiny muted', text: 'See what stays readable without a network' })),
          h('span', { class: 'go', html: icons.chevR })),
        h('button', { class: 'listrow', onclick: changePassword },
          h('span', { class: 'ico', html: icons.lock }),
          h('span', { style: 'flex:1' }, h('strong', { text: t('profile.password') }), h('div', { class: 'tiny muted', text: 'Last changed — never, in this demo' })),
          h('span', { class: 'go', html: icons.chevR })))),

    recentOrders(orders),

    h('button', {
      class: 'btn secondary block', text: t('profile.signout'),
      onclick: async () => {
        if (!(await confirmSheet({ title: t('profile.signout'), message: 'Your cart stays saved on this device.', confirmLabel: t('profile.signout'), danger: true }))) return;
        window.smvLogout();
      },
    }),
    h('p', { class: 'tiny muted', style: 'text-align:center', text: `${t('app.name')} · demo build 2026.09 · no real payments are taken` }));

  page({
    root,
    tab: 'profile',
    header: { user: u, cart: state.cart },
    children: [query.created ? notice('ok', t('auth.registered')) : null, body],
  });
  onRefresh(() => profileView(root, { query, onRefresh }));
}

/** Read-only summary of the saved addresses; editing lives on /addresses. */
function addressCard() {
  const card = h('div', { class: 'card pad' }, h('div', { class: 'tiny muted', text: t('common.loading') }));
  api.get('/api/auth/me/addresses')
    .then((res) => {
      const list = res.addresses || [];
      if (!list.length) {
        mount(card, notice('info', t('checkout.need_address'),
          h('button', { class: 'linklike', text: t('checkout.new_address'), onclick: () => go('/addresses') })));
        return;
      }
      mount(card,
        h('div', { class: 'stack', style: 'gap:10px' },
          ...list.map((a) => h('div', { class: 'row', style: 'gap:8px;align-items:flex-start' },
            h('span', { class: 'ico', style: 'width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--green-50);color:var(--green-700)', html: icons.pin }),
            h('div', { style: 'flex:1;min-width:0' },
              h('strong', { style: 'font-size:13px', text: a.label || 'Address' }),
              a.is_default ? pill(t('profile.default'), 'ok') : null,
              h('div', { class: 'tiny muted', text: `${a.line1}${a.line2 ? `, ${a.line2}` : ''}${a.area ? `, ${a.area}` : ''} ${a.pincode || ''}` })))),
          h('button', { class: 'btn sm ghost block', text: t('profile.manage'), onclick: () => go('/addresses') })));
    })
    .catch(() => mount(card, notice('warn', 'Could not load your addresses right now.')));
  return card;
}

/* ---------------------------------------------------------------- wholesale -- */
function wholesaleCard(u) {
  if (u.role === 'wholesale') {
    const map = {
      active: ['ok', 'profile.ws_active'],
      pending_verification: ['low', 'profile.ws_pending'],
      rejected: ['out', 'profile.ws_rejected'],
      suspended: ['out', 'profile.ws_suspended'],
    };
    const [kind, key] = map[u.status] || ['grey', 'profile.ws_pending'];
    return h('div', { class: 'card pad' },
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('strong', { text: u.business_name || 'Wholesale account' }),
        pill(t(key), kind)),
      h('div', { class: 'small muted', style: 'margin-top:4px', text: `${u.business_type || 'business'}${u.gst_number ? ` · GSTIN ${u.gst_number}` : ''}` }),
      u.status === 'active'
        ? h('div', { class: 'demo-note', style: 'margin-top:8px', text: 'Slab prices are applied automatically in your cart. Higher quantities drop the unit rate.' })
        : h('div', { class: 'stack', style: 'margin-top:8px' },
          u.status === 'rejected' ? notice('bad', 'The owner could not verify these details. You can re-submit with corrected documents.') : notice('info', 'While this is with the owner, you keep shopping at retail prices.'),
          h('button', { class: 'btn sm secondary', text: t('profile.resubmit'), onclick: () => applyWholesale(true) })));
  }
  return h('div', { class: 'card pad' },
    h('div', { class: 'row', style: 'gap:10px;align-items:flex-start' },
      h('span', { class: 'ico', style: 'width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:var(--green-50);color:var(--green-700)', html: icons.building }),
      h('div', { style: 'flex:1' },
        h('strong', { text: t('profile.ws_title') }),
        h('div', { class: 'small muted', style: 'margin-top:2px', text: t('profile.ws_sub') }))),
    h('button', { class: 'btn sm block', style: 'margin-top:10px', text: t('profile.apply_wholesale'), onclick: () => applyWholesale(false) }));
}

function applyWholesale(resubmit) {
  const form = buildForm([
    { name: 'business_name', label: t('auth.business_name'), required: true, maxlength: 90, value: state.user?.business_name || '' },
    {
      name: 'business_type',
      label: t('auth.business_type'),
      type: 'select',
      required: true,
      value: state.user?.business_type || 'shop',
      options: ['shop', 'restaurant', 'canteen', 'office', 'institution', 'other'].map((v) => ({ value: v, label: t(`auth.${v}`) })),
    },
    { name: 'gst_number', label: `${t('auth.gst')} · ${t('common.optional')}`, maxlength: 15, value: state.user?.gst_number || '', hint: '15 characters, e.g. 33ABCDE1234F1Z5' },
  ], {
    submitLabel: t('profile.apply_wholesale'),
    onSubmit: async (values, { setError }) => {
      try {
        const res = await api.post('/api/auth/account-type', { account_type: 'wholesale', ...values });
        set({ user: res.user, cart: res.cart });
        handle.close();
        toast(res.message, { kind: 'ok' });
        go('/profile?created=1');
      } catch (err) {
        setError('business_name', err.message);
      }
    },
  });
  const handle = sheet({
    title: resubmit ? 'Update and resubmit' : t('profile.apply_wholesale'),
    body: h('div', { class: 'stack' },
      h('p', { class: 'small muted', text: 'The owner checks your shop name and GST certificate before wholesale prices are switched on.' }),
      form.el),
  });
}

/* ------------------------------------------------------------------ settings -- */
function toggleRow(iconName, label, sub, key, defaultOn) {
  const stored = localGet(`smv.pref.${key}`);
  const on = stored === null ? defaultOn : stored === '1';
  const input = h('input', { type: 'checkbox', checked: on });
  const wrap = h('label', { class: 'switch' }, input, h('span', { text: label }));
  input.addEventListener('change', () => {
    localSet(`smv.pref.${key}`, input.checked ? '1' : '0');
    toast(`${label} ${input.checked ? t('profile.on') : t('profile.off')}`, { kind: 'ok' });
  });
  return h('div', { class: 'listrow' },
    h('span', { class: 'ico', html: icons[iconName] }),
    h('div', { style: 'flex:1' }, h('strong', { style: 'font-size:14px', text: label }), h('div', { class: 'tiny muted', text: sub })),
    wrap);
}

function editProfile() {
  const form = buildForm([
    { name: 'full_name', label: t('auth.name'), required: true, maxlength: 80, value: state.user.full_name },
    { name: 'email', label: `${t('profile.email')} · ${t('common.optional')}`, type: 'email', maxlength: 90, value: state.user.email || '' },
  ], {
    submitLabel: t('common.save'),
    onSubmit: async (values, { setError }) => {
      try {
        const res = await api.patch('/api/auth/profile', values);
        set({ user: res.user });
        handle.close();
        toast('Saved', { kind: 'ok' });
        go('/profile');
      } catch (err) {
        setError('full_name', err.message);
      }
    },
  });
  const handle = sheet({ title: t('common.edit'), body: form.el });
}

function changePassword() {
  const form = buildForm([
    { name: 'current_password', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
    { name: 'new_password', label: t('auth.new_password'), type: 'password', required: true, hint: t('auth.password_hint'), autocomplete: 'new-password' },
    { name: 'confirm_password', label: t('auth.confirm'), type: 'password', required: true, autocomplete: 'new-password' },
  ], {
    submitLabel: t('common.save'),
    onSubmit: async (values, { setError }) => {
      try {
        const res = await api.post('/api/auth/change-password', values);
        handle.close();
        toast(res.message || 'Password changed', { kind: 'ok' });
      } catch (err) {
        setError('current_password', err.message);
      }
    },
  });
  const handle = sheet({ title: t('profile.password'), body: form.el });
}

async function installApp() {
  const deferred = window.__smvInstall;
  if (!deferred) {
    toast(t('profile.install_hint'), { kind: 'warn', ms: 7000 });
    return;
  }
  await deferred.prompt();
  const { outcome } = (await deferred.userChoice) || {};
  if (outcome === 'accepted') toast(t('profile.install_thanks'), { kind: 'ok' });
  window.__smvInstall = null;
}

async function checkUpdate() {
  if (!('serviceWorker' in navigator)) return toast('This browser cannot update the cache.', { kind: 'bad' });
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
    toast(reg?.waiting ? 'Update ready — restart the app to apply.' : 'You are on the latest version.', { kind: reg?.waiting ? 'warn' : 'ok' });
  } catch (err) {
    toast(err.message, { kind: 'bad' });
  }
}

function recentOrders(orders) {
  if (!orders.length) return null;
  return section(t('profile.recent'), h('a', { class: 'linklike', href: '/orders', 'data-link': '', text: t('landing.see_all') }),
    h('div', { class: 'card', style: 'overflow:hidden' },
      ...orders.map((o, i) => h('button', {
        class: 'listrow', style: i === 0 ? 'border-top:0' : '', onclick: () => go(`/orders/${o.id}`),
      },
      h('div', { style: 'flex:1;text-align:left' },
        h('div', { class: 'mono small strong', text: o.public_id }),
        h('div', { class: 'tiny muted', text: `${shortDate(o.placed_at)} · ${o.line_count || (o.items || []).length} items` })),
      h('span', { style: 'text-align:right' }, h('div', { class: 'small strong', text: money2(o.total) }), statusChip(o.status))))));
}

/* ----------------------------------------------------------------- addresses -- */
export async function addressesView(root, { onRefresh }) {
  const body = h('div', { class: 'stack' });
  let addresses = [];
  try {
    addresses = (await api.get('/api/auth/me/addresses')).addresses;
  } catch (err) {
    toast(err.message, { kind: 'bad' });
  }

  const paint = () => {
    mount(body,
      h('div', { class: 'row', style: 'justify-content:space-between;align-items:center' },
        h('p', { class: 'small muted', style: 'flex:1', text: 'Delivery addresses the shop uses for drop-offs and route planning.' }),
        h('button', { class: 'btn sm', text: t('checkout.new_address'), onclick: () => openForm(null) })),
      ...addresses.map((a) => h('div', { class: 'addr', 'aria-checked': String(!!a.is_default) },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('strong', { text: a.label || 'Address' }),
          a.is_default ? pill(t('profile.default'), 'ok') : null,
          a.kind === 'business' ? pill('Business', 'info') : null),
        h('div', { class: 'small', style: 'margin-top:4px', text: `${a.line1}${a.line2 ? `, ${a.line2}` : ''}${a.area ? `, ${a.area}` : ''} ${a.pincode || ''}` }),
        h('div', { class: 'tiny muted', text: `${a.contact_name} · ${a.contact_phone}` }),
        h('div', { class: 'row', style: 'gap:12px;margin-top:8px' },
          a.is_default ? null : h('button', { class: 'linklike tiny', text: t('profile.make_default'), onclick: () => makeDefault(a) }),
          h('button', { class: 'linklike tiny', text: t('common.edit'), onclick: () => openForm(a) }),
          h('button', { class: 'linklike tiny', style: 'color:var(--red-700)', text: t('common.delete'), onclick: () => remove(a) })))),
      addresses.length ? null : notice('info', t('checkout.need_address')));
  };

  const makeDefault = async (a) => {
    try {
      addresses = (await api.post(`/api/auth/me/addresses/${a.id}/default`, {})).addresses;
      paint();
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const remove = async (a) => {
    if (!(await confirmSheet({ title: t('common.delete'), message: `Delete “${a.label || a.line1}”?`, confirmLabel: t('common.delete'), danger: true }))) return;
    try {
      addresses = (await api.del(`/api/auth/me/addresses/${a.id}`)).addresses;
      paint();
      toast('Deleted', { kind: 'ok' });
    } catch (err) {
      toast(err.message, { kind: 'bad' });
    }
  };

  const openForm = (existing) => {
    const isBusiness = state.user?.role === 'wholesale';
    const form = buildForm([
      { name: 'label', label: t('checkout.label'), value: existing?.label || (isBusiness ? 'Shop' : 'Home'), maxlength: 30 },
      { name: 'kind', label: 'Address kind', type: 'select', value: existing?.kind || (isBusiness ? 'business' : 'home'), options: [{ value: 'home', label: 'Home' }, { value: 'business', label: 'Business / shop' }] },
      { name: 'line1', label: t('checkout.line1'), required: true, maxlength: 140, value: existing?.line1 || '' },
      { name: 'line2', label: t('checkout.line2'), value: existing?.line2 || '' },
      { name: 'area', label: t('checkout.area'), value: existing?.area || '' },
      { name: 'pincode', label: t('checkout.pincode'), inputmode: 'numeric', maxlength: 6, value: existing?.pincode || '' },
      { name: 'landmark', label: t('checkout.landmark'), value: existing?.landmark || '' },
      { name: 'contact_name', label: t('checkout.contact'), value: existing?.contact_name || state.user?.full_name || '' },
      { name: 'contact_phone', label: t('checkout.contact_phone'), type: 'tel', inputmode: 'numeric', maxlength: 14, value: existing?.contact_phone || state.user?.mobile || '' },
      { name: 'is_default', label: t('profile.make_default'), type: 'checkbox', value: existing ? !!existing.is_default : !addresses.length },
      {
        name: '__geo',
        label: 'Map pin',
        type: 'html',
        el: h('button', {
          class: 'btn secondary sm block', type: 'button', text: 'Use my current location',
          onclick: (e) => {
            if (!navigator.geolocation) return toast('This browser cannot share a location.', { kind: 'bad' });
            navigator.geolocation.getCurrentPosition((pos) => {
              latInput.value = pos.coords.latitude.toFixed(5);
              lngInput.value = pos.coords.longitude.toFixed(5);
              e.target.textContent = 'Location captured ✓';
            }, () => toast('Location permission denied.', { kind: 'warn' }));
          },
        }),
      },
      { name: 'lat', label: 'Latitude', value: existing?.lat || '', inputmode: 'decimal' },
      { name: 'lng', label: 'Longitude', value: existing?.lng || '', inputmode: 'decimal' },
    ], {
      submitLabel: t('common.save'),
      onSubmit: async (values, { setError }) => {
        try {
          const res = existing
            ? await api.patch(`/api/auth/me/addresses/${existing.id}`, values)
            : await api.post('/api/auth/me/addresses', values);
          addresses = res.addresses;
          handle.close();
          paint();
          toast('Address saved', { kind: 'ok' });
        } catch (err) {
          setError('line1', err.message);
        }
      },
    });
    const latInput = form.controls.get('lat').control;
    const lngInput = form.controls.get('lng').control;
    const handle = sheet({ title: existing ? t('common.edit') : t('checkout.new_address'), body: form.el });
  };

  paint();
  page({
    root,
    tab: null,
    header: { user: state.user, cart: state.cart, back: '/profile' },
    children: [h('h1', { style: 'font-size:20px;margin-bottom:8px', text: t('profile.addresses') }), body],
  });
  onRefresh(paint);
}
