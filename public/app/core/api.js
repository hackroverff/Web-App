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
import { localGet, localRemove, localSet, sessionGet, sessionRemove, sessionSet } from './storage.js';

const TOKEN_KEY = 'smv.session_token';

export const inFrame = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // blocked by the parent's policy: we are framed
  }
})();

/**
 * The cookie-less fallback. Kept in memory *and* both storages: sessionStorage alone dies on a
 * reload in some frames and localStorage is unavailable in others, and either way the user reads
 * it as "I am signed in but it wants me to sign in again". storage.js never throws, so a frame
 * whose storage the browser blocks still works from the in-memory copy.
 */
function readBearer() {
  return localGet(TOKEN_KEY) || sessionGet(TOKEN_KEY) || '';
}

let bearer = readBearer();

export function setBearerToken(token) {
  bearer = token || '';
  if (bearer) {
    localSet(TOKEN_KEY, bearer);
    sessionSet(TOKEN_KEY, bearer);
  } else {
    localRemove(TOKEN_KEY);
    sessionRemove(TOKEN_KEY);
  }
}

/** The framed/token client is the one whose cookies may be dropped — the server needs to know. */
export const needsTokenTransport = () => inFrame || Boolean(bearer);

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
  if (inFrame || bearer) headers['x-app-context'] = 'embedded';
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
