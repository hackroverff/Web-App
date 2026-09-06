/**
 * Sathvika MV service worker.
 * Strategy by request type — the important part is that money never comes from cache:
 *   • app shell + styles + icons + product art → cache-first (offline catalogue browsing)
 *   • GET /api/catalog/* → stale-while-revalidate (browsing while the network is bad)
 *   • everything else under /api/ (cart, orders, owner) → network only, never stored
 *   • navigations → network, falling back to the cached shell
 */
const VERSION = 'smv-v7';
const SHELL = [
  '/',
  '/index.html',
  '/styles/app.css',
  '/manifest.webmanifest',
  '/img/logo.svg',
  '/img/logo.png',
  '/img/products/placeholder-1.svg',
  '/img/icon-192.png',
  '/img/icon-512.png',
  '/app/main.js',
  '/app/core/dom.js',
  '/app/core/icons.js',
  '/app/core/api.js',
  '/app/core/store.js',
  '/app/core/storage.js',
  '/app/core/session-check.js',
  '/app/core/i18n.js',
  '/app/core/format.js',
  '/app/core/components.js',
  '/app/core/router.js',
  '/app/views/landing.js',
  '/app/views/auth.js',
  '/app/views/shop.js',
  '/app/views/cart.js',
  '/app/views/orders.js',
  '/app/views/profile.js',
  '/app/views/misc.js',
  '/app/owner/shared.js',
  '/app/owner/dashboard.js',
  '/app/owner/admin.js',
];
const CATALOG_MAX_AGE_MS = 5 * 60 * 1000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // One missing file (e.g. the generated PNG icons) must not cost us the whole shell.
      // cache: 'reload' bypasses the HTTP cache so an updated shell is always the fresh one.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isCatalogGet = (url) => url.pathname.startsWith('/api/catalog/') && !url.pathname.includes('/cart');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    if (!isCatalogGet(url)) return; // cart/orders/owner/auth: always live
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || Response.error())),
    );
    return;
  }

  // Modules, styles and generated artwork are not content-hashed, so they go to the network
  // first. Cache-first here is how "the fix isn't working" happens: the worker answers from its
  // own copy, never asks the server, and a visitor stays on an old build through any number of
  // reloads. These are already served with `no-cache`, so a hit is a cheap 304 — and the cache
  // still answers when the network is gone.
  if (/^(\/app\/|\/styles\/|\/img\/products\/|\/img\/categories\/)/.test(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => caches.match('/img/products/placeholder-1.svg') || Response.error()),
    ),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    // A missing module offline is a broken page, not a missing picture.
    if (new URL(req.url).pathname.startsWith('/app/')) return Response.error();
    return caches.match('/img/products/placeholder-1.svg');
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const key = new Request(req.url, { headers: { 'x-smv': '1' } });
  const cached = await cache.match(key);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(key, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  if (cached) {
    network.then(() => notifyClients({ type: 'catalog-refreshed' }));
    return cached;
  }
  const fresh = await network;
  if (fresh) cache.put(key, fresh.clone()).catch(() => {});
  return fresh || Response.error();
}

async function notifyClients(message) {
  const list = await self.clients.matchAll({ type: 'window' });
  for (const client of list) client.postMessage(message);
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});
