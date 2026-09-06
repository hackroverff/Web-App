/**
 * Customer authentication + account self-service.
 *
 * Registration → OTP on mobile → verified. Wholesale signups land in
 * `pending_verification` and see retail prices until the owner approves them.
 */
import express from 'express';
import { config } from '../config.js';
import { all, get, insert, run, update, tx, settings, getBoolSetting, getNumberSetting, getSetting } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { issueOtp, verifyOtp } from '../lib/otp.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  normaliseMobile,
  mobile as vMobile,
  password as vPassword,
  str,
  optStr,
  oneOf,
  BUSINESS_TYPES,
  GST_RE,
  EMAIL_RE,
} from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { createSession, destroySession, setSessionCookie, publicUser, requireCustomer, revokeUserSessions } from '../middleware/session.js';
import { loadCart } from '../services/cart.js';

export const router = express.Router();

const authLimiter = rateLimit({ name: 'auth', max: config.authRateLimitMax });
const ACCOUNT_TYPES = ['retail', 'wholesale'];
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const findUser = (mobileNo) => get('SELECT * FROM users WHERE mobile = ?', [mobileNo]);


/** "Is this number taken?" helper so the signup form can guide the user. */
router.get('/account-status', (req, res) => {
  const m = normaliseMobile(req.query.mobile);
  if (!m) return res.json({ exists: false });
  const u = findUser(m);
  if (!u) return res.json({ exists: false });
  return res.json({
    exists: true,
    verified: !!u.verified,
    name: u.full_name,
    role: u.role,
    status: u.status,
    hint: u.verified
      ? 'This number already has an account — you can sign in instead.'
      : 'This number is registered but not verified yet. We can send the code again.',
  });
});

// --------------------------------------------------------------------- signup --
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const fullName = str(b.full_name, { field: 'Full name', max: 80, min: 2 });
    const mobileNo = vMobile(b.mobile);
    const pass = vPassword(b.password, { min: 8 });
    const confirm = String(b.confirm_password ?? '');
    if (pass !== confirm) throw badRequest('Password and confirm password do not match.', { fields: { confirm_password: 'mismatch' } });

    const accountType = oneOf(b.account_type || 'retail', ACCOUNT_TYPES, { field: 'Account type', fallback: 'retail' });
    const lang = oneOf(b.lang || 'en', ['en', 'ta'], { field: 'lang', fallback: 'en' });

    let business = null;
    if (accountType === 'wholesale') {
      business = {
        business_name: str(b.business_name, { field: 'Business name', max: 90, min: 2 }),
        business_type: oneOf(b.business_type, BUSINESS_TYPES, { field: 'Business type' }),
        gst_number: readGst(b.gst_number),
      };
    }

    const existing = findUser(mobileNo);
    if (existing && existing.verified) throw conflict('An account already exists for this number. Please sign in instead.');

    // Hashed outside the transaction: scrypt is async, SQLite is synchronous.
    const passwordHash = await hashPassword(pass);
    const approvalRequired = getBoolSetting('wholesale_requires_approval', true);

    const user = tx(() => {
      const data = {
        full_name: fullName,
        mobile: mobileNo,
        password_hash: passwordHash,
        lang,
        role: accountType,
        status: accountType === 'wholesale' && approvalRequired ? 'pending_verification' : 'active',
        verified: 0,
        business_name: business ? business.business_name : null,
        business_type: business ? business.business_type : null,
        gst_number: business ? business.gst_number : null,
      };
      if (existing) {
        update('users', existing.id, data);
        return get('SELECT * FROM users WHERE id = ?', [existing.id]);
      }
      const id = insert('users', data);
      return get('SELECT * FROM users WHERE id = ?', [id]);
    });

    const otp = await issueOtp({ mobile: mobileNo, purpose: 'register', userId: user.id, payload: { account_type: accountType }, lang });
    audit({ actorType: 'customer', actorId: user.id, actorLabel: fullName, action: 'auth.register', entity: 'user', entityId: user.id, detail: `account_type=${accountType}` });

    res.json({
      step: 'verify_otp',
      mobile: mobileNo,
      account_type: accountType,
      pending_business: accountType === 'wholesale',
      otp,
      message:
        accountType === 'wholesale'
          ? 'Verify your number. Wholesale prices unlock once the owner approves your business.'
          : 'Verify your number to activate your account.',
    });
  } catch (err) {
    next(err);
  }
});

/** Enter the 6-digit code → account active, session issued, cart returned. */
router.post('/verify', authLimiter, (req, res, next) => {
  try {
    const mobileNo = vMobile(req.body?.mobile);
    const code = str(req.body?.code, { field: 'Code', max: 10 });
    verifyOtp({ mobile: mobileNo, code, purpose: 'register' });
    const user = findUser(mobileNo);
    if (!user) throw notFound('Account not found.');
    update('users', user.id, { verified: 1, last_login_at: now() });
    const fresh = findUser(mobileNo);
    const session = createSession({ subject: 'customer', userId: fresh.id, req });
    setSessionCookie(res, session);
    audit({ actorType: 'customer', actorId: fresh.id, actorLabel: fresh.full_name, action: 'auth.verify_otp', entity: 'user', entityId: fresh.id });
    res.json({
      user: publicUser(fresh),
      cart: loadCart(fresh.id, fresh),
      settings: clientSettings(),
      message:
        fresh.status === 'pending_verification'
          ? 'Number verified. Your business details are with the owner for approval — shop at retail prices meanwhile.'
          : `Welcome to Sathvika MV, ${fresh.full_name.split(' ')[0]}!`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/resend-otp', authLimiter, async (req, res, next) => {
  try {
    const mobileNo = vMobile(req.body?.mobile);
    const purpose = oneOf(req.body?.purpose, ['register', 'reset'], { field: 'purpose', fallback: 'register' });
    const user = findUser(mobileNo);
    if (purpose === 'register' && !user) throw notFound('We could not find a signup for that number.');
    const otp = await issueOtp({ mobile: mobileNo, purpose, userId: user?.id || null, lang: user?.lang || 'en' });
    res.json({ otp, message: 'A new 6-digit code is on its way.' });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ sign in --
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const mobileNo = vMobile(req.body?.mobile);
    const pass = String(req.body?.password ?? '');
    const user = findUser(mobileNo);
    if (!user || !(await verifyPassword(pass, user.password_hash))) {
      throw unauthorized('Mobile number or password is incorrect.');
    }
    if (!user.verified) throw new AppError(428, 'Your mobile number is not verified yet.', { code: 'verify_required' });
    if (user.status === 'suspended') {
      throw forbidden(`This account is paused. Please call the store on ${getSetting('store_phone', 'the store number')} to reopen it.`);
    }
    if (user.status === 'rejected') {
      throw forbidden('Your wholesale application was not approved. You can still shop at retail prices — please speak to the owner.');
    }

    update('users', user.id, { last_login_at: now() });
    const session = createSession({ subject: 'customer', userId: user.id, req });
    setSessionCookie(res, session);
    res.json({ user: publicUser(user), cart: loadCart(user.id, user), settings: clientSettings() });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true, message: 'Signed out.' });
});

router.get('/me', (req, res, next) => {
  if (!req.user) return next(unauthorized('Not signed in.'));
  res.json({ user: publicUser(req.user), cart: loadCart(req.user.id, req.user), settings: clientSettings() });
});

// -------------------------------------------------------- password recovery --
router.post('/forgot', authLimiter, async (req, res, next) => {
  try {
    const mobileNo = vMobile(req.body?.mobile);
    const user = findUser(mobileNo);
    if (!user) {
      // Deliberately identical response: do not reveal which numbers are registered.
      return res.json({ step: 'enter_code', mobile: mobileNo, otp: { channel: 'sms' }, message: 'If that number is registered, a reset code is on its way.' });
    }
    const otp = await issueOtp({ mobile: mobileNo, purpose: 'reset', userId: user.id, lang: user.lang });
    res.json({ step: 'enter_code', mobile: mobileNo, otp, message: 'Enter the 6-digit code to choose a new password.' });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const mobileNo = vMobile(req.body?.mobile);
    const pass = vPassword(req.body?.password, { min: 8 });
    if (pass !== String(req.body?.confirm_password ?? '')) throw badRequest('New passwords do not match.');
    verifyOtp({ mobile: mobileNo, code: str(req.body?.code, { field: 'Code', max: 10 }), purpose: 'reset' });
    const user = findUser(mobileNo);
    if (!user) throw notFound('Account not found.');
    update('users', user.id, { password_hash: await hashPassword(pass) });
    revokeUserSessions({ userId: user.id });
    audit({ actorType: 'customer', actorId: user.id, actorLabel: user.full_name, action: 'auth.reset_password' });
    res.json({ ok: true, message: 'Password updated. Please sign in with the new password.' });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------- retail ↔ wholesale flow --
router.post('/account-type', requireCustomer, (req, res, next) => {
  try {
    const type = oneOf(req.body?.account_type, ACCOUNT_TYPES, { field: 'Account type' });
    if (type === 'retail') {
      update('users', req.user.id, { role: 'retail', status: 'active', business_name: null, business_type: null, gst_number: null });
      return res.json({ user: publicUser(findUser(req.user.mobile)), cart: loadCart(req.user.id, req.user), message: 'Switched to retail shopping.' });
    }
    if (req.user.role === 'wholesale' && req.user.status === 'active') throw badRequest('Your wholesale account is already approved.');

    const business = {
      business_name: str(req.body?.business_name, { field: 'Business name', max: 90, min: 2 }),
      business_type: oneOf(req.body?.business_type, BUSINESS_TYPES, { field: 'Business type' }),
      gst_number: readGst(req.body?.gst_number),
    };
    const approvalRequired = getBoolSetting('wholesale_requires_approval', true);
    update('users', req.user.id, {
      role: 'wholesale',
      status: approvalRequired ? 'pending_verification' : 'active',
      approved_at: approvalRequired ? null : now(),
      rejected_reason: null,
      ...business,
    });
    const fresh = findUser(req.user.mobile);
    audit({ actorType: 'customer', actorId: fresh.id, actorLabel: fresh.full_name, action: 'account.wholesale_request', detail: business.business_name });
    res.json({
      user: publicUser(fresh),
      cart: loadCart(fresh.id, fresh),
      message: approvalRequired
        ? `Submitted for approval. Wholesale prices unlock once the owner verifies ${business.business_name}.`
        : 'Wholesale account activated.',
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ profile --
router.patch('/profile', requireCustomer, (req, res, next) => {
  try {
    const patch = {};
    if (req.body?.full_name !== undefined) patch.full_name = str(req.body.full_name, { field: 'Full name', max: 80, min: 2 });
    if (req.body?.lang !== undefined) patch.lang = oneOf(req.body.lang, ['en', 'ta'], { field: 'lang' });
    if (req.body?.email !== undefined) {
      const email = optStr(req.body.email, { field: 'Email', max: 90 });
      if (email && !EMAIL_RE.test(email)) throw badRequest('That email address looks incorrect.');
      patch.email = email;
    }
    if (Object.keys(patch).length) update('users', req.user.id, patch);
    res.json({ user: publicUser(findUser(req.user.mobile)) });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireCustomer, async (req, res, next) => {
  try {
    const current = String(req.body?.current_password ?? '');
    const nextPass = vPassword(req.body?.new_password, { min: 8 });
    if (!(await verifyPassword(current, req.user.password_hash))) throw badRequest('Your current password is not correct.');
    if (nextPass !== String(req.body?.confirm_password ?? '')) throw badRequest('New passwords do not match.');
    update('users', req.user.id, { password_hash: await hashPassword(nextPass) });
    audit({ actorType: 'customer', actorId: req.user.id, actorLabel: req.user.full_name, action: 'auth.change_password' });
    res.json({ ok: true, message: 'Password changed.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- addresses --
function addressBody(user, body) {
  const out = {
    label: optStr(body.label, { field: 'Label', max: 30 }) || (user.role === 'wholesale' ? 'Shop' : 'Home'),
    kind: oneOf(body.kind || (user.role === 'wholesale' ? 'business' : 'home'), ['home', 'business'], { field: 'kind', fallback: 'home' }),
    contact_name: optStr(body.contact_name, { field: 'Contact name', max: 60 }) || user.full_name,
    contact_phone: body.contact_phone ? vMobile(body.contact_phone, { field: 'Contact phone' }) : user.mobile,
    line1: str(body.line1, { field: 'Door / street', max: 140, min: 4 }),
    line2: optStr(body.line2, { field: 'Area line', max: 140 }),
    area: optStr(body.area, { field: 'Area', max: 80 }),
    city: optStr(body.city, { field: 'City', max: 60 }) || 'Chennai',
    pincode: optStr(body.pincode, { field: 'Pincode', max: 10 }),
    landmark: optStr(body.landmark, { field: 'Landmark', max: 140 }),
    lat: body.lat === '' || body.lat == null ? null : Number(body.lat),
    lng: body.lng === '' || body.lng == null ? null : Number(body.lng),
    is_default: body.is_default ? 1 : 0,
  };
  if (out.pincode && !/^\d{6}$/.test(out.pincode)) throw badRequest('Pincode must be 6 digits.', { fields: { pincode: 'invalid' } });
  if (out.lat !== null && !Number.isFinite(out.lat)) throw badRequest('Latitude is not a number.');
  if (out.lng !== null && !Number.isFinite(out.lng)) throw badRequest('Longitude is not a number.');
  return out;
}

const listAddresses = (userId) => all('SELECT * FROM addresses WHERE user_id=? ORDER BY is_default DESC, id DESC', [userId]);

router.get('/me/addresses', requireCustomer, (req, res) => res.json({ addresses: listAddresses(req.user.id) }));

router.post('/me/addresses', requireCustomer, (req, res, next) => {
  try {
    const data = addressBody(req.user, req.body || {});
    const id = tx(() => {
      const count = Number(get('SELECT COUNT(*) AS n FROM addresses WHERE user_id=?', [req.user.id]).n || 0);
      if (data.is_default || count === 0) run('UPDATE addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
      return insert('addresses', { ...data, is_default: data.is_default || count === 0 ? 1 : 0, user_id: req.user.id });
    });
    res.status(201).json({ address: get('SELECT * FROM addresses WHERE id=?', [id]), addresses: listAddresses(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.patch('/me/addresses/:id', requireCustomer, (req, res, next) => {
  try {
    const row = get('SELECT * FROM addresses WHERE id=? AND user_id=?', [Number(req.params.id), req.user.id]);
    if (!row) throw notFound('Address not found.');
    const data = addressBody(req.user, { ...row, ...req.body });
    tx(() => {
      if (data.is_default) run('UPDATE addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
      update('addresses', row.id, data);
    });
    res.json({ addresses: listAddresses(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/me/addresses/:id/default', requireCustomer, (req, res, next) => {
  try {
    const row = get('SELECT * FROM addresses WHERE id=? AND user_id=?', [Number(req.params.id), req.user.id]);
    if (!row) throw notFound('Address not found.');
    tx(() => {
      run('UPDATE addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
      run('UPDATE addresses SET is_default=1 WHERE id=?', [row.id]);
    });
    res.json({ addresses: listAddresses(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/me/addresses/:id', requireCustomer, (req, res, next) => {
  try {
    const row = get('SELECT * FROM addresses WHERE id=? AND user_id=?', [Number(req.params.id), req.user.id]);
    if (!row) throw notFound('Address not found.');
    tx(() => {
      run('DELETE FROM addresses WHERE id=?', [row.id]);
      if (row.is_default) {
        const fallback = get('SELECT id FROM addresses WHERE user_id=? ORDER BY id ASC LIMIT 1', [req.user.id]);
        if (fallback) run('UPDATE addresses SET is_default=1 WHERE id=?', [fallback.id]);
      }
    });
    res.json({ ok: true, addresses: listAddresses(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------- shared --
function readGst(value) {
  const v = optStr(value, { field: 'GST number', max: 20 });
  if (!v) return null;
  const up = v.replace(/\s/g, '').toUpperCase();
  if (!GST_RE.test(up)) throw badRequest('GST number should be 15 characters (e.g. 33ABCDE1234F1Z5).', { fields: { gst_number: 'invalid' } });
  return up;
}

/** The subset of store settings the customer app is allowed to know about. */
export function clientSettings() {
  const s = settings();
  return {
    store_name: s.store_name,
    store_tagline: s.store_tagline,
    store_phone: s.store_phone,
    store_address: s.store_address,
    shop_open: getBoolSetting('shop_open', true),
    cod_enabled: getBoolSetting('cod_enabled', true),
    min_order_retail: getNumberSetting('min_order_retail', 150),
    min_order_wholesale: getNumberSetting('min_order_wholesale', 0),
    delivery_charge: getNumberSetting('delivery_charge', 0),
    free_delivery_above: getNumberSetting('free_delivery_above', 0),
    eta_minutes: getNumberSetting('eta_minutes', 90),
    wholesale_requires_approval: getBoolSetting('wholesale_requires_approval', true),
    upi_id: s.upi_id,
    demo_otp_visible: !!config.exposeOtp,
  };
}
