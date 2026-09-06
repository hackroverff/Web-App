/** Shared UI pieces: header with the top-right nav cluster, tab bar, toasts, sheets, steppers, product cards, forms. */
import { h, debounce, mount } from './dom.js';
import { t, localName } from './i18n.js';
import { money, money2 } from './format.js';
import { icons } from './icons.js';

/* ------------------------------------------------------------------ header -- */
/**
 * Every customer page gets the same top-right cluster: Profile, Order history,
 * Cart (with item count badge) and Logout.
 */
export function appHeader({ user, cart = null, back = null, subtitle = null } = {}) {
  const go = (href) => (e) => {
    e.preventDefault();
    window.smvGo(href);
  };
  const brand = h('div', { class: 'appbar-brand' },
    back
      ? h('button', { class: 'iconbtn', 'aria-label': t('common.back'), onclick: () => (typeof back === 'string' ? window.smvGo(back) : back()), html: icons.back })
      : h('a', { href: '/', 'aria-label': 'Sathvika MV home', onclick: go('/'), style: { display: 'flex', gap: '9px', alignItems: 'center' } },
        h('img', { class: 'brandmark', src: '/img/logo.svg', alt: '', width: 32, height: 32 })),
    h('div', {},
      h('div', { class: 'appbar-title' }, t('app.name')),
      h('div', { class: 'appbar-sub' },
        h('span', { class: `dot ${user?.shop_open === false ? 'closed' : 'open'}` }),
        subtitle || (user ? `${t('app.tagline')}` : t('app.tagline')))),
  );

  const actions = h('div', { class: 'appbar-actions' });
  actions.append(langToggle());
  if (user) {
    actions.append(
      iconBtn('user', t('nav.profile'), go('/profile')),
      iconBtn('receipt', t('nav.orders'), go('/orders')),
      cartBadgeBtn(cart),
      iconBtn('logout', t('nav.logout'), logout),
    );
  } else {
    actions.append(h('a', { class: 'btn sm', href: '/login', onclick: (e) => { e.preventDefault(); window.smvGo('/login'); } }, t('auth.signin')));
  }
  return h('header', { class: 'appbar' }, brand, actions);
}

function logout() {
  window.smvLogout();
}

/** Cart button with a live item-count badge (updated from the store without a re-render). */
export function cartBadgeBtn(cart) {
  const badge = h('span', { class: 'badge', 'data-cart-badge': '', ...(cart?.item_count ? {} : { hidden: true }) }, String(cart?.item_count || 0));
  return h('button', { class: 'iconbtn', title: t('nav.cart'), 'aria-label': `${t('nav.cart')} (${cart?.item_count || 0})`, onclick: () => window.smvGo('/cart') },
    h('span', { html: icons.cart }), badge);
}

export function iconBtn(name, label, onclick, badge = 0, extra = {}) {
  return h('button', { class: 'iconbtn', title: label, 'aria-label': label, onclick, ...extra },
    h('span', { html: icons[name] || '' }),
    badge > 0 ? h('span', { class: 'badge' }, String(badge)) : null);
}

export function langToggle() {
  const current = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const btn = h('div', { class: 'lang-toggle', role: 'group', 'aria-label': t('common.language') },
    h('button', { type: 'button', 'aria-pressed': current === 'en', onclick: () => window.smvSetLang('en') }, 'EN'),
    h('button', { type: 'button', 'aria-pressed': current === 'ta', onclick: () => window.smvSetLang('ta') }, 'தமிழ்'));
  return btn;
}

export function tabbar(active) {
  const item = (href, name, label, key) =>
    h('a', { href, 'data-link': '', ...(active === key ? { 'aria-current': 'page' } : {}) },
      h('span', { style: 'position:relative', html: icons[name] }), label);
  return h('nav', { class: 'tabbar', 'aria-label': 'Primary' },
    item('/shop', 'bag', t('nav.shop'), 'shop'),
    item('/cart', 'cart', t('nav.cart'), 'cart'),
    item('/orders', 'receipt', t('nav.orders'), 'orders'),
    item('/profile', 'user', t('nav.account'), 'account'));
}

export function storeBanner(settings) {
  if (!settings) return null;
  if (!navigator.onLine) return h('div', { class: 'banner offline' }, `${t('offline.banner')}`);
  if (!settings.shop_open) return h('div', { class: 'banner closed' }, t('closed.banner'));
  return null;
}

/* ------------------------------------------------------------------ toasts -- */
let toastHost = null;
export function toast(message, { kind = '', action, ms = 3600 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host' });
    document.getElementById('overlays').appendChild(toastHost);
  }
  const node = h('div', { class: `toast ${kind}`, role: 'status' },
    h('span', { text: message }),
    action ? h('button', { type: 'button', onclick: () => { action.run(); close(); } }, action.label) : null);
  const close = () => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 200);
  };
  toastHost.appendChild(node);
  setTimeout(close, ms);
  return close;
}

/* ------------------------------------------------------------------ sheets -- */
/** Bottom sheet on phones, centred dialog on larger screens. */
export function sheet({ title, body, actions = [], size = '', onOpen, onClose }) {
  const scrim = h('div', { class: 'scrim', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' });
  const panel = h('div', { class: `sheet ${size}` }, h('div', { class: 'grip' }),
    title ? h('div', { class: 'sheet-head' }, h('h2', { text: title }), h('button', { class: 'iconbtn', 'aria-label': t('common.close'), onclick: () => close(), html: icons.close })) : null,
    body,
    actions.length ? h('div', { class: 'sheet-foot' }, ...actions) : null);
  scrim.appendChild(panel);
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) close();
  });
  const esc = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', esc);
  document.body.appendChild(scrim);
  document.body.style.overflow = 'hidden';
  onOpen?.(panel);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', esc);
    scrim.style.opacity = '0';
    setTimeout(() => {
      scrim.remove();
      document.body.style.overflow = '';
    }, 160);
    onClose?.();
  }
  const firstField = panel.querySelector('input,select,textarea,button');
  setTimeout(() => firstField?.focus?.({ preventScroll: true }), 60);
  return { el: panel, close, body: panel };
}

export function confirmSheet({ title, message, confirmLabel = t('common.done'), danger = false, cancelLabel = t('common.cancel'), body = null }) {
  return new Promise((resolve) => {
    let done = false;
    const api = sheet({
      title,
      body: body || h('p', { class: 'muted', text: message || '' }),
      actions: [
        h('button', { class: 'btn ghost', onclick: () => { done = true; api.close(); resolve(false); }, text: cancelLabel }),
        h('button', { class: `btn ${danger ? 'danger' : ''}`, onclick: () => { done = true; api.close(); resolve(true); }, text: confirmLabel }),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/* ------------------------------------------------------------------ pieces -- */
export function stepper({ value = 1, min = 1, max = 99, step = 1, size = '', onChange }) {
  let current = Math.max(min, Number(value) || min);
  const input = h('input', { type: 'text', inputmode: 'numeric', value: String(current), 'aria-label': t('shop.qty') });
  const emit = () => onChange?.(current);
  const set = (n) => {
    current = Math.min(max, Math.max(min, Math.trunc(n || min)));
    input.value = String(current);
    dec.disabled = current <= min;
    inc.disabled = current >= max;
  };
  const dec = h('button', { type: 'button', 'aria-label': '−', onclick: () => { set(current - step); emit(); }, html: icons.minus });
  const inc = h('button', { type: 'button', 'aria-label': '+', onclick: () => { set(current + step); emit(); }, html: icons.plus });
  input.addEventListener('change', () => {
    const parsed = parseInt(input.value.replace(/\D/g, ''), 10);
    set(Number.isFinite(parsed) ? parsed : min);
    emit();
  });
  set(current);
  return h('div', { class: `stepper ${size}` }, dec, input, inc);
}

export function stockPill(status) {
  const map = { in_stock: ['shop.in_stock', 'ok'], low_stock: ['shop.low_stock', 'low'], out_of_stock: ['shop.out_of_stock', 'out'] };
  const [key, kind] = map[status] || map.in_stock;
  return h('span', { class: `pill ${kind}`, text: t(key) });
}

export function productCard(product, { onAdd, onOpen } = {}) {
  const price = Number(product.price);
  const out = product.stock_status === 'out_of_stock';
  const img = h('img', { src: product.image || '/img/products/placeholder-1.svg', alt: '', loading: 'lazy', width: 160, height: 132 });
  const card = h('article', { class: `pcard ${out ? 'out' : ''}` },
    h('button', { class: 'pcard-img', style: 'border:0;padding:0;background:var(--card-2);cursor:pointer;display:block', 'aria-label': localName(product), onclick: () => onOpen?.(product) },
      img,
      product.discount_pct > 0 ? h('span', { class: 'pill save pcard-off', text: `-${product.discount_pct}%` }) : null),
    h('div', { class: 'pcard-body' },
      h('div', { class: 'pcard-brand', text: product.brand || '' }),
      h('button', { class: 'pcard-name linklike', style: 'text-align:left;color:inherit', onclick: () => onOpen?.(product), text: localName(product) }),
      h('div', { class: 'pcard-pack', text: product.pack_size || '' }),
      h('div', { class: 'pcard-price' },
        h('span', { class: 'price', text: money(price) }),
        product.mrp > price ? h('span', { class: 'price strike', text: money(product.mrp) }) : null),
      product.moq > 1 ? h('span', { class: 'moq-tag', text: t('shop.moq', { n: `${product.moq} ${product.unit}${product.moq === 1 ? '' : 's'}` }) }) : null,
      h('div', { class: 'pcard-foot' },
        out
          ? h('span', { class: 'pill out', text: t('shop.out_of_stock') })
          : h('div', { class: 'spacer' }),
        onAdd
          ? h('button', {
            class: `btn sm ${out ? 'ghost' : ''}`, disabled: out, text: t('shop.add'),
            onclick: (e) => { e.stopPropagation(); onAdd(product); },
          })
          : null)));
  return card;
}

export function priceLines({ subtotal, discount, delivery, total, savings }) {
  return h('div', { class: 'summary' },
    h('div', { class: 'line' }, h('span', { class: 'k', text: t('common.subtotal') }), h('span', { text: money2(subtotal) })),
    discount > 0 ? h('div', { class: 'line pos' }, h('span', { class: 'k', text: t('common.discount') }), h('span', { text: `− ${money2(discount)}` })) : null,
    h('div', { class: 'line' }, h('span', { class: 'k', text: t('common.delivery') }), h('span', { text: delivery > 0 ? money2(delivery) : 'Free' })),
    h('div', { class: 'line total' }, h('span', { text: t('common.total') }), h('span', { text: money2(total) })),
    savings > 0 ? h('div', { class: 'save-line', style: 'margin-top:8px' }, h('span', { html: icons.sparkles }), t('cart.savings', { amt: money2(savings) })) : null);
}

export function emptyState(iconName, title, sub, cta = null) {
  return h('div', { class: 'empty' }, h('div', { html: icons[iconName] || '' }), h('h3', { text: title }), sub ? h('p', { class: 'small', text: sub }) : null, cta);
}

export function skeletonGrid(n = 8) {
  return h('div', { class: 'grid-products' }, ...Array.from({ length: n }, () => h('div', { class: 'sk sk-card' })));
}

export function section(title, right, ...children) {
  return h('section', { class: 'section' },
    title || right ? h('div', { class: 'section-head' }, title ? h('h2', { text: title }) : null, right ? h('div', { class: 'spacer' }, right) : null) : null,
    ...children);
}

export function notice(kind, text, extra = null) {
  const iconName = { info: 'info', warn: 'alert', ok: 'check', bad: 'alert' }[kind] || 'info';
  return h('div', { class: `notice ${kind}` }, h('span', { html: icons[iconName] }), h('div', {}, h('span', { text }), extra));
}

export function pill(text, kind = 'grey') {
  return h('span', { class: `pill ${kind}`, text });
}

export function chipRow(items, selected, onSelect) {
  const buttons = items.map((item) => {
    const btn = h('button', {
      class: 'chip row-scroll',
      type: 'button',
      'aria-pressed': String(item.value === selected),
      onclick: () => {
        for (const other of buttons) other.setAttribute('aria-pressed', String(other === btn));
        onSelect(item.value);
      },
    }, item.label);
    return btn;
  });
  return h('div', { class: 'chips' }, ...buttons);
}

/* -------------------------------------------------------------------- form -- */
/**
 * Declarative form builder shared by every screen:
 *   buildForm([{name,label,type,options,required,hint,autocomplete,step}], {onSubmit, submitLabel})
 * Returns { el, values(), setError(name,msg), clearErrors(), setBusy(bool), root }
 */
export function buildForm(fields, { onSubmit, submitLabel, extra = null, layout = 'stack', buttonsBefore = null } = {}) {
  const controls = new Map();
  const form = h('form', { class: layout, novalidate: true });

  for (const f of fields) {
    if (f.type === 'section') {
      form.append(h('div', { class: 'section-head', style: 'margin-top:' + (f.first ? '0' : '10px') }, h('h3', { text: f.label })));
      continue;
    }
    if (f.type === 'html') { form.append(f.el); continue; }
    let control;
    const id = `f-${f.name}`;
    if (f.type === 'select') {
      control = h('select', { class: 'input', id, name: f.name },
        ...(f.placeholder ? [h('option', { value: '', text: f.placeholder })] : []),
        ...(f.options || []).map((o) => h('option', { value: o.value, text: o.label, ...(String(o.value) === String(f.value ?? '') ? { selected: true } : {}) })));
    } else if (f.type === 'textarea') {
      control = h('textarea', { class: 'input', id, name: f.name, placeholder: f.placeholder || '', rows: f.rows || 3, text: f.value || '' });
    } else if (f.type === 'checkbox') {
      control = h('input', { type: 'checkbox', id, name: f.name, ...(f.value ? { checked: true } : {}) });
    } else {
      control = h('input', {
        class: 'input', id, name: f.name, type: f.type || 'text', value: f.value ?? '',
        placeholder: f.placeholder || '', inputmode: f.inputmode || (f.type === 'number' ? 'decimal' : undefined),
        autocomplete: f.autocomplete || 'off', min: f.min, max: f.max, step: f.step, maxlength: f.maxlength,
        pattern: f.pattern, readonly: f.readonly,
      });
    }
    const error = h('div', { class: 'err-text', hidden: true });
    const wrap = f.type === 'checkbox'
      ? h('label', { class: 'switch' }, control, h('span', { text: f.label }))
      : h('div', { class: 'field' },
        h('label', { for: id, text: f.label + (f.required ? ' *' : f.hint && !f.alwaysShowHint ? '' : '') }),
        control,
        f.hint ? h('div', { class: 'hint', text: f.hint }) : null,
        error);
    controls.set(f.name, { field: f, control, error, wrap });
    if (f.name.startsWith('__')) form.append(wrap);
    else if (f.type === 'checkbox') form.append(wrap, error);
    else form.append(wrap);
  }

  if (buttonsBefore) form.append(buttonsBefore);
  if (extra) form.append(extra);
  if (submitLabel) {
    form.append(h('button', { class: 'btn block', type: 'submit', style: 'margin-top:6px', text: submitLabel }));
  }

  const submitBtn = () => form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    if (onSubmit) {
      setBusy(true);
      try {
        await onSubmit(values(), { setError, setBusy, controls });
      } finally {
        setBusy(false);
      }
    }
  });

  function values() {
    const out = {};
    for (const [name, { field, control }] of controls) {
      if (field.type === 'checkbox') out[name] = control.checked;
      else if (field.type === 'number') out[name] = control.value === '' ? '' : Number(control.value);
      else out[name] = control.value.trim();
    }
    return out;
  }

  function setError(name, message) {
    const c = controls.get(name);
    if (!c) return;
    c.error.hidden = false;
    c.error.textContent = message;
    c.control.classList.add('err');
  }
  function clearErrors() {
    for (const c of controls.values()) {
      c.error.hidden = true;
      c.error.textContent = '';
      c.control.classList.remove('err');
    }
  }
  function setBusy(busy) {
    const btn = submitBtn();
    if (!btn) return;
    btn.dataset.was = btn.textContent;
    btn.textContent = busy ? `${t('common.loading')}` : submitLabel;
    btn.disabled = !!busy;
  }
  function focus(name) {
    controls.get(name)?.control.focus?.();
  }

  return { el: form, root: form, values, setError, clearErrors, setBusy, controls, focus };
}

/** Search input with debounced onInput. */
export function searchField(placeholder, onInput, initialValue = '') {
  const input = h('input', { type: 'search', placeholder, value: initialValue, 'aria-label': t('common.search') });
  const run = debounce(() => onInput(input.value.trim()), 260);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onInput(input.value.trim()); }
    if (e.key === 'Escape') { input.value = ''; onInput(''); }
  });
  const clearBtn = h('button', {
    class: 'iconbtn', type: 'button', 'aria-label': t('common.clear'),
    onclick: () => { input.value = ''; onInput(''); },
    html: icons.close,
  });
  const el = h('div', { class: 'searchbar' }, h('span', { html: icons.search }), input, clearBtn);
  return { el, input };
}

export function kpiCard({ label, value, hint, accent = false, kind = 'money' }) {
  const shown = kind === 'count' ? String(value) : money(Number(value));
  return h('div', { class: `kpi ${accent ? 'accent' : ''}` },
    h('div', { class: 'k', text: label }),
    h('div', { class: 'v', text: shown }),
    hint ? h('div', { class: 'h', text: hint }) : null);
}

export function statusChip(status) {
  const kinds = { placed: 'info', confirmed: 'info', preparing: 'low', out_for_delivery: 'low', delivered: 'ok', cancelled: 'out' };
  return pill(t(`order.status.${status}`), kinds[status] || 'grey');
}

/* --------------------------------------------------------------- page shell -- */
/** Composes header + main (+ bottom tab bar) so every screen shares the chrome. */
export function page({ root, children, header = {}, tab = null, owner = false, ownerNav = null }) {
  const headerEl = owner ? ownerHeader(header, ownerNav) : appHeader(header);
  const main = h('main', { class: `page ${tab ? '' : 'no-tab'}` }, ...children);
  const parts = [headerEl, main];
  if (tab) parts.push(tabbar(tab));
  mount(root, ...parts);
  return { main };
}

/**
 * Owner top-right navigation, exactly as specified: shop open/closed toggle,
 * menu list, wholesale approvals, online payment update, scratch, history, logout.
 */
export function ownerHeader({ title = '', sub = '', level = 'anonymous', shopOpen = true, elevatedUntil = null } = {}, navItems = []) {
  const toggle = h('button', {
    class: 'chip', style: 'margin-right:2px', 'aria-pressed': String(!!shopOpen),
    onclick: () => navItems.find((i) => i.key === 'shop')?.onToggle?.(),
  },
  h('span', { class: `dot ${shopOpen ? 'open' : 'closed'}` }),
  h('span', { class: 'chip-label', text: shopOpen ? t('owner.open') : t('owner.closed') }),
  h('span', { class: 'sr-only', text: t('owner.toggle_shop') }));

  const menuBtn = h('button', { class: 'iconbtn lg', 'aria-label': t('owner.menu'), onclick: () => openOwnerMenu(navItems), html: icons.menu });
  const lockBtn = h('button', {
    class: 'iconbtn', 'aria-label': level === 'admin' ? t('owner.lock') : t('owner.unlock'),
    title: level === 'admin' ? t('owner.unlocked', { n: Math.max(0, Math.round((new Date(`${elevatedUntil || ''}Z`) - Date.now()) / 60000) || 0) }) : t('owner.elevate'),
    onclick: () => navItems.find((i) => i.key === 'lock')?.onToggle?.(),
    html: level === 'admin' ? icons.unlock : icons.lock,
  });
  const logout = h('button', { class: 'iconbtn', 'aria-label': t('owner.logout'), onclick: () => window.smvOwnerLogout?.(), html: icons.logout });

  return h('header', { class: 'appbar' },
    h('div', { class: 'appbar-brand' },
      h('a', { href: '/owner/dashboard', 'data-link': '', style: 'display:flex;gap:9px;align-items:center' },
        h('img', { class: 'brandmark', src: '/img/logo.svg', alt: '', width: 32, height: 32 })),
      h('div', {},
        h('div', { class: 'appbar-title', text: title || t('owner.pin_title') }),
        h('div', { class: 'appbar-sub', text: sub || '' }))),
    h('div', { class: 'appbar-actions' }, toggle, lockBtn, langToggle(), menuBtn, logout));
}

export function openOwnerMenu(navItems) {
  const list = h('div', { class: 'stack' });
  for (const item of navItems) {
    if (item.key === 'shop' || item.key === 'lock') continue;
    list.append(h('button', {
      class: 'entry',
      onclick: () => { handle.close(); item.run?.(); },
    },
      h('span', { class: 'ico', html: icons[item.icon] || icons.chevron }),
      h('div', {},
        h('strong', { text: item.label }),
        item.hint ? h('div', { class: 'small muted', text: item.hint }) : null),
      item.badge ? pill(String(item.badge), item.badgeKind || 'low') : h('span', { class: 'go', html: icons.chevron })));
  }
  const handle = sheet({ title: t('owner.menu'), body: list });
  return handle;
}

/** Small helper so views can render a labelled key/value grid. */
export function kv(pairs) {
  return h('div', { class: 'stack', style: 'gap:6px' },
    ...pairs.filter(Boolean).map(([k, v]) => h('div', { class: 'row', style: 'gap:8px;align-items:baseline' },
      h('span', { class: 'tiny muted', style: 'min-width:92px', text: k }),
      h('span', { class: 'small strong', text: String(v) }))));
}
