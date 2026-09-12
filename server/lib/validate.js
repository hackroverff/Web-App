/** Input validation + normalisation. Every route reads the body through these. */
import { badRequest } from './errors.js';

export const MOBILE_RE = /^[6-9]\d{9}$/;
export const GST_RE = /^[1-5]\d[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Accepts 9840000000, +91-98400 00000, 09840000000 etc. */
export function normaliseMobile(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 10 && digits.startsWith('91')) return digits.slice(-10);
  if (digits.length > 10 && digits.startsWith('0')) return digits.replace(/^0+/, '').slice(-10);
  return digits;
}

export function str(value, { field = 'value', max = 500, min = 0, trim = true, required = true } = {}) {
  let v = value === null || value === undefined ? '' : String(value);
  if (trim) v = v.trim().replace(/\s+/g, ' ');
  if (required && !v) throw badRequest(`${field} is required.`, { fields: { [field]: 'required' } });
  if (v.length > max) throw badRequest(`${field} must be under ${max} characters.`, { fields: { [field]: 'too_long' } });
  if (v.length < min) throw badRequest(`${field} must be at least ${min} characters.`, { fields: { [field]: 'too_short' } });
  return v;
}

export function mobile(value, { field = 'Mobile number', required = true } = {}) {
  const m = normaliseMobile(value);
  if (!m) {
    if (required) throw badRequest(`${field} is required.`, { fields: { [field]: 'required' } });
    return '';
  }
  if (!MOBILE_RE.test(m)) {
    throw badRequest('Enter a valid 10-digit Indian mobile number.', { fields: { [field]: 'invalid' } });
  }
  return m;
}

export function password(value, { field = 'Password', required = true, min = 8 } = {}) {
  const v = value === null || value === undefined ? '' : String(value);
  if (!v) {
    if (required) throw badRequest(`${field} is required.`, { fields: { [field]: 'required' } });
    return '';
  }
  if (v.length < min) throw badRequest(`${field} must be at least ${min} characters.`, { fields: { [field]: 'too_short' } });
  if (v.length > 200) throw badRequest(`${field} is too long.`, { fields: { [field]: 'too_long' } });
  return v;
}

export function pin(value, { field = 'PIN', min = 4, max = 6 } = {}) {
  const v = String(value ?? '').trim();
  if (!/^\d+$/.test(v)) throw badRequest(`${field} must be digits only.`, { fields: { [field]: 'invalid' } });
  if (v.length < min || v.length > max) throw badRequest(`${field} must be ${min}-${max} digits.`, { fields: { [field]: 'length' } });
  return v;
}

export function amount(value, { field = 'Price', min = 0, max = 1_000_000, required = true } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (required) throw badRequest(`${field} is required.`, { fields: { [field]: 'required' } });
    return null;
  }
  const n = Number(String(value).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`, { fields: { [field]: 'invalid' } });
  if (n < min) throw badRequest(`${field} cannot be less than ${min}.`, { fields: { [field]: 'min' } });
  if (n > max) throw badRequest(`${field} looks too large.`, { fields: { [field]: 'max' } });
  return Math.round(n * 100) / 100;
}

export function intIn(value, { field = 'value', min = 0, max = 100000, fallback = null, required = false } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (required) throw badRequest(`${field} is required.`, { fields: { [field]: 'required' } });
    return fallback;
  }
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a whole number.`, { fields: { [field]: 'invalid' } });
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}.`, { fields: { [field]: 'range' } });
  return n;
}

export function oneOf(value, allowed, { field = 'value', fallback = null, required = true } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (required) {
      if (fallback !== null && allowed.includes(fallback)) return fallback;
      throw badRequest(`${field} is required.`, { fields: { [field]: 'required' } });
    }
    return fallback;
  }
  const v = String(value).trim();
  if (!allowed.includes(v)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`, { fields: { [field]: 'invalid' } });
  }
  return v;
}

export function optStr(value, { field = 'value', max = 300 } = {}) {
  if (value === '' || value === null || value === undefined) return null;
  return str(value, { field, max, required: false });
}

export const UNITS = ['kg', 'g', 'litre', 'ml', 'piece', 'packet', 'box', 'dozen'];
export const BUSINESS_TYPES = ['shop', 'restaurant', 'canteen', 'office', 'institution', 'other'];

export function escapeLike(term) {
  return String(term).replace(/[%_"']/g, ' ').trim();
}
