/** Fixed-window in-memory rate limiter. Single process, single store — plenty. */
import { config } from '../config.js';
import { tooMany } from './errors.js';

const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref?.();

export function rateLimit({ name, max = config.rateLimitMax, windowMs = config.rateLimitWindowMs, keyFn } = {}) {
  return (req, _res, next) => {
    if (!config.rateLimitEnabled) return next();
    const key = `${name || 'global'}:${keyFn ? keyFn(req) : clientIp(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    req.rate = { remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
    if (bucket.count > max) {
      const minutes = Math.max(1, Math.ceil((bucket.resetAt - now) / 60_000));
      _res.setHeader('Retry-After', Math.max(1, Math.round((bucket.resetAt - now) / 1000)));
      return next(tooMany(`Too many attempts from this device — try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`));
    }
    next();
  };
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** Simple named counter for OTP resend guards. */
export function hit(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

export function clearHits(prefix, keyPart) {
  for (const key of buckets.keys()) if (key.startsWith(prefix) && key.includes(keyPart)) buckets.delete(key);
}
