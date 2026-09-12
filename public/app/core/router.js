/**
 * Hash-free router with History API. Views are code-split ES modules so the
 * first paint only downloads what the current screen needs — important on a
 * patchy mobile connection.
 */
import { state } from './store.js';

export const routes = [
  { path: '/', view: () => import('../views/landing.js'), chrome: 'none', title: 'Groceries & provisions, T. Nagar' },
  { path: '/login', view: () => import('../views/auth.js'), export: 'loginView', chrome: 'none' },
  { path: '/register', view: () => import('../views/auth.js'), export: 'registerView', chrome: 'none' },
  { path: '/verify', view: () => import('../views/auth.js'), export: 'verifyView', chrome: 'none' },
  { path: '/forgot', view: () => import('../views/auth.js'), export: 'forgotView', chrome: 'none' },
  { path: '/shop', view: () => import('../views/shop.js'), export: 'shopView', chrome: 'customer', auth: false },
  { path: '/product/:id', view: () => import('../views/shop.js'), export: 'productView', chrome: 'customer', auth: false },
  { path: '/cart', view: () => import('../views/cart.js'), export: 'cartView', chrome: 'customer', auth: true, tab: 'cart' },
  { path: '/checkout', view: () => import('../views/cart.js'), export: 'checkoutView', chrome: 'customer', auth: true },
  { path: '/order/:id', view: () => import('../views/cart.js'), export: 'placedView', chrome: 'customer', auth: true },
  { path: '/orders', view: () => import('../views/orders.js'), export: 'ordersView', chrome: 'customer', auth: true, tab: 'orders' },
  { path: '/orders/:id', view: () => import('../views/orders.js'), export: 'orderView', chrome: 'customer', auth: true, tab: 'orders' },
  { path: '/profile', view: () => import('../views/profile.js'), chrome: 'customer', auth: true, tab: 'account' },
  { path: '/addresses', view: () => import('../views/profile.js'), export: 'addressesView', chrome: 'customer', auth: true, tab: 'account' },
  { path: '/owner', view: () => import('../owner/dashboard.js'), export: 'pinView', chrome: 'none' },
  { path: '/owner/dashboard', view: () => import('../owner/dashboard.js'), export: 'dashboardView', chrome: 'owner', owner: true },
  { path: '/owner/menu', view: () => import('../owner/admin.js'), export: 'menuView', chrome: 'owner', owner: true },
  { path: '/owner/approvals', view: () => import('../owner/admin.js'), export: 'approvalsView', chrome: 'owner', owner: true },
  { path: '/owner/payments', view: () => import('../owner/admin.js'), export: 'paymentsView', chrome: 'owner', owner: true },
  { path: '/owner/scratch', view: () => import('../owner/admin.js'), export: 'scratchView', chrome: 'owner', owner: true },
  { path: '/owner/history', view: () => import('../owner/admin.js'), export: 'historyView', chrome: 'owner', owner: true },
  { path: '/owner/messages', view: () => import('../owner/admin.js'), export: 'messagesView', chrome: 'owner', owner: true },
  { path: '/owner/settings', view: () => import('../owner/admin.js'), export: 'settingsView', chrome: 'owner', owner: true },
  { path: '/offline', view: () => import('../views/misc.js'), export: 'offlineView', chrome: 'none' },
];

let current = null;
let mountEl = null;
let refreshers = [];

export function startRouter(root) {
  mountEl = root;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('tel:') || href.startsWith('mailto:') || a.target === '_blank') return;
    e.preventDefault();
    go(href);
  });
  window.addEventListener('popstate', () => render());
  render();
}

export function go(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return render();
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  return render();
}

export function back(fallback = '/') {
  if (history.length > 1) history.back();
  else go(fallback);
}

function match(pathname) {
  for (const route of routes) {
    const routeParts = route.path.split('/').filter(Boolean);
    const given = pathname.split('/').filter(Boolean);
    if (routeParts.length !== given.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < routeParts.length; i += 1) {
      const part = routeParts[i];
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(given[i]);
      else if (part !== given[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

export async function render() {
  const found = match(location.pathname) || { route: routes[0], params: {} };
  const { route, params } = found;
  const query = Object.fromEntries(new URLSearchParams(location.search));

  // Guards: customer routes need a session, owner routes need a PIN session.
  if (route.auth && !state.user) return go(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
  if (route.owner && !state.owner.signedIn) return go('/owner', { replace: true });

  const previous = current;
  current = null;
  previous?.cleanup?.();

  document.body.classList.toggle('owner-shell', route.chrome === 'owner');
  document.documentElement.dataset.chrome = route.chrome || 'customer';

  const mod = await route.view();
  const view = mod[route.export || 'default'];
  if (!view) {
    console.error(`Route ${route.path}: export "${route.export || 'default'}" not found`);
    return;
  }
  document.title = mod.docTitle ? `${mod.docTitle(params, query)} · Sathvika MV` : 'Sathvika MV';

  refreshers = [];
  const ctx = {
    params,
    query,
    go,
    back,
    route,
    /** Re-run on state changes (language toggle, cart mutation). */
    onRefresh: (fn) => refreshers.push(fn),
  };
  mountEl.hidden = false;
  const result = await view(mountEl, ctx);
  current = { route, params, cleanup: typeof result === 'function' ? result : null };
  window.scrollTo(0, 0);
}

/** Called by the store when global state changes; views decide what to redraw. */
export function refreshView() {
  for (const fn of [...refreshers]) {
    try { fn(); } catch (err) { console.error(err); }
  }
}
