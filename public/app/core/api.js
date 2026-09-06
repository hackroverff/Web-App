/**
 * Fetch wrapper: same-origin cookie session, one error shape, offline detection.
 *
 * A cookie alone is not enough when the app is opened inside a frame (device preview,
 * kiosk embed): browsers refuse a SameSite=Lax cookie set by a cross-site frame, so every
 * request would come back anonymous. In that context the server mirrors the session token
 * into the response body and we replay it as a bearer token — see server/middleware/session.js.
 */
import { state, set } from './store.js';

const TOKEN_KEY = 'smv.session_token';

export const inFrame = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // blocked by the parent's policy: we are framed
  }
})();

let bearer = '';
try {
  bearer = sessionStorage.getItem(TOKEN_KEY) || '';
} catch {
  /* storage disabled — the cookie path still works when it is allowed */
}

export function setBearerToken(token) {
  bearer = token || '';
  try {
    if (bearer) sessionStorage.setItem(TOKEN_KEY, bearer);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

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
  if (data && typeof data === 'object' && 'session_token' in data) setBearerToken(data.session_token);

  if (!res.ok) {
    const err = data?.error || {};
    const message = err.message || `Request failed (${res.status})`;
    const e = new ApiError(res.status, message, { code: err.code, fields: err.fields, cart: err.cart });
    if (res.status === 401 && !opts.silent401 && state.user) {
      set({ user: null, cart: emptyCart() });
    }
    throw e;
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
