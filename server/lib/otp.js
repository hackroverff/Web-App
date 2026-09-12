/**
 * Mobile-number OTP: issue, verify, resend-throttle. Codes are stored hashed and
 * are single-use. In demo mode (EXPOSE_OTP=1) the code is also returned to the
 * client so the whole flow is testable without an SMS provider.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { get, run, all } from '../db/index.js';
import { badRequest, tooMany } from './errors.js';
import { hit, clearHits } from './ratelimit.js';
import { sendOtp } from './notify.js';

const RESEND_WINDOW_MS = 60_000;
const RESEND_MAX = 3;

function hashCode(code) {
  return crypto.createHash('sha256').update(`${config.cookieSecret}|otp|${code}`).digest('hex');
}

export async function issueOtp({ mobile, purpose = 'register', userId = null, payload = null, lang = 'en' }) {
  if (!hit(`otp:${mobile}`, RESEND_MAX, RESEND_WINDOW_MS)) {
    throw tooMany('You have requested too many codes. Please wait 60 seconds and try again.');
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + config.otpTtlMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);

  // Any previous unconsumed code for this number/purpose is invalidated first.
  run('UPDATE otps SET consumed=1 WHERE mobile=? AND purpose=? AND consumed=0', [mobile, purpose]);
  run('INSERT INTO otps (mobile, code_hash, purpose, user_id, payload, expires_at) VALUES (?,?,?,?,?,?)', [
    mobile,
    hashCode(code),
    purpose,
    userId,
    payload ? JSON.stringify(payload) : null,
    expiresAt,
  ]);

  clearHits('otp:', mobile);
  // First hit was consumed above by hit(); allow exactly one display/send per issue.
  await sendOtp({ mobile, code, purpose, lang });

  return {
    expires_in: config.otpTtlMinutes * 60,
    debug_otp: config.exposeOtp ? code : undefined,
    channel: config.notify.provider === 'log' ? 'in-app outbox (no SMS gateway configured)' : 'sms',
  };
}

export function verifyOtp({ mobile, code, purpose }) {
  const input = String(code ?? '').trim();
  if (!/^\d{6}$/.test(input)) throw badRequest('Enter the 6-digit code we sent you.');

  const row = get(
    `SELECT * FROM otps WHERE mobile=? AND purpose=? AND consumed=0 ORDER BY id DESC LIMIT 1`,
    [mobile, purpose],
  );
  if (!row) throw badRequest('We could not find an active code for this number. Request a new one.');

  if (new Date(`${row.expires_at}Z`).getTime() < Date.now()) {
    run('UPDATE otps SET consumed=1 WHERE id=?', [row.id]);
    throw badRequest('That code has expired. Request a new one.');
  }
  if (row.attempts >= config.otpMaxAttempts) {
    run('UPDATE otps SET consumed=1 WHERE id=?', [row.id]);
    throw tooMany('Too many wrong attempts. Please request a new code.');
  }
  if (row.code_hash !== hashCode(input)) {
    run('UPDATE otps SET attempts=attempts+1 WHERE id=?', [row.id]);
    const left = Math.max(0, config.otpMaxAttempts - (row.attempts + 1));
    throw badRequest(`That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`);
  }

  run('UPDATE otps SET consumed=1 WHERE id=?', [row.id]);
  return { otpId: row.id, payload: row.payload ? safeJson(row.payload) : null };
}

export function hasActiveOtp(mobile, purpose) {
  return !!get('SELECT id FROM otps WHERE mobile=? AND purpose=? AND consumed=0 LIMIT 1', [mobile, purpose]);
}

export function recentOtps(mobile, limit = 5) {
  return all('SELECT id, purpose, consumed, created_at, expires_at FROM otps WHERE mobile=? ORDER BY id DESC LIMIT ?', [mobile, limit]);
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
