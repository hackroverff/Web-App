/**
 * HTTP assembly: security headers, cookies/JSON parsing, session attach, API
 * routers, static PWA shell with sane cache headers, and one JSON error shape.
 */
import express from 'express';
import path from 'node:path';
import { config, PUBLIC_DIR, storageEphemeral } from './config.js';
import { attachIdentity } from './middleware/session.js';
import { rateLimit, clientIp } from './lib/ratelimit.js';
import { AppError } from './lib/errors.js';
import { router as authRouter } from './routes/auth.js';
import { router as catalogRouter } from './routes/catalog.js';
import { router as cartRouter } from './routes/cart.js';
import { router as ordersRouter } from './routes/orders.js';
import { router as ownerRouter } from './routes/owner.js';
import { router as adminRouter } from './routes/admin.js';
import { get, getBoolSetting } from './db/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // --- security headers -----------------------------------------------------
  // CSP is deliberately tight: no third-party scripts, no inline scripts.
  // The app shell is same-origin; product images are local SVGs.
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "worker-src 'self'",
        "font-src 'self' data:",
      ].join('; '),
    );
    const framed = config.frameAncestors !== "'none'";
    res.setHeader(
      'Content-Security-Policy',
      res
        .get('Content-Security-Policy')
        .replace("frame-ancestors 'none'", `frame-ancestors ${config.frameAncestors}`),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!framed) res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    if (config.env === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // --- CORS: off by default (same-origin PWA), opt-in for a future native app --
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // --- CSRF: SameSite=None (embedded clients) removes the browser's own guard, so
  // writes are checked here. A browser always sends Origin on these methods; a foreign
  // origin that is not explicitly allowed is refused.
  const sameSiteHosts = (req) => {
    const hosts = new Set([req.get('host'), req.get('x-forwarded-host'), req.get('x-forwarded-server')]);
    hosts.add(`localhost:${config.port}`);
    hosts.add(`127.0.0.1:${config.port}`);
    return hosts;
  };
  app.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      return next(new AppError(400, 'Malformed Origin header.'));
    }
    if (sameSiteHosts(req).has(host) || config.allowedOrigins.includes(origin)) return next();
    return next(new AppError(403, 'This request was blocked: it came from another site.'));
  });

  app.use(express.json({ limit: '128kb' }));
  app.use((req, _res, next) => {
    if (!req.is('application/json')) req.body = req.body || {};
    next();
  });
  // Reads that are idempotent, cacheable and boring do not need a budget: browsing 57
  // products (plus the service worker revalidating) would otherwise spend the whole
  // allowance of a shared connection and lock a paying customer out mid-cart.
  const isCheapRead = (req) =>
    req.method === 'GET' && (/^\/api\/catalog(\/|$)/.test(req.path) || req.path === '/api/health' || req.path === '/api/auth/diag');

  // Session first, budget second: a signed-in device gets its own bucket instead of sharing
  // one IP with the whole shop (counter tablet, owner laptop and every customer behind the
  // same broadband). Attempts at *getting* a session stay IP-keyed in the auth/PIN limiters.
  app.use(attachIdentity);
  app.use(
    rateLimit({
      name: 'api',
      skip: isCheapRead,
      keyFn: (req) => (req.session ? `session:${req.session.id}` : clientIp(req)),
    }),
  );

  // A session cookie set for an embedded client is mirrored into the JSON body as
  // `session_token`, which the client then sends as Authorization: Bearer. That keeps a
  // preview iframe or a storage-restricted WebView signed in without weakening the
  // HttpOnly cookie path for everybody else.
  app.use('/api', (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => {
      if (res.locals.sessionToken && body && typeof body === 'object' && !Array.isArray(body)) {
        return send({ ...body, session_token: res.locals.sessionToken });
      }
      if (res.locals.clearSessionToken && body && typeof body === 'object' && !Array.isArray(body)) {
        return send({ ...body, session_token: null });
      }
      return send(body);
    };
    next();
  });

  // --- API ------------------------------------------------------------------
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      app: 'Sathvika MV',
      version: '1.0.0',
      env: config.env,
      shop_open: getBoolSetting('shop_open', true),
      products: Number(get('SELECT COUNT(*) AS n FROM products').n || 0),
      users: Number(get('SELECT COUNT(*) AS n FROM users').n || 0),
      orders: Number(get('SELECT COUNT(*) AS n FROM orders').n || 0),
      // Deploy debugging: `ephemeral` means the database is in /tmp because the platform
      // gave us a read-only disk (serverless) — state will not survive an instance recycle.
      storage: storageEphemeral ? 'ephemeral' : 'persistent',
      time: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/owner', ownerRouter);
  app.use('/api/admin', adminRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: { message: `No such endpoint: ${req.method} ${req.originalUrl}` } }));

  // --- PWA shell ------------------------------------------------------------
  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: 0,
      setHeaders(res, filePath) {
        const rel = path.relative(PUBLIC_DIR, filePath);
        if (rel.startsWith('img/products') || rel.startsWith('img' + path.sep + 'categories') || rel.includes('brand')) {
          // Generated art: `npm run reset`/seed repaints these files under the same URL, and a
          // week of `immutable` would pin every card to last week's artwork with no way to force
          // it. Revalidate instead — Express answers these with an ETag, so a hit is a 304.
          res.setHeader('Cache-Control', 'no-cache');
        } else if (rel.startsWith('img')) {
          res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        } else if (rel.startsWith('app') || rel.endsWith('.css')) {
          // Module files are not content-hashed, so revalidate them — a returning visitor
          // must not be pinned to last week's app for a week (the service worker
          // precaches with cache: 'reload' and is what makes repeat visits fast).
          res.setHeader('Cache-Control', 'no-cache');
        } else if (rel.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (rel.endsWith('.html') || rel.endsWith('.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // Deep links (/orders/12, /admin/menu) fall through to the SPA shell.
  // Express 5 needs middleware (not app.get('*')) for a catch-all.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // --- errors ---------------------------------------------------------------
  app.use((req, res, next) => next(new AppError(404, `Not found: ${req.path}`)));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    const body = {
      error: {
        message: status >= 500 ? 'Something went wrong at our end. Please try again.' : err.message,
        code: err.code,
        fields: err.fields,
        details: status >= 500 && config.env !== 'production' ? String(err.stack || err).slice(0, 400) : undefined,
      },
    };
    if (err.cart) body.error.cart = err.cart;
    if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (req.path.startsWith('/api/')) return res.status(status).json(body);
    return res.status(status).send(`<h1>${status}</h1><p>${escapeHtml(err.message || 'Error')}</p>`);
  });

  return app;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
