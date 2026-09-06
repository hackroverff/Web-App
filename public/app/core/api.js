/**
 * Fetch wrapper: same-origin cookie session, one error shape, offline detection.
 *
 * A cookie alone is not enough when the app is opened inside a frame (device preview,
 * kiosk embed): browsers refuse a SameSite=Lax cookie set by a cross-site frame, so every
 * request would come back anonymous. In that context the server mirrors the session token
 * into the response body and we replay it as a bearer token — see server/middleware/session.js.
 */
import { state, set } from './store.js';
import { t } from './i18n.js';
import { localGet, localRemove, localSet, sessionGet, sessionRemove, sessionSet, storageAvailable } from './storage.js';

const TOKEN_KEY = 'smv.session_token';
// The counter/owner portal is a second, independent session in the same tab. Kept in its own slot
// for the same reason the server uses its own cookie: with one shared slot, entering the owner PIN
// overwrote the shopper's token and the next cart write arrived unsigned.
const OWNER_TOKEN_KEY = 'smv.owner_token';

const isOwnerPath = (path) => /^\/api\/(owner|admin)(\/|$)/.test(path);

export const inFrame = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // blocked by the parent's policy: we are framed
  }
})();

/**
 * The cookie-less fallback, one copy per door. Kept in memory *and* both storages: sessionStorage
 * alone dies on a reload in some frames and localStorage is unavailable in others, and either way
 * the user reads it as "I am signed in but it wants me to sign in again". storage.js never throws,
 * so a frame whose storage the browser blocks still works from the in-memory copy.
 */
function readToken(key) {
  return localGet(key) || sessionGet(key) || '';
}

const slots = {
  shop: readToken(TOKEN_KEY),
  counter: readToken(OWNER_TOKEN_KEY),
};

const slotFor = (path) => (isOwnerPath(path) ? 'counter' : 'shop');

/** `token` empty means "this door is signed out" — the slot is removed, not left stale. */
export function setBearerToken(token, path = '') {
  const name = slotFor(path);
  slots[name] = token || '';
  const key = name === 'counter' ? OWNER_TOKEN_KEY : TOKEN_KEY;
  if (slots[name]) {
    localSet(key, slots[name]);
    sessionSet(key, slots[name]);
  } else {
    localRemove(key);
    sessionRemove(key);
  }
}

/** Which token this request should carry — the one for the door being called. */
const bearerFor = (path) => slots[slotFor(path)];

/**
 * The clients whose cookie can be dropped under them: one shown inside someone else's page, and
 * one with no storage to keep either credential in. It picks the wording of a lost-session
 * message, so it must not simply mean "we happen to hold a token" — every client is handed one
 * now, and telling a plain browser tab that its frame is to blame is worse than saying nothing.
 */
export const needsTokenTransport = () => inFrame || !storageAvailable();

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = extra.code;
    this.fields = extra.fields;
    this.cart = extra.cart;
  }
}

let lastOfflineReport = 0;

async function request(method, path, body, opts = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (inFrame) headers['x-app-context'] = 'embedded';
  // Ask for a bearer copy of the session on every call. It is worth nothing when the cookie
  // works and everything when it does not: a proxy that drops Set-Cookie, a browser that refuses
  // storage in a frame, or an http:// device address where a Secure cookie cannot exist. Those
  // are exactly the "already logged in, still told to log in" cases. Only same-origin code can
  // read this response, and same-origin code can already call the API with the cookie.
  headers['x-want-bearer'] = '1';
  const bearer = bearerFor(path);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err.name !== 'AbortError') markOffline(true);
    throw new ApiError(0, 'You appear to be offline. Cached prices are shown, but orders need a connection.');
  }
  markOffline(false);

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  // The server mirrors a fresh token on the call that created the session and sends an explicit
  // null on the call that destroyed it; both are aimed at whichever door was being used, so the
  // shopper's copy survives the counter signing in and vice versa.
  if (data && typeof data === 'object' && 'session_token' in data) setBearerToken(data.session_token, path);

  if (!res.ok) {
    const err = data?.error || {};
    let message = err.message || `Request failed (${res.status})`;

    // A 401 in the middle of a session is usually plumbing rather than a logout: the frame
    // dropped the session cookie, a proxy restarted, or a serverless instance came up without
    // the row. Ask the server once whether a session does exist and replay the call — that is
    // the difference between "your cart moved" and being thrown back to a sign-in prompt.
    // Login/register endpoints keep their literal 401 ("that password is wrong").
    const weThinkWeAreSignedIn = Boolean(state.user || state.owner?.signedIn);
    const probeable = !opts.probed && weThinkWeAreSignedIn && !/^\/api\/(auth\/|owner\/login)/.test(path);
    if (res.status === 401 && probeable) {
      const ownerSide = path.startsWith('/api/owner/');
      const probe = await request('GET', ownerSide ? '/api/owner/session' : '/api/auth/me', undefined, {
        silent401: true,
        probed: true,
      });
      if (ownerSide ? probe?.signed_in : probe?.user) {
        if (!ownerSide) set({ user: probe.user, cart: probe.cart ?? state.cart });
        return request(method, path, body, { ...opts, probed: true });
      }
      if (needsTokenTransport()) message = t('toast.session_blocked');
      // One tap turns a dead end into an answer: the sheet says which credential, if any,
      // actually reached the server. Offered whatever the framing, because "already logged in but
      // told to log in" is the failure people report — and this is what turns it into three
      // checkable facts instead of a guess about caches.
      // The credential this door presented is dead: drop it, so it cannot shadow the next sign-in
      // (the bearer copy is read before the cookie, and a stale copy would keep answering).
      if (bearerFor(path)) setBearerToken('', path);
      import('./session-check.js')
        .then((m) => m.offerSessionCheck())
        .catch(() => {});
    }

    if (res.status === 401 && !opts.silent401 && state.user) {
      set({ user: null, cart: emptyCart() });
    }
    throw new ApiError(res.status, message, { code: err.code, fields: err.fields, cart: err.cart });
  }
  return data;
}

const emptyCart = () => ({ lines: [], item_count: 0, subtotal: 0, total: 0, min_order_met: true, min_order_value: 0, min_order_short_by: 0 });

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body ?? {}, opts),
  patch: (path, body, opts) => request('PATCH', path, body ?? {}, opts),
  put: (path, body, opts) => request('PUT', path, body ?? {}, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),
};

function markOffline(offline) {
  if (offline === state.offline) return;
  if (offline && Date.now() - lastOfflineReport < 4000) return;
  lastOfflineReport = Date.now();
  set({ offline });
}

window.addEventListener('offline', () => markOffline(true));
window.addEventListener('online', () => markOffline(false));

/** Build a query string from an object, skipping empties. */
export function qs(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}
