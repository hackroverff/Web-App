/**
 * Storage that never throws.
 *
 * In a frame the browser has decided is not allowed to store anything — a sandboxed iframe
 * without `allow-same-origin`, ITP on iOS/Safari, "block all cookies", an incognito window —
 * touching `window.localStorage` raises, not returns null. That used to break module
 * evaluation itself, which leaves a white screen and a console full of errors instead of an
 * app. Nothing the app keeps locally is load-bearing: the language preference, a dismissed
 * install banner, a "you have seen the splash" flag, the OTP hand-off between two screens, and
 * the session token (which is also in memory and in a cookie). So degrade to an in-memory map.
 */
function backing(name) {
  try {
    const store = window[name];
    if (!store) return null;
    const probe = 'smv.probe';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

const real = { local: backing('localStorage'), session: backing('sessionStorage') };
const memory = { local: new Map(), session: new Map() };

function read(scope, key) {
  const store = real[scope];
  if (store) {
    try {
      const v = store.getItem(key);
      if (v !== null) return v;
    } catch {
      /* fall through to memory */
    }
  }
  const v = memory[scope].get(key);
  return v === undefined ? null : v;
}

function write(scope, key, value) {
  memory[scope].set(key, String(value));
  const store = real[scope];
  if (!store) return;
  try {
    store.setItem(key, String(value));
  } catch {
    /* quota or blocked write: the memory copy already covers this session */
  }
}

function drop(scope, key) {
  memory[scope].delete(key);
  const store = real[scope];
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const localGet = (key) => read('local', key);
export const localSet = (key, value) => write('local', key, value);
export const localRemove = (key) => drop('local', key);

export const sessionGet = (key) => read('session', key);
export const sessionSet = (key, value) => write('session', key, value);
export const sessionRemove = (key) => drop('session', key);

/** True when the browser let us write to disk for this origin at all. */
export const storageAvailable = () => Boolean(real.local || real.session);
