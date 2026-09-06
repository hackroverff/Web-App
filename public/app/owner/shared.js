/** Shared chrome for the owner/counter area: PIN gate helpers, appbar nav, lock controls. */
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { state, set, hydrateOwner } from '../core/store.js';
import { api } from '../core/api.js';
import { page, sheet, buildForm, toast, pill, notice, confirmSheet } from '../core/components.js';
import { go } from '../core/router.js';

export const OWNER_NAV = [
  { key: 'dash', icon: 'grid', path: '/owner/dashboard', label: 'owner.dashboard' },
  { key: 'menu', icon: 'list', path: '/owner/menu', label: 'owner.menu_list', hint: 'owner.menu_hint' },
  { key: 'approvals', icon: 'building', path: '/owner/approvals', label: 'owner.approvals', badge: 'pending_approvals' },
  { key: 'payments', icon: 'wallet', path: '/owner/payments', label: 'owner.payments', badge: 'pending_payments' },
  { key: 'scratch', icon: 'trash', path: '/owner/scratch', label: 'owner.scratch', hint: 'owner.scratch_hint' },
  { key: 'history', icon: 'history', path: '/owner/history', label: 'owner.history' },
  { key: 'messages', icon: 'chat', path: '/owner/messages', label: 'owner.messages' },
  { key: 'settings', icon: 'settings', path: '/owner/settings', label: 'owner.settings' },
];

/**
 * Wraps `page()` with the owner appbar. Loads the shift/dashboard counters once so
 * badges and the OPEN/CLOSED chip are truthful, then hands the view a `model`.
 */
export async function ownerShell(root, { title, sub, tab, children, reload }) {
  const session = await hydrateOwner();
  if (!session?.signed_in) {
    go('/owner', { replace: true });
    return { main: h('div', {}), model: null };
  }
  let model = null;
  try {
    model = await api.get('/api/owner/dashboard');
    set({ owner: { ...state.owner, dashboard: model, shift: model.shift, session } });
  } catch (err) {
    toast(err.message, { kind: 'bad' });
  }

  const nav = navItems(model, { reload, session });
  const rendered = page({
    root,
    tab: tab || null,
    owner: true,
    ownerNav: nav,
    header: {
      title: title || t('owner.title'),
      sub: sub || (model?.shift ? `${t('owner.shift')} #${model.shift.id} · ${t(`owner.level_${state.owner.level}`)}` : t(`owner.level_${state.owner.level}`)),
      level: state.owner.level,
      shopOpen: model?.shop_open !== false,
      elevatedUntil: session?.elevated_until,
    },
    children,
  });
  return { main: rendered.main, model, nav };
}

function navItems(model, { reload, session }) {
  const counts = model || {};
  return [
    {
      key: 'shop',
      onToggle: async () => {
        try {
          const res = await api.post('/api/owner/shop-status', { open: !(counts.shop_open !== false) });
          counts.shop_open = res.shop_open;
          set({ settings: { ...(state.settings || {}), shop_open: res.shop_open } });
          toast(res.message, { kind: res.shop_open ? 'ok' : 'warn' });
          (reload || (() => go(location.pathname)))();
        } catch (err) {
          toast(err.message, { kind: 'bad' });
        }
      },
    },
    {
      key: 'lock',
      onToggle: () => (state.owner.level === 'admin' ? lockNow(reload) : elevate(reload, session)),
    },
    ...OWNER_NAV.map((item) => ({
      key: item.key,
      icon: item.icon,
      label: t(item.label),
      hint: item.hint ? t(item.hint) : null,
      badge: item.badge ? counts[item.badge] || 0 : 0,
      badgeKind: item.badge === 'pending_approvals' ? 'low' : 'info',
      run: () => go(item.path),
    })),
    {
      key: 'shift',
      icon: 'clock',
      label: t('owner.close_shift'),
      hint: model?.summary ? `${model.summary.orders} ${t('owner.orders')} · ${t('common.total')} ₹${Math.round(model.summary.grand_total)}` : null,
      run: () => closeShift(reload),
    },
  ];
}

export async function elevate(onDone, session) {
  const staff = state.owner.staff;
  if (staff && staff.role !== 'owner') {
    return sheet({
      title: t('owner.locked_title'),
      body: notice('warn', 'You are signed in as counter staff, so pricing, approvals and settings stay locked. Ask the owner (Lakshmi) to unlock.'),
    });
  }
  const form = buildForm([
    { name: 'password', label: t('owner.password'), type: 'password', required: true, hint: t('owner.elevate_hint'), autocomplete: 'current-password' },
  ], {
    submitLabel: t('owner.unlock'),
    onSubmit: async (values, { setError }) => {
      try {
        const res = await api.post('/api/owner/elevate', values);
        handle.close();
        toast(res.message, { kind: 'ok' });
        await hydrateOwner();
        (onDone || (() => go(location.pathname)))();
      } catch (err) {
        setError('password', err.message);
      }
    },
  });
  const handle = sheet({
    title: t('owner.elevate'),
    body: h('div', { class: 'stack' },
      h('p', { class: 'small muted', text: 'Prices, product edits, wholesale approvals and store settings need the owner password. Unlock lasts 20 minutes.' }),
      form.el,
      h('div', { class: 'demo-note', text: session?.demo_hint || 'Demo owner password: sathvika@owner2026' })),
  });
  return handle;
}

export async function lockNow(onDone) {
  try {
    const res = await api.post('/api/owner/lock', {});
    toast(res.message, { kind: 'warn' });
    await hydrateOwner();
    (onDone || (() => go(location.pathname)))();
  } catch (err) {
    toast(err.message, { kind: 'bad' });
  }
}

export async function closeShift(onDone) {
  if (!(await confirmSheet({
    title: t('owner.close_shift'),
    message: 'Closing the shift locks today’s totals. Any new order opens a fresh shift automatically.',
    confirmLabel: t('owner.close_shift'),
  }))) return;
  try {
    const res = await api.post('/api/owner/shift/close', {});
    toast(res.message, { kind: 'ok' });
    (onDone || (() => go(location.pathname)))();
  } catch (err) {
    toast(err.message, { kind: 'bad' });
  }
}

/** Banner every owner screen shows: level, expiry countdown, lock/unlock. */
export function elevateBar({ level, minutesLeft, onElevate, onLock, note }) {
  const locked = level !== 'admin';
  return h('div', { class: `elevate-bar ${locked ? 'locked' : ''}` },
    h('span', { class: 'ico', html: locked ? '🔒' : '🔓' }),
    h('div', { style: 'flex:1' },
      h('div', { class: 'small strong', text: locked ? t('owner.locked_title') : t('owner.unlocked', { n: minutesLeft }) }),
      h('div', { class: 'tiny', text: note || (locked ? t('owner.locked_sub') : t('owner.unlocked_sub')) })),
    h('button', { class: 'btn sm', text: locked ? t('owner.unlock') : t('owner.lock'), onclick: locked ? onElevate : onLock }));
}

export function ownerPill(text, kind) {
  return pill(text, kind);
}

export { mount };
