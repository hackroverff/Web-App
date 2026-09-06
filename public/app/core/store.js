/** App state + a couple of actions. Deliberately tiny: views own their local state. */
const LS_LANG = 'smv.lang';

export const state = {
  user: null,
  cart: null,
  settings: null,
  bootstrap: null,
  lang: localStorage.getItem(LS_LANG) || 'en',
  offline: !navigator.onLine,
  booted: false,
  owner: { signedIn: false, level: 'anonymous', staff: null, shift: null, dashboard: null, session: null },
  catalog: { q: '', category: null, brand: null, minPrice: '', maxPrice: '', sort: 'featured', results: null, page: 1 },
};

const listeners = new Set();

export function set(patch) {
  // Never let a partial API response blank out state the app still needs.
  const clean = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
  Object.assign(state, clean);
  patch = clean;
  for (const fn of listeners) {
    try {
      fn(patch);
    } catch (err) {
      console.error(err);
    }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLang(lang) {
  state.lang = lang === 'ta' ? 'ta' : 'en';
  localStorage.setItem(LS_LANG, state.lang);
  document.documentElement.lang = state.lang;
  set({});
}

export const isWholesale = () => state.user?.pricing_scope === 'wholesale';
export const isWholesalePending = () => !!state.user?.wholesale_pending;
export const cartCount = () => state.cart?.item_count || 0;
export const shopOpen = () => state.settings?.shop_open !== false;

/** Loads the signed-in customer (silently) — used on boot and after login. */
export async function hydrateCustomer() {
  const { api } = await import('./api.js');
  try {
    const me = await api.get('/api/auth/me', { silent401: true });
    set({ user: me.user, cart: me.cart, settings: me.settings || state.settings });
    return me;
  } catch {
    set({ user: null, cart: null });
    return null;
  }
}

export async function hydrateOwner() {
  const { api } = await import('./api.js');
  try {
    const s = await api.get('/api/owner/session', { silent401: true });
    set({ owner: { ...state.owner, signedIn: !!s.signed_in, level: s.level || 'anonymous', staff: s.staff || null, shift: s.shift || null, session: s } });
    return s;
  } catch {
    set({ owner: { ...state.owner, signedIn: false, level: 'anonymous' } });
    return null;
  }
}

export async function refreshCart() {
  if (!state.user) return null;
  const { api } = await import('./api.js');
  try {
    const cart = await api.get('/api/cart');
    set({ cart });
    return cart;
  } catch {
    return null;
  }
}
