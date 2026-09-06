/**
 * Session + role middleware.
 *
 * Roles
 *   customer.session.subject = 'customer' → level 'basic'  (retail or wholesale)
 *   customer.session.subject = 'owner'    → level 'ops'    (PIN login: counter dashboard)
 *                                         → level 'admin'  (password login: pricing/approvals/settings)
 *
 * Elevation expires on its own (config.elevatedMinutes) and is downgraded lazily
 * on each request, so an unlocked admin screen on a counter tablet cannot be left open.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { get, run, insert, update } from '../db/index.js';
import { parseCookies, serializeCookie, SESSION_COOKIE } from '../lib/cookies.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { clientIp } from '../lib/ratelimit.js';

/**
 * Is this request coming from a frame (preview, kiosk embed, WebView) rather than
 * being the top-level document? Browsers tell us with Sec-Fetch-* hints; the client
 * also sends X-App-Context for the first request, before it has any cookie.
 */
export function isEmbedded(req) {
  if (String(req.headers['x-app-context'] || '') === 'embedded') return true;
  // Deliberately NOT inferred from the presence of a bearer token: that would upgrade a
  // top-level visitor's cookie to SameSite=None; Secure, and a `Secure` cookie cannot exist on a
  // plain-http LAN address (http://192.168.1.40:4173 — how a shop tablet reaches a laptop).
  // Cookie strength follows framing only; carrying a token has its own opt-in header.
  const dest = String(req.headers['sec-fetch-dest'] || '');
  if (dest && ['iframe', 'frame', 'embed', 'object'].includes(dest)) return true;
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site === 'cross-site' || site === 'same-site-ancestor') return true;
  return false;
}

/** Cookie attributes for this request; SameSite=None always needs Secure. */
export function cookieAttrs(req) {
  // attachIdentity already worked this out for the request; only recompute for requests it
  // did not run on (e.g. a cookie set from a route it is mounted after).
  const embedded = config.sameSiteAuto && (typeof req.embedded === 'boolean' ? req.embedded : isEmbedded(req));
  const sameSite = embedded ? 'none' : config.sameSite;
  const secure = sameSite === 'none' ? true : config.secureCookies;
  return { sameSite, secure, partitioned: embedded };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(`${config.cookieSecret}|session|${token}`).digest('hex');
}

export function createSession({ subject, userId = null, staffId = null, level = 'basic', req, elevatedUntil = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  insert('sessions', {
    token_hash: hashToken(token),
    subject,
    user_id: userId,
    staff_id: staffId,
    level,
    elevated_until: elevatedUntil,
    ip: req ? clientIp(req) : null,
    user_agent: req ? String(req.headers['user-agent'] || '').slice(0, 180) : null,
    expires_at: expires,
  });
  const attrs = cookieAttrs(req);
  return {
    token,
    cookie: serializeCookie(SESSION_COOKIE, token, { maxAge: config.sessionDays * 86_400, ...attrs }),
    maxAge: config.sessionDays * 86_400,
  };
}

export function destroySession(req, res) {
  const token = bearerToken(req) || parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (token) run('UPDATE sessions SET revoked=1 WHERE token_hash=?', [hashToken(token)]);
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, ...cookieAttrs(req) }));
  res.locals.clearSessionToken = true;
}

/** `Authorization: Bearer <token>` — same session, for clients that cannot keep a cookie. */
export function bearerToken(req) {
  if (!config.allowBearer) return null;
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,})$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

export function revokeUserSessions({ userId = null, staffId = null }) {
  if (userId) run("UPDATE sessions SET revoked=1 WHERE subject='customer' AND user_id=? AND revoked=0", [userId]);
  if (staffId) run("UPDATE sessions SET revoked=1 WHERE subject='owner' AND staff_id=? AND revoked=0", [staffId]);
}

export function setSessionCookie(res, session) {
  res.append('Set-Cookie', session.cookie);
  // The JSON middleware in app.js copies this into the response body. Two clients ask for it:
  // one that is framed (it may not be allowed to store the cookie at all), and one that asked for
  // a copy with `x-want-bearer: 1` — which the PWA does on every call, so a preview proxy that
  // drops Set-Cookie cannot turn "sign in" into "please sign in".
  if (config.allowBearer && (res.locals.embedded || res.locals.wantBearer)) {
    res.locals.sessionToken = session.token;
  }
}

/** Populate req.session / req.user / req.staff. Never throws. */
export function attachIdentity(req, _res, next) {
  req.embedded = isEmbedded(req);
  _res.locals.embedded = req.embedded;
  const token = bearerToken(req) || parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  req.session = null;
  req.user = null;
  req.staff = null;
  req.level = 'anonymous';
  if (!token) return next();

  const session = get('SELECT * FROM sessions WHERE token_hash = ? AND revoked = 0', [hashToken(token)]);
  if (!session) return next();
  if (new Date(`${session.expires_at}Z`).getTime() < Date.now()) {
    run('UPDATE sessions SET revoked=1 WHERE token_hash=?', [session.token_hash]);
    return next();
  }

  let level = session.level;
  if (session.subject === 'owner' && level === 'admin' && session.elevated_until) {
    if (new Date(`${session.elevated_until}Z`).getTime() < Date.now()) {
      level = 'ops';
      update('sessions', session.token_hash, { level: 'ops', elevated_until: null }, 'token_hash');
    }
  } else if (session.subject === 'owner' && level === 'admin' && !session.elevated_until) {
    level = 'ops';
  }

  req.session = { ...session, level };
  req.level = level === 'admin' ? 'admin' : level === 'ops' ? 'ops' : 'basic';

  if (session.subject === 'customer') {
    const user = get('SELECT * FROM users WHERE id = ?', [session.user_id]);
    if (!user || user.status === 'suspended') return next();
    req.user = user;
  } else {
    const staff = get('SELECT * FROM staff WHERE id = ?', [session.staff_id]);
    if (!staff || !staff.is_active) return next();
    req.staff = { ...staff, elevated: req.level === 'admin' };
  }
  if (Date.now() - new Date(`${session.last_seen_at}Z`).getTime() > 60_000) {
    run("UPDATE sessions SET last_seen_at=datetime('now') WHERE token_hash=?", [session.token_hash]);
  }
  next();
}

export function requireCustomer(req, _res, next) {
  if (!req.user) return next(unauthorized('Please sign in to continue.'));
  if (!req.user.verified) return next(unauthorized('Please verify your mobile number to continue.'));
  next();
}

export function requireOwner(req, _res, next) {
  if (!req.staff) return next(unauthorized('Owner PIN login required.'));
  next();
}

/** Sensitive actions: editing prices/products, approvals, store settings. */
export function requireElevated(req, _res, next) {
  if (!req.staff) return next(unauthorized('Owner PIN login required.'));
  if (req.level !== 'admin') {
    return next(forbidden('Password verification required for this action. Open any admin screen marked “secure” and enter your password.'));
  }
  if (req.staff.role !== 'owner') {
    return next(forbidden('Only the store owner can change prices and approvals. Staff accounts can use the counter dashboard.'));
  }
  next();
}

export function publicUser(user) {
  if (!user) return null;
  const approvedWholesale = user.role === 'wholesale' && user.status === 'active';
  return {
    id: user.id,
    full_name: user.full_name,
    mobile: user.mobile,
    role: user.role,
    lang: user.lang || 'en',
    verified: !!user.verified,
    status: user.status,
    business_name: user.business_name || null,
    business_type: user.business_type || null,
    gst_number: user.gst_number || null,
    pricing_scope: approvedWholesale ? 'wholesale' : 'retail',
    wholesale_approved: approvedWholesale,
    wholesale_pending: user.role === 'wholesale' && user.status === 'pending_verification',
    created_at: user.created_at,
    address_count: Number(get('SELECT COUNT(*) AS n FROM addresses WHERE user_id=?', [user.id]).n || 0),
    order_count: Number(get('SELECT COUNT(*) AS n FROM orders WHERE user_id=? AND voided=0', [user.id]).n || 0),
  };
}
