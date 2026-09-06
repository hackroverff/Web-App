/**
 * Central configuration. Everything is env-overridable so the same build can run
 * on a phone tether, a cheap VPS, or a developer laptop without code changes.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const requestedDataDir = () => path.resolve(ROOT, process.env.DATA_DIR || 'data');

/**
 * Serverless hosts (Vercel Functions, Lambda) mount the deployment read-only and allow
 * writes only under /tmp, so `data/` cannot hold the SQLite file there. Rather than dying
 * at boot, fall back to a temp directory: the app then runs as a self-contained demo whose
 * state resets whenever the instance is recycled. A normal server or container keeps using
 * the on-disk data directory and is unaffected.
 */
function resolveDataDir() {
  const wanted = requestedDataDir();
  try {
    fs.mkdirSync(wanted, { recursive: true });
    fs.accessSync(wanted, fs.constants.W_OK);
    return { dir: wanted, ephemeral: false };
  } catch {
    const dir = path.join(os.tmpdir(), 'sathvika-mv');
    fs.mkdirSync(dir, { recursive: true });
    return { dir, ephemeral: true };
  }
}

const dataDir = resolveDataDir();
export const DATA_DIR = dataDir.dir;
/** True when the app could not keep its database on the deployment's disk. */
export const storageEphemeral = dataDir.ephemeral;
export const PUBLIC_DIR = path.resolve(ROOT, 'public');

/**
 * Persist a random cookie-signing secret on first boot so sessions survive restarts
 * without forcing the operator to configure anything.
 */
function resolveCookieSecret() {
  if (process.env.COOKIE_SECRET) return process.env.COOKIE_SECRET;
  const f = path.join(DATA_DIR, '.cookie-secret');
  try {
    if (fs.existsSync(f)) {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v) return v;
    }
  } catch {
    /* fall through */
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const v = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(f, v, { mode: 0o600 });
  } catch {
    /* in-memory only; sessions reset on restart */
  }
  return v;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4173),
  host: process.env.HOST || '0.0.0.0',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  dbFile: path.join(DATA_DIR, process.env.DB_FILE || 'sathvika.db'),

  // Security
  cookieSecret: resolveCookieSecret(),
  sessionDays: num(process.env.SESSION_DAYS, 30),
  elevatedMinutes: num(process.env.ELEVATED_MINUTES, 30),
  secureCookies: bool(process.env.SECURE_COOKIES, false),
  sameSite: process.env.SAME_SITE || 'lax',
  // When the app runs inside a frame (embeds, device previews) a SameSite=Lax cookie is
  // dropped by the browser, so every request comes back anonymous. With this on the
  // server detects that context and switches to SameSite=None; Secure for that client.
  sameSiteAuto: bool(process.env.SAME_SITE_AUTO, true),
  // Bearer copy of the same session token, handed to the client only when it asked from
  // an embedded context. It keeps the app signed in even when cookie storage is blocked.
  allowBearer: bool(process.env.BEARER_TOKENS, true),
  // CSP frame-ancestors / X-Frame-Options. 'none' for production; a preview host needs
  // FRAME_ANCESTORS="*" (or an allow-list of origins) to be embeddable at all.
  frameAncestors: process.env.FRAME_ANCESTORS || "'none'",

  // OTP: in demo/dev mode the API also returns the code so the flow is testable
  // without an SMS provider. Never enable in production.
  exposeOtp: bool(process.env.EXPOSE_OTP, true),
  otpTtlMinutes: num(process.env.OTP_TTL_MINUTES, 5),
  otpMaxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 5),

  rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
  rateLimitMax: num(process.env.RATE_LIMIT_MAX, 120),
  authRateLimitMax: num(process.env.AUTH_RATE_LIMIT_MAX, 15),
  // The counter keypad is typed by hand in front of a queue, so it gets its own,
  // slightly kinder budget than the signup/login endpoints.
  ownerPinRateMax: num(process.env.OWNER_PIN_RATE_MAX, 20),
  // RATE_LIMIT=0 switches every limiter off — handy for the automated smoke run
  // and for a reviewer clicking through the owner screens twice in a minute.
  rateLimitEnabled: bool(process.env.RATE_LIMIT, true),

  // Short PINs need a pepper so a stolen DB cannot be brute-forced offline.
  pinPepper: process.env.PIN_PEPPER || 'sathvika-mv-v1',
  ownerPin: process.env.OWNER_PIN || '4321',
  ownerPassword: process.env.OWNER_PASSWORD || 'sathvika@owner2026',

  notify: {
    provider: process.env.NOTIFY_PROVIDER || 'log',
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
    webhookToken: process.env.NOTIFY_WEBHOOK_TOKEN || '',
    senderId: process.env.NOTIFY_SENDER_ID || 'SMVSPT',
  },
  upiScheme: process.env.UPI_INTENT_SCHEME || 'upi',
};

export const isProd = config.env === 'production';
