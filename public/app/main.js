/**
 * Boot: splash → hydrate session → start router.
 * Also the only place that touches the service worker and the global helpers
 * views use (navigation, language, logout, login prompts).
 */
import { state, set, subscribe, hydrateCustomer, hydrateOwner } from './core/store.js';
import { startRouter, go, refreshView } from './core/router.js';
import { t } from './core/i18n.js';
import { toast } from './core/components.js';
import { api } from './core/api.js';
import { localGet, localSet, sessionGet, sessionSet } from './core/storage.js';

const SPLASH_MS_FIRST = 1700; // as specified: 1.5–2s launch screen
const SPLASH_MS_RETURN = 480;

document.documentElement.lang = state.lang === 'ta' ? 'ta' : 'en';

const splash = document.getElementById('splash');
const appEl = document.getElementById('app');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const firstView = !sessionGet('smv.seen');
const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 240) : ms));

async function boot() {
  const started = Date.now();

  // Fire the boot requests in parallel; the splash covers their latency.
  const bootstrapPromise = api.get('/api/catalog/bootstrap', { silent401: true }).catch(() => null);
  const sessionPromise = Promise.all([hydrateCustomer(), hydrateOwner()]).catch(() => []);

  const [, ] = await Promise.all([
    Promise.race([bootstrapPromise, wait(2600)]),
    sessionPromise,
  ]);

  const bootstrap = await bootstrapPromise;
  if (bootstrap) {
    set({ bootstrap, settings: bootstrap.settings, catalog: { ...state.catalog, scope: bootstrap.scope } });
  }

  const elapsed = Date.now() - started;
  const minimum = firstView ? SPLASH_MS_FIRST : SPLASH_MS_RETURN;
  if (elapsed < minimum) await wait(minimum - elapsed);

  sessionSet('smv.seen', '1');
  splash.classList.add('out');
  startRouter(appEl);
  setTimeout(() => splash.remove(), 520);
  registerServiceWorker();
  offerInstall();
}

/* --------------------------------------------------------- global helpers -- */
window.smvGo = (path, opts) => go(path, opts);
window.smvT = t;

window.smvSetLang = async (lang) => {
  const { setLang } = await import('./core/store.js');
  setLang(lang);
  document.documentElement.lang = lang;
  if (state.user) api.patch('/api/auth/profile', { lang }, { silent401: true }).catch(() => {});
  refreshView();
};

window.smvRequireLogin = (message = t('toast.login_first')) => {
  toast(message, { kind: 'bad' });
  go(`/login?next=${encodeURIComponent(location.pathname)}`);
  return false;
};

window.smvLogout = async () => {
  try {
    await api.post('/api/auth/logout');
  } catch {
    /* already gone */
  }
  set({ user: null, cart: null });
  toast('Signed out. See you soon!', { kind: 'ok' });
  go('/');
};

window.smvOwnerLogout = async () => {
  try {
    await api.post('/api/owner/logout');
  } catch {
    /* already gone */
  }
  set({ owner: { ...state.owner, signedIn: false, level: 'anonymous', dashboard: null } });
  go('/');
};

/** Views call this after any cart mutation so the badge and totals stay honest. */
window.smvCartChanged = (cart) => {
  set({ cart: cart || state.cart });
  if (!cart) {
    api.get('/api/cart', { silent401: true }).then((fresh) => set({ cart: fresh })).catch(() => {});
  }
};

/* --------------------------------------------------------------- PWA bits -- */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  let reloadedForSw = false;
  try {
    const hadController = !!navigator.serviceWorker.controller;
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Ask for a new worker on every app open — otherwise the browser only checks every
    // 24 h and a returning visitor can keep playing last week's build.
    reg.update?.().catch(() => {});
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && hadController) {
          toast('A new version is ready.', { action: { label: 'Reload', run: () => location.reload() }, ms: 8000 });
        }
      });
    });
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // The new worker skipped waiting and claimed this page: reload once so nobody is
        // left staring at a stale shell (which is how “it works but looks wrong” starts).
        if (reloadedForSw) return;
        reloadedForSw = true;
        location.reload();
      });
    }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'catalog-refreshed') refreshView();
    });
  } catch (err) {
    console.warn('service worker unavailable:', err?.message);
  }
}

/** `window.__smvInstall` is read by the profile screen's “Install the app” row. */
let deferredInstall = null;
function setDeferred(event) {
  deferredInstall = event || null;
  try {
    if (event) window.__smvInstall = event;
    else delete window.__smvInstall;
  } catch { /* frozen global in some shims */ }
}
function offerInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    setDeferred(e);
    if (!localGet('smv.install-dismissed')) {
      toast('Install Sathvika MV for one-tap reordering', {
        kind: 'ok',
        ms: 9000,
        action: {
          label: 'Install',
          run: async () => {
            await deferredInstall?.prompt();
            setDeferred(null);
          },
        },
      });
    }
  });
  window.addEventListener('appinstalled', () => {
    localSet('smv.install-dismissed', '1');
    setDeferred(null);
    toast('Installed — the catalogue now works offline too.', { kind: 'ok' });
  });
}

/* ---------------------------------------------------------- live feedback -- */
subscribe((patch) => {
  if ('cart' in patch) patchCartBadge();
  if ('lang' in patch || 'offline' in patch) refreshView();
});

function patchCartBadge() {
  const count = state.cart?.item_count || 0;
  for (const node of document.querySelectorAll('[data-cart-badge]')) {
    node.textContent = String(count);
    node.hidden = count === 0;
    node.closest('.iconbtn')?.setAttribute('aria-label', `${count} ${count === 1 ? 'item' : 'items'} in cart`);
  }
}
window.addEventListener('online', () => {
  set({ offline: false });
  refreshView();
});
window.addEventListener('offline', () => set({ offline: true }));

boot().catch((err) => {
  console.error(err);
  splash?.classList.add('out');
  appEl.hidden = false;
  appEl.innerHTML = '';
  appEl.append(document.createTextNode('Could not start the app. Please refresh.'));
});
