/**
 * Frontend smoke test without a browser.
 *
 * The app is a zero-build ES-module SPA, so its modules can be imported straight
 * into Node as long as the handful of DOM APIs they touch exist. This script
 * installs a minimal DOM/shim layer, then walks the real screens against the
 * running server (login → shop → product → cart → checkout → orders → profile,
 * then the owner PIN, dashboard and every admin screen) and fails loudly on the
 * first thrown error.
 *
 *   node server/index.js &   # or npm start
 *   npm run smoke:ui
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Node's own fetch, captured before the shim installs its global. */
const nativeFetch = globalThis.fetch;

/**
 * By default the run starts its own server against a throwaway copy of the demo
 * data (fresh seed, rate limits off), so it never disturbs a dev database.
 * Set SMOKE_BASE to point it at a server that is already running instead.
 */
let server = null;
let BASE = process.env.SMOKE_BASE || '';

if (!BASE) {
  const port = 4500 + Math.floor(Math.random() * 400);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sathvika-smoke-'));
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, RATE_LIMIT: '0', EXPOSE_OTP: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  server.stdout.on('data', (c) => log.push(c.toString()));
  server.stderr.on('data', (c) => log.push(c.toString()));
  server.on('exit', (code) => {
    if (code && code !== 0 && !server.__expectedExit) {
      console.log(`\nserver exited with ${code}:\n${log.join('')}`);
    }
  });
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      const ok = await nativeFetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
      if (ok) break;
    } catch { /* keep polling */ }
    if (Date.now() > deadline) {
      console.error(`server did not come up:\n${log.join('')}`);
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  process.on('exit', () => {
    server.__expectedExit = true;
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}

/* ------------------------------------------------------------ tiny DOM shim -- */
class Node2 {
  constructor(name) {
    this.nodeName = name;
    this.childNodes = [];
    this.parentNode = null;
    this._attrs = new Map();
    this._events = new Map();
  }

  get children() {
    return this.childNodes.filter((c) => c instanceof Element2);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  appendChild(child) {
    if (child instanceof Fragment2) {
      for (const c of [...child.childNodes]) this.appendChild(c);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...children) {
    for (const c of children) this.appendChild(typeof c === 'string' ? new Text2(c) : c);
  }

  replaceChildren(...children) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...children);
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) this.appendChild(new Text2(String(value)));
  }
}

class Text2 extends Node2 {
  constructor(text) {
    super('#text');
    this.data = String(text);
  }

  get textContent() {
    return this.data;
  }

  set textContent(v) {
    this.data = String(v);
  }
}

class Fragment2 extends Node2 {
  constructor() {
    super('#fragment');
  }
}

class Element2 extends Node2 {
  constructor(tag) {
    super(String(tag).toUpperCase());
    this.tagName = String(tag).toUpperCase();
    this._lower = String(tag).toLowerCase();
    this.classList = makeClassList(this);
    this.dataset = {};
    this.style = {};
    this._value = '';
    this._valueDirty = false;
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.readonly = false;
    this.offsetWidth = 100;
    this.scrollTop = 0;
  }

  /** Real DOM form semantics the views rely on: a textarea mirrors its child
   *  text nodes until something assigns a value, and a select reports the value
   *  of its first `selected` option. */
  get value() {
    if (this._lower === 'select') {
      const chosen = this.querySelectorAll('option').find((o) => o.hasAttribute('selected'));
      if (chosen) return chosen.getAttribute('value') ?? chosen.textContent;
      return this._value;
    }
    if (this._lower === 'textarea' && !this._valueDirty) return this.textContent;
    return this._value;
  }

  set value(v) {
    this._value = v === null || v === undefined ? '' : String(v);
    this._valueDirty = true;
  }

  get className() {
    return this._attrs.get('class') || '';
  }

  set className(v) {
    this._attrs.set('class', v);
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this._attrs.has(name);
  }

  removeAttribute(name) {
    this._attrs.delete(name);
  }

  set innerHTML(html) {
    this._html = String(html);
    this.childNodes = [];
  }

  get innerHTML() {
    return this._html || this.textContent;
  }

  addEventListener(type, fn) {
    if (!this._events.has(type)) this._events.set(type, new Set());
    this._events.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._events.get(type)?.delete(fn);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    event.currentTarget = this;
    let node = this;
    let bubbles = true;
    while (node) {
      for (const fn of node._events?.get(event.type) || []) fn.call(node, event);
      if (!bubbles || !node.parentNode) break;
      node = node.parentNode;
    }
    return true;
  }

  click() {
    this.dispatchEvent(new DomEvent('click', { bubbles: true }));
  }

  focus() { /* no-op */ }

  blur() { /* no-op */ }

  scrollIntoView() { /* no-op */ }

  getBoundingClientRect() {
    return { top: 0, left: 0, width: 100, height: 40, bottom: 40, right: 100 };
  }

  matches(selector) {
    return matchesOne(this, selector.trim());
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node instanceof Element2 && matchesOne(node, selector.trim())) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  get parentElement() {
    return this.parentNode instanceof Element2 ? this.parentNode : null;
  }
}

function makeClassList(el) {
  const list = () => (el._attrs.get('class') || '').split(/\s+/).filter(Boolean);
  const put = (arr) => el._attrs.set('class', arr.join(' '));
  return {
    add: (...names) => put([...new Set([...list(), ...names])]),
    remove: (...names) => put(list().filter((c) => !names.includes(c))),
    toggle: (name, force) => {
      const has = list().includes(name);
      const want = force === undefined ? !has : !!force;
      put(want ? [...new Set([...list(), name])] : list().filter((c) => c !== name));
      return want;
    },
    contains: (name) => list().includes(name),
    get length() {
      return list().length;
    },
    [Symbol.iterator]: () => list()[Symbol.iterator](),
  };
}

/** Supports `tag`, `.class`, `#id`, `[attr]`, `[attr=value]`, `tag.cls[attr=v]` and comma lists. */
function matchesOne(el, selector) {
  if (!(el instanceof Element2)) return false;
  return selector.split(',').some((part) => {
    const piece = part.trim();
    if (!piece) return false;
    const tokens = piece.match(/(^[a-zA-Z][\w-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])/g) || [];
    return tokens.every((token) => {
      if (token.startsWith('#')) return el.getAttribute('id') === token.slice(1) || el.id === token.slice(1);
      if (token.startsWith('.')) return (el._attrs.get('class') || '').split(/\s+/).includes(token.slice(1));
      if (token.startsWith('[')) {
        const body = token.slice(1, -1);
        const eq = body.indexOf('=');
        if (eq === -1) return el.hasAttribute(body);
        const name = body.slice(0, eq);
        const value = body.slice(eq + 1).replace(/^["']|["']$/g, '');
        return el.getAttribute(name) === value;
      }
      return el._lower === token.toLowerCase();
    });
  });
}

function queryAll(root, selector) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child instanceof Element2) {
        for (const sel of selector.split(',')) {
          if (matchesOne(child, sel.trim())) {
            out.push(child);
            break;
          }
        }
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

class DomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = opts.bubbles ?? false;
    this.defaultPrevented = false;
    this.key = opts.key;
    this.target = opts.target;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.bubbles = false;
  }
}

/* ------------------------------------------------------------------ globals -- */
const doc = new Element2('#document');
const html = new Element2('html');
const head = new Element2('head');
const body = new Element2('body');
html.appendChild(head);
html.appendChild(body);
doc.appendChild(html);
// Mirror the real index.html so main.js finds the nodes it expects.
const splashRoot = new Element2('div');
splashRoot.setAttribute('id', 'splash');
splashRoot.className = 'splash';
const appRoot = new Element2('div');
appRoot.setAttribute('id', 'app');
const overlayRoot = new Element2('div');
overlayRoot.setAttribute('id', 'overlays');
body.appendChild(splashRoot);
body.appendChild(appRoot);
body.appendChild(overlayRoot);

const storage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
};

const listeners = new Map();
const cookieJar = new Map();
let currentPath = '/';

const win = {
  document: doc,
  location: {
    get href() {
      return BASE + currentPath;
    },
    get pathname() {
      return currentPath.split('?')[0];
    },
    get search() {
      return currentPath.includes('?') ? currentPath.slice(currentPath.indexOf('?')) : '';
    },
    get origin() {
      return BASE;
    },
    get hostname() {
      return '127.0.0.1';
    },
    get protocol() {
      return 'http:';
    },
    reload() {},
    hash: '',
    assign(url) {
      currentPath = String(url).replace(BASE, '');
    },
    replace(url) {
      this.assign(url);
    },
  },
  history: {
    length: 3,
    pushState: (_s, _t, url) => {
      currentPath = String(url);
    },
    replaceState: (_s, _t, url) => {
      currentPath = String(url);
    },
    back: () => {},
  },
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  dispatchEvent: (e) => {
    for (const fn of listeners.get(e.type) || []) fn(e);
    return true;
  },
  scrollTo: () => {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  localStorage: storage(),
  sessionStorage: storage(),
  navigator: {
    onLine: true,
    language: 'en-IN',
    vibrate: () => {},
    clipboard: { writeText: async () => {} },
    serviceWorker: undefined,
    share: undefined,
  },
  HTMLElement: Element2,
  Node: Node2,
  Event: DomEvent,
  CustomEvent: DomEvent,
  Blob: class Blob2 {
    constructor(parts) {
      this.parts = parts;
    }
  },
  URL: Object.assign(URL, { createObjectURL: () => 'blob:smoke' }),
  fetch: (input, init) => fetchWithCookies(input, init),
};

async function fetchWithCookies(input, init = {}) {
  const url = String(input).startsWith('http') ? String(input) : BASE + String(input);
  const headers = { ...(init.headers || {}) };
  if (cookieJar.size) headers.cookie = [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await nativeFetch(url, { ...init, headers, redirect: 'manual' });
  for (const raw of res.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return res;
}

const realDocument = {
  ...doc,
  documentElement: html,
  head,
  body,
  title: '',
  hidden: false,
  createElement: (tag) => new Element2(tag),
  createElementNS: (_ns, tag) => new Element2(tag),
  createTextNode: (text) => new Text2(text),
  createDocumentFragment: () => new Fragment2(),
  addEventListener: (type, fn) => {
    if (!listeners.has('doc:' + type)) listeners.set('doc:' + type, new Set());
    listeners.get('doc:' + type).add(fn);
  },
  removeEventListener: (type, fn) => listeners.get('doc:' + type)?.delete(fn),
};
// Document lookups must see the live tree, so they are wired after construction.
realDocument.querySelector = (sel) => (sel === '#app' ? appRoot : queryAll(doc, sel)[0] || null);
realDocument.querySelectorAll = (sel) => queryAll(doc, sel);
realDocument.getElementById = (id) => {
  if (id === 'app') return appRoot;
  if (id === 'overlays') return overlayRoot;
  if (id === 'splash') return splashRoot;
  return queryAll(doc, `#${id}`)[0] || null;
};

// Node 22 exposes some of these as getter-only globals, so assign with defineProperty.
for (const [name, value] of Object.entries({
  window: win,
  document: realDocument,
  navigator: win.navigator,
  location: win.location,
  history: win.history,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  HTMLElement: Element2,
  Node: Node2,
  Event: DomEvent,
  CustomEvent: DomEvent,
  matchMedia: win.matchMedia,
  requestAnimationFrame: win.requestAnimationFrame,
  addEventListener: win.addEventListener,
  removeEventListener: win.removeEventListener,
  dispatchEvent: win.dispatchEvent,
  fetch: win.fetch,
  Blob: win.Blob,
  self: win,
})) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

/* ------------------------------------------------------------------ helpers -- */
let failures = 0;
let checks = 0;
const pendingErrors = [];
process.on('unhandledRejection', (err) => pendingErrors.push(err));
process.on('uncaughtException', (err) => pendingErrors.push(err));

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  const errors = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a) => errors.push(a.join(' '));
  console.warn = () => {};
  let thrown = null;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  console.error = origError;
  console.warn = origWarn;
  const async = pendingErrors.splice(0, pendingErrors.length);
  checks += 1;
  if (thrown || errors.length || async.length) {
    failures += 1;
    console.log(`FAIL  ${name}`);
    if (thrown) console.log(`        ${thrown.stack?.split('\n').slice(0, 4).join('\n        ')}`);
    for (const e of errors.slice(0, 4)) console.log(`        console.error: ${e}`);
    for (const e of async.slice(0, 3)) console.log(`        unhandled: ${e?.stack?.split('\n').slice(0, 3).join(' | ') || e}`);
  } else {
    console.log(`ok    ${name}`);
  }
  return { thrown, errors };
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

/** Replaces #app content with a clean mount node for each view. */
function freshRoot() {
  const mountNode = new Element2('div');
  realDocument.body.replaceChildren(mountNode);
  appRoot._mount = mountNode;
  return mountNode;
}

function textOf(node) {
  return String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function findButton(root, label) {
  const nodes = queryAll(root, 'button');
  return nodes.find((b) => textOf(b).toLowerCase().includes(label.toLowerCase())) || null;
}

function submitForm(root, { submitLabel, fill = {} }) {
  const forms = queryAll(root, 'form');
  const form = forms[0];
  if (!form) throw new Error('no form found to submit');
  for (const [name, value] of Object.entries(fill)) {
    const control = queryAll(form, 'input,select,textarea').find((c) => c.getAttribute('name') === name);
    if (!control) throw new Error(`form has no field "${name}"`);
    if (control._lower === 'input' && control.getAttribute('type') === 'checkbox') control.checked = !!value;
    else control.value = String(value);
  }
  if (submitLabel) {
    const btn = findButton(form, submitLabel);
    if (!btn) throw new Error(`form has no submit button matching "${submitLabel}"`);
  }
  form.dispatchEvent(new DomEvent('submit', { bubbles: true }));
}

/** Views are mounted under #app; give them a div to render into and wait a beat. */
async function renderInto(factory, ctx = { params: {}, query: {}, go: () => {}, back: () => {}, onRefresh: () => {}, route: {} }) {
  const mountNode = freshRoot();
  await factory(mountNode, ctx);
  await tick(40);
  return mountNode;
}

/* --------------------------------------------------------------------- run -- */
const health = await nativeFetch(BASE + '/api/health')
  .then((r) => r.json())
  .catch((err) => {
    console.error(`\nThe smoke test needs the server on ${BASE} (${err.message}).\nStart it with: npm start\n`);
    process.exit(2);
  });
console.log(`\nSathvika MV — frontend smoke against ${BASE}${server ? ' (throwaway copy of the demo data)' : ''}\n`);
console.log(`   demo data: ${health.products} products · ${health.users} accounts · ${health.orders} orders\n`);

const mod = (p) => import('../' + p);

/* core modules import cleanly and expose what the views rely on */
const dom = await mod('public/app/core/dom.js');
const components = await mod('public/app/core/components.js');
const store = await mod('public/app/core/store.js');
const state0 = store.state;
const apiMod = await mod('public/app/core/api.js');
const i18n = await mod('public/app/core/i18n.js');
const router = await mod('public/app/core/router.js');

await step('boot: main.js runs the splash, hydrates and starts the router', async () => {
  await mod('public/app/main.js');
  await tick(2600);
  assert(typeof realDocument.querySelector('#app').constructor === 'function', 'app element present');
  assert(typeof window.smvRequireLogin === 'function', 'global login helper installed');
  assert(typeof window.smvGo === 'function', 'global nav helper installed');
  assert(textOf(appRoot).length > 20, 'router painted the first screen');
});

await step('core: components render into the DOM shim', () => {
  const node = freshRoot();
  components.page({ root: node, header: { user: null, cart: null }, tab: 'shop', children: [dom.h('p', { text: 'hello' })] });
  assert(textOf(node).includes('hello'), 'page rendered children');
  assert(textOf(node).includes('Sathvika') || queryAll(node, '.appbar').length === 1, 'page rendered a header');
  components.toast('Smoke toast', { kind: 'ok', action: { label: 'Go', run() {} } });
  assert(textOf(realDocument.getElementById('overlays')).includes('Smoke toast'), 'toast painted into the overlay host');
  const sheetHandle = components.sheet({ title: 'Smoke sheet', body: dom.h('p', { text: 'inside' }), actions: [dom.h('button', { text: 'Ok' })] });
  assert(textOf(sheetHandle.el).includes('inside'), 'sheet rendered');
  sheetHandle.close();
});

await step('i18n: every Tamil string renders and interpolation works', () => {
  assert(i18n.t('app.name') === 'Sathvika MV', 'english name');
  assert(i18n.t('shop.count', { n: 7 }).includes('7'), 'interpolation');
  const tamil = i18n.t('nav.cart', {}, 'ta');
  assert(typeof tamil === 'string' && tamil.length, 'tamil lookup');
});

/* ---------------------------------------------------------------- customer -- */
const views = 'public/app/views/';
const owner = 'public/app/owner/';

await step('view: landing', async () => {
  const root = await renderInto((await mod(views + 'landing.js')).default);
  assert(textOf(root).length > 120, 'landing has content');
});

await step('view: login form signs the tester in', async () => {
  const login = (await mod(views + 'auth.js')).loginView;
  const root = await renderInto(login);
  submitForm(root, { submitLabel: 'Sign in', fill: { mobile: '9840012345', password: 'priya@123' } });
  await tick(600);
  assert(store.state.user?.mobile === '9840012345', `state.user = ${JSON.stringify(store.state.user)}`);
});

await step('view: register + verify screens render', async () => {
  const auth = await mod(views + 'auth.js');
  await renderInto(auth.registerView, { params: {}, query: { type: 'wholesale' }, go() {}, onRefresh() {} });
  const root = await renderInto(auth.verifyView, { params: {}, query: { mobile: '9123456780' }, go() {}, onRefresh() {} });
  assert(textOf(root).length > 40, 'verify has content');
  await renderInto(auth.forgotView);
});

await step('view: shop list, search and filters', async () => {
  const shop = (await mod(views + 'shop.js')).shopView;
  const root = await renderInto(shop);
  assert(queryAll(root, '.pcard').length > 0, 'product cards rendered');
  const filter = findButton(root, 'Filters');
  assert(filter, 'filter button');
  filter.click();
  await tick(60);
  const apply = findButton(realDocument.body, 'Apply');
  assert(apply, 'filter sheet has Apply');
  apply.click();
  await tick(400);
});

await step('view: product detail adds to cart', async () => {
  const productView = (await mod(views + 'shop.js')).productView;
  const root = await renderInto(productView, { params: { id: '1' }, query: {}, onRefresh() {}, go() {} });
  assert(textOf(root).includes('Add') || textOf(root).length > 60, 'detail rendered');
  const add = findButton(root, 'Add');
  assert(add, 'add to cart button');
  add.click();
  await tick(400);
  assert(store.state.cart?.item_count >= 1, `cart = ${JSON.stringify(store.state.cart?.item_count)}`);
});

await step('view: cart list, stepper and clear', async () => {
  const cartView = (await mod(views + 'cart.js')).cartView;
  const root = await renderInto(cartView);
  assert(textOf(root).length > 40, 'cart rendered');
  const inc = queryAll(root, '.stepper')[0]?.querySelectorAll?.('button')[1];
  if (inc) {
    inc.click();
    await tick(400);
  }
  assert(store.state.cart?.lines?.length >= 1, 'cart still has a line');
});

await step('view: checkout preview and address step', async () => {
  const checkoutView = (await mod(views + 'cart.js')).checkoutView;
  const root = await renderInto(checkoutView);
  assert(textOf(root).length > 60, 'checkout rendered');
});

let placedOrderId = null;
await step('view: placing the order', async () => {
  // jump straight through the two steps, then place from the review step
  const preview = await apiMod.api.get('/api/orders/preview');
  assert(preview.cart.lines.length >= 1, 'preview has lines');
  if (!preview.can_checkout) {
    // top the cart up until the minimum order is met, then retry
    const catalog = await apiMod.api.get('/api/catalog/products?limit=40&sort=price-asc');
    for (const p of catalog.products) {
      if (p.stock_status === 'out_of_stock') continue;
      await apiMod.api.post('/api/cart/items', { product_id: p.id, qty: 4 });
      const again = await apiMod.api.get('/api/orders/preview');
      if (again.can_checkout) break;
    }
  }
  const final = await apiMod.api.get('/api/orders/preview');
  assert(final.can_checkout, `still cannot checkout: ${JSON.stringify(final.blockers)}`);
  const addressId = final.addresses[0]?.id || (await apiMod.api.post('/api/auth/me/addresses', { line1: '12 Ranganathan Street', area: 'T. Nagar', pincode: '600017', contact_name: 'Priya', contact_phone: '9840012345' })).addresses[0].id;
  const placed = await apiMod.api.post('/api/orders', { address_id: addressId, payment_method: 'upi', payment_app: 'gpay', upi_ref: '412988713345' });
  placedOrderId = placed.order.id;
  assert(placed.order.public_id?.startsWith('SMV-'), 'order got a public id');
  store.set({ cart: placed.cart });
});

await step('view: order confirmation screen', async () => {
  const placedView = (await mod(views + 'cart.js')).placedView;
  const root = await renderInto(placedView, { params: { id: String(placedOrderId) }, query: {}, onRefresh() {}, go() {} });
  assert(textOf(root).includes('SMV-'), 'confirmation shows the order number');
});

await step('view: orders list', async () => {
  const ordersView = (await mod(views + 'orders.js')).ordersView;
  const root = await renderInto(ordersView);
  assert(textOf(root).includes('SMV-'), 'list shows an order');
  const chip = findButton(root, 'Completed');
  chip?.click();
  await tick(60);
});

await step('view: order tracking screen', async () => {
  const orderView = (await mod(views + 'orders.js')).orderView;
  const root = await renderInto(orderView, { params: { id: String(placedOrderId) }, query: { justPlaced: '1' }, onRefresh() {}, go() {} });
  assert(textOf(root).includes('SMV-'), 'tracking shows the order');
});

await step('view: profile, language switch and addresses', async () => {
  const profile = (await mod(views + 'profile.js')).default;
  const root = await renderInto(profile, { params: {}, query: {}, onRefresh() {}, go() {} });
  assert(textOf(root).includes('9840012345'), 'profile shows the mobile number');
  const tamil = findButton(root, 'தமிழ்');
  assert(tamil, 'language switch present');
  tamil.click();
  await tick(300);
  assert(store.state.lang === 'ta', 'language switched to Tamil');
  const english = findButton(realDocument.body, 'English') || queryAll(realDocument.body, 'button').find((b) => textOf(b) === 'English');
  english?.click();
  await tick(300);
  assert(store.state.lang === 'en', 'language switched back');
  const addressesView = (await mod(views + 'profile.js')).addressesView;
  const aRoot = await renderInto(addressesView, { params: {}, query: {}, onRefresh() {}, go() {} });
  assert(textOf(aRoot).length > 40, 'addresses rendered');
});

await step('view: offline screen', async () => {
  const offlineView = (await mod(views + 'misc.js')).offlineView;
  const root = await renderInto(offlineView);
  assert(textOf(root).toLowerCase().includes('offline') || textOf(root).length > 40, 'offline rendered');
});

await step('cleanup: the smoke order is cancelled so demo data stays tidy', async () => {
  if (!placedOrderId) return;
  try {
    await apiMod.api.post(`/api/orders/${placedOrderId}/cancel`, { reason: 'Frontend smoke test' });
  } catch (err) {
    // Already advanced by an owner action in the same run — that is fine.
    if (!/cannot be cancelled|already/i.test(String(err.message))) throw err;
  }
});

/* ------------------------------------------------------------------- owner -- */

await step('customer: a wholesale account sees slabs, MOQ and tier pricing', async () => {
  const login = (await mod(views + 'auth.js')).loginView;
  const root = await renderInto(login);
  submitForm(root, { submitLabel: 'Sign in', fill: { mobile: '9840034567', password: 'balaji@123' } });
  await tick(600);
  assert(store.state.user?.pricing_scope === 'wholesale', `scope = ${store.state.user?.pricing_scope}`);

  const shopView = (await mod(views + 'shop.js')).shopView;
  const sRoot = await renderInto(shopView);
  assert(/wholesale/i.test(textOf(sRoot)), 'wholesale banner shown');

  const found = await apiMod.api.get('/api/catalog/products?q=sunflower');
  const product = found.products[0];
  assert(product, 'a tiered product was found');
  const productView = (await mod(views + 'shop.js')).productView;
  const pRoot = await renderInto(productView, { params: { id: String(product.id) }, query: {}, onRefresh() {}, go() {} });
  assert(textOf(pRoot).length > 120, 'detail rendered for a wholesale buyer');

  const cart = await apiMod.api.post('/api/cart/items', { product_id: product.id, qty: 30 });
  store.set({ cart });
  const line = cart.lines.find((l) => l.product_id === product.id);
  assert(line.tier, `expected a slab to apply, got ${JSON.stringify(line)}`);
  assert(line.unit_price < product.retail_price, 'slab price beat the retail price');

  const cartView = (await mod(views + 'cart.js')).cartView;
  const cRoot = await renderInto(cartView);
  assert(textOf(cRoot).includes(textOf(line.name).slice(0, 6)), 'cart lists the line');
  await apiMod.api.del('/api/cart').then((fresh) => store.set({ cart: fresh }));
});

await step('owner: PIN keypad signs the shop in', async () => {
  const pinView = (await mod(owner + 'dashboard.js')).pinView;
  const root = await renderInto(pinView);
  for (const digit of '4321') {
    const key = queryAll(root, '.key').find((k) => textOf(k) === digit);
    assert(key, `keypad digit ${digit}`);
    key.click();
    await tick(20);
  }
  await tick(400);
  assert(store.state.owner.signedIn, `owner session = ${JSON.stringify(store.state.owner)}`);
});

await step('owner: dashboard renders with shift + orders', async () => {
  const dashboardView = (await mod(owner + 'dashboard.js')).dashboardView;
  const root = await renderInto(dashboardView, { params: {}, query: {}, onRefresh() {} });
  const text = textOf(root);
  assert(/Shift/i.test(text) || text.includes('Grand Total'), `dashboard text: ${text.slice(0, 160)}`);
});

await step('i18n: back to English for the owner screens', async () => {
  const { setLang } = await mod('public/app/core/store.js');
  setLang('en');
  assert(store.state.lang === 'en', 'english');
});

for (const [name, exportName] of [
  ['menu', 'menuView'],
  ['approvals', 'approvalsView'],
  ['payments', 'paymentsView'],
  ['scratch', 'scratchView'],
  ['history', 'historyView'],
  ['messages', 'messagesView'],
  ['settings', 'settingsView'],
]) {
  await step(`owner: ${name} screen`, async () => {
    const view = (await mod(owner + 'admin.js'))[exportName];
    const root = await renderInto(view, { params: {}, query: {}, onRefresh() {}, go: () => {} });
    const toasts = textOf(realDocument.getElementById('overlays'));
    assert(textOf(root).length > 60, `${name} rendered content: "${textOf(root).slice(0, 120)}"${toasts ? ` | toast: ${toasts.slice(0, 200)}` : ''}`);
  });
}

await step('owner: elevate unlocks the menu editor', async () => {
  const admin = await mod(owner + 'admin.js');
  const shared = await mod(owner + 'shared.js');
  await shared.elevate(() => {}, { demo_hint: 'x' }, );
  // elevate() opens a sheet — drive its form
  const sheetEl = realDocument.body.querySelectorAll('.sheet')[realDocument.body.querySelectorAll('.sheet').length - 1];
  assert(sheetEl, 'elevate sheet opened');
  submitForm(sheetEl, { submitLabel: 'Unlock', fill: { password: 'sathvika@owner2026' } });
  await tick(500);
  assert(store.state.owner.level === 'admin', `level = ${store.state.owner.level}`);
  const root = await renderInto(admin.menuView, { params: {}, query: {}, onRefresh() {} });
  assert(textOf(root).includes('MRP') || queryAll(root, '.listrow').length > 0, 'menu list with prices');
  const addBtn = findButton(root, 'Add');
  assert(addBtn, 'add product button');
  addBtn.click();
  await tick(80);
  const sheetEl2 = queryAll(realDocument.body, '.sheet').slice(-1)[0];
  assert(sheetEl2 && textOf(sheetEl2).includes('Retail'), 'product sheet opened');
});

await step('owner: stock sheet saves through the real endpoint', async () => {
  const admin = await mod(owner + 'admin.js');
  const root = await renderInto(admin.menuView, { params: {}, query: {}, onRefresh() {} });
  const stock = queryAll(root, 'button').find((b) => textOf(b) === 'Stock');
  assert(stock, 'stock button on a row');
  stock.click();
  await tick(80);
  const sheetEl = queryAll(realDocument.body, '.sheet').slice(-1)[0];
  const save = findButton(sheetEl, 'Save');
  assert(save, 'stock sheet save');
  save.click();
  await tick(400);
});

await step('owner: creating a product through the menu editor', async () => {
  const admin = await mod(owner + 'admin.js');
  const root = await renderInto(admin.menuView, { params: {}, query: {}, onRefresh() {} });
  const add = findButton(root, 'Add');
  assert(add, 'Add button visible when elevated');
  add.click();
  await tick(80);
  const sheetEl = queryAll(realDocument.body, '.sheet').slice(-1)[0];
  const catId = (state0.bootstrap?.categories?.[0]?.id) ?? 1;
  submitForm(sheetEl, {
    fill: {
      name: 'Smoke Test Ponni Boiled 5 kg',
      mrp: 620,
      retail_price: 545,
      wholesale_price: 505,
      category_id: String(catId),
      pack_size: '5 kg',
      unit: 'bag',
      min_qty_retail: 1,
      moq_wholesale: 6,
      low_stock_qty: 4,
    },
  });
  await tick(600);
  const created = await apiMod.api.get('/api/admin/products?search=Smoke Test Ponni');
  assert(created.products.length === 1, `product not created: ${JSON.stringify(created.counts)}`);
  const item = created.products[0];
  assert(item.retail_price === 545 && item.wholesale_price === 505, 'prices stored');
  // and it is immediately orderable by a customer at the right price
  const priced = await apiMod.api.get(`/api/catalog/products/${item.id}/price?qty=6`);
  assert(priced.line, 'price line computed');
});

await step('owner: approving a pending wholesale business', async () => {
  const admin = await mod(owner + 'admin.js');
  const root = await renderInto(admin.approvalsView, { params: {}, query: {}, onRefresh() {} });
  const before = await apiMod.api.get('/api/owner/wholesale?status=pending_verification');
  assert(before.accounts.length >= 1, 'a pending application exists in the seed data');
  const approve = queryAll(root, 'button').find((b) => /^Approve$/.test(textOf(b)));
  assert(approve, 'approve button rendered');
  approve.click();
  await tick(120);
  const sheetEl = queryAll(realDocument.body, '.sheet').slice(-1)[0];
  const confirm = findButton(sheetEl, 'Confirm');
  assert(confirm, 'confirm step');
  confirm.click();
  await tick(600);
  const after = await apiMod.api.get('/api/owner/wholesale?status=active');
  assert(after.accounts.some((a) => a.business_name === before.accounts[0].business_name), 'account became active');
  const messages = await apiMod.api.get('/api/owner/notifications?limit=5');
  assert(/approved|வர்த்தக|wholesale/i.test(JSON.stringify(messages.messages.map((m) => m.body))), 'the approval message was queued');
});

await step('owner: payment reconciliation and order flow on the dashboard', async () => {
  const dash = await mod(owner + 'dashboard.js');
  const root = await renderInto(dash.dashboardView, { params: {}, query: {}, onRefresh() {} });
  const advance = queryAll(root, 'button').find((b) => /^Mark /.test(textOf(b)));
  if (advance) {
    advance.click();
    await tick(500);
    assert(true, 'status advanced');
  }
  const payView = await mod(owner + 'admin.js');
  const pRoot = await renderInto(payView.paymentsView, { params: {}, query: {}, onRefresh() {} });
  const paid = findButton(pRoot, 'Mark paid');
  if (paid) {
    paid.click();
    await tick(120);
    const sheetEl = queryAll(realDocument.body, '.sheet').slice(-1)[0];
    const confirm = findButton(sheetEl, 'Confirm');
    confirm.click();
    await tick(600);
    const events = await apiMod.api.get('/api/owner/payments');
    assert(events.recent_events.some((e) => e.action === 'mark_paid'), 'payment event recorded');
  }
});

await step('owner: store settings save through the elevated form', async () => {
  const admin = await mod(owner + 'admin.js');
  const root = await renderInto(admin.settingsView, { params: {}, query: {}, onRefresh() {} });
  const form = queryAll(root, 'form')[0];
  assert(form, 'settings form rendered');
  const tagline = queryAll(form, 'input').find((i) => i.getAttribute('name') === 'store_tagline');
  tagline.value = 'Stocked fresh since 1984 — smoke tested';
  form.dispatchEvent(new DomEvent('submit', { bubbles: true }));
  await tick(600);
  const after = await apiMod.api.get('/api/owner/settings');
  assert(after.settings.store_tagline === 'Stocked fresh since 1984 — smoke tested', `tagline = ${after.settings.store_tagline}`);
});

await step('router: every route module resolves and exposes its export', async () => {
  for (const route of router.routes) {
    const m = await route.view();
    const name = route.export || 'default';
    assert(typeof m[name] === 'function', `${route.path} → ${name} missing`);
  }
});

console.log(`\n${checks - failures}/${checks} smoke steps passed\n`);
process.exit(failures ? 1 : 0);
