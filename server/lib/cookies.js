/** Minimal cookie parse/serialize. Session tokens are random 256-bit values that
 *  are looked up (hashed) in the DB, so no signing is needed. */
export function parseCookies(header = '') {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[name] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const { maxAge = null, httpOnly = true, sameSite = 'lax', secure = false, path = '/' } = opts;
  const bits = [`${name}=${value === null || value === undefined ? '' : encodeURIComponent(value)}`];
  bits.push(`Path=${path}`);
  if (maxAge !== null) bits.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) bits.push('HttpOnly');
  if (sameSite) bits.push(`SameSite=${sameSite}`);
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export const SESSION_COOKIE = 'smv_session';
