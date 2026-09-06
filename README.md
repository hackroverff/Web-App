# Sathvika MV

A mobile-first ordering app for a family-run grocery & provision store in Chennai — retail customers
ordering from their phone, and the counter/owner running the whole shop (shift, order flow, payments,
stock, wholesale approvals) from a tablet. English + Tamil, installable as a PWA, works offline.

**No build step, no framework, no native modules.** One Express 5 server, the SQLite driver that ships
inside Node (`node:sqlite`), and a vanilla ES-module front end that the browser loads directly.
`npm install` pulls exactly one dependency: `express`.

```bash
npm install
npm start          # http://localhost:4173  · first boot seeds demo data automatically
```

Requires **Node ≥ 22.5** (for `node:sqlite`). Everything below — demo accounts, seeded catalogue,
icons and product artwork — is generated locally, so the app is complete without any network access.

---

## Try it

| Who | How |
| --- | --- |
| Retail customer | `9840012345` / `priya@123` — T. Nagar home order, saved address, live cart |
| Tamil-first customer | `9840023456` / `gokul@1234` — account language is Tamil, the UI follows it |
| Wholesale (approved) | `9840034567` / `balaji@123` — slab pricing, MOQ of 6, ₹2,500 minimum order |
| Wholesale (pending) | `9840045678` / `newmumbai@123` — sees retail prices until the owner approves |
| Wholesale (suspended) | `9840056789` / `koyambedu@123` — blocked at login with the reason |
| **Owner** | PIN `4321` for the counter, password `sathvika@owner2026` to unlock pricing/settings |
| Counter staff | PIN `1234` — order flow and payments, no price or catalogue edits |

Owner screens live under `/owner`. New signups verify by OTP; in demo mode the code is echoed in the
UI (`EXPOSE_OTP=1`) so you never need an SMS gateway.

Seed data: 57 products across 35 categories and 32 brands, 15 products with quantity slabs,
7 accounts, 13 orders spread over several days and statuses, one open shift, notification history.
`npm run reset` wipes and re-seeds; `npm run seed` re-seeds only an empty database.

## What the code insists on

Money is never the client's opinion — it is what the server computes, twice.

- **Prices, slabs, discounts, delivery charge, savings** come from `server/services/pricing.js`.
  The browser renders numbers it received; it never adds, rounds or discounts on its own. The cart is
  re-priced on every mutation, and `POST /api/orders` re-prices again inside a transaction before it
  writes the order rows. Editing localStorage changes nothing.
- **Quantity rules are enforced where they are defined**: retail `min_qty`/`max_qty` per product,
  wholesale MOQ, slab boundaries (`min_qty ≤ qty < max_qty`, last slab open-ended, slabs may not
  overlap), out-of-stock and inactive products blocked, minimum order value for delivery, free delivery
  above a threshold. The same helper answers the quantity stepper, the cart and checkout, so the three
  can never disagree.
- **Two-level owner auth.** The 4-digit PIN (scrypt + `PIN_PEPPER`) opens the counter screen and everything
  that is *operationally* safe: order status, payments received, void, shift open/close, stock count,
  active toggle, shop open/closed, wholesale **reads**. Price edits, product/category CRUD, settings and
  exports additionally require the password, which unlocks the session for `ELEVATED_MINUTES` (30 by
  default) and then falls back to PIN-only. A wrong PIN at the keypad is rate-limited independently.
- **Sessions work inside a frame too.** A cookie alone breaks the moment the app is opened
  in another site's iframe (device preview, kiosk embed): the browser refuses a `SameSite=Lax`
  cookie from a third-party frame, so you appear signed in and then every cart write 401s. The
  server reads `Sec-Fetch-Dest` / `X-App-Context`, upgrades that client to `SameSite=None; Secure`
  and mirrors the token into the login response, which the client replays as `Authorization: Bearer`.
  Because `SameSite=None` removes the browser's CSRF guard, writes are origin-checked on the server.
  Top-level visitors get the plain Lax cookie and no token in the body. Embedding is still refused
  by default — `FRAME_ANCESTORS` opts a host in (`npm run start:preview` does it for the demo).
- **Row-level scoping.** A customer's cart, orders and addresses are keyed by their own `user_id` in every
  query — the tests assert that another signed-in customer gets 403/404 on someone else's order id.
- **Idempotent + auditable.** UPI references are unique per order (double-submit returns the first order),
  every owner action writes `audit_log`, every payment transition writes `payment_events`, voiding restores
  stock and removes the order from shift totals without deleting the row.
- **Sessions** are random 256-bit tokens stored as a SHA-256 hash in `sessions`, delivered as an
  `HttpOnly SameSite=Lax` cookie; logout revokes the row, so a stolen cookie dies with it.

## Bilingual by construction

Every string in the UI comes from one dictionary (`public/app/core/i18n.js`, 503 keys,
`['English', 'தமிழ']` pairs), so a missing translation is a build-time check, not a 3 a.m. bug.
Products, categories and brands carry Tamil names in the database and fall back to English per field.
An account's `lang` is applied at login, and the toggle re-renders the current screen in place.
Addresses, order notes and item names stay in whichever language the customer typed them in — that is
what the counter needs to read them.

## Your logo, your icons

The app carries one brand asset: `public/img/logo.svg` (splash, both headers, the PIN pad,
favicon) plus four PNGs for the manifest and launchers. `npm run logo` rebuilds all of them,
and if you drop the real artwork in first, it uses that instead of the drawn crest:

```bash
cp /path/to/sathvika-logo.png public/img/brand/source.png   # square-ish PNG, ≥512×512
npm run logo                                                # → logo.png, logo.svg, icon-192/512, maskable
```

Resizing, maskable safe-zone padding and PNG encoding are done in `scripts/build-logo.js`
with no dependencies (no ImageMagick, no canvas). Anything non-square is centre-cropped
before scaling, transparency is flattened onto white for the launcher icons and onto cream
for the maskable ones.

## Offline

`public/sw.js` precaches the shell, styles, icons and product art (cache-first), serves
`GET /api/catalog/*` stale-while-revalidate so browsing never stalls on a bad network, and **never**
caches cart, orders, auth or anything under `/api/owner` — a stale cart is a wrong bill. Navigations fall
back to the cached shell; `navigator.onLine` plus a failed request mark the app offline, the banner says
so, and the catalogue you last saw stays readable. Installing it as a home-screen app gets you the catalogue on a train.

## Layout

```
server/
  app.js            express wiring, security headers, static, routers, error envelope
  config.js         every env override in one place
  db/               schema.sql (idempotent) + a small synchronous wrapper
  lib/              money, password/pin, validate, otp, ratelimit, cookies, notify, audit, errors
  services/         pricing · catalog · cart · orders  ← all the rules live here
  routes/           auth · catalog · cart · orders · owner · admin
  seed/             data.js (accounts, catalogue, orders) + images.js (generated SVG art)
  test/api.test.js  15 end-to-end cases against a throwaway database
public/
  index.html        the shell — one <script type=module>, no inline JS (CSP)
  app/core/         dom · icons · api · store · i18n · format · components · router
  app/views/        landing · auth · shop · cart · orders · profile · misc(offline)
  app/owner/        shared (shell, elevate) · dashboard · admin (menu, approvals, payments, …)
  styles/app.css    one 541-line stylesheet, design tokens + ~110 component classes
  img/              logo, maskable icons, per-product and per-category art
  sw.js             service worker
scripts/
  build-logo.js     brand art: resizes public/img/brand/source.png into logo + all icon sizes
                    (pure-Node PNG decode/encode — no ImageMagick, no canvas)
  check-frontend.mjs  static sweeps: i18n keys, icons, imports, API paths, identifiers, CSS classes
  smoke-frontend.mjs  renders every screen against the real API
```

## Checking it

```bash
npm test                 # 16 API cases: pricing, slabs, MOQ, checkout, void, elevation, framing
npm run smoke            # 35 steps that render every screen and drive the real flows
node scripts/check-frontend.mjs
```

The API tests boot the actual app on an ephemeral port with `DATA_DIR` in a temp directory, so demo data
is never touched. `npm run smoke` does the same for the front end: it boots its own server with rate
limiting off, imports the real modules under a small DOM/`window`/cookie shim, and walks the flows —
login, register + OTP, catalogue filtering, add to cart, steppers, checkout preview, order placement,
tracking, language switch, owner PIN, dashboard, menu editor (create + stock), approvals, payments,
scratch void, history, messages, settings, and the bearer/cookie behaviour of a framed client.
Each step fails on a thrown error, a `console.error`, *or* an
unhandled rejection, which is how it caught an owner screen calling `money()` that was never imported and
a view that returned its node instead of mounting it. Use `SMOKE_BASE=http://127.0.0.1:4173 npm run smoke`
to point it at a server you already have running.

The `check-frontend.mjs` sweeps exist because a zero-build app has no compiler to catch a typo: every
`t('key')` must exist in the dictionary, every `icons.x` must be a real icon, every `class` token must
appear in `app.css`, every `/api/...` path must exist on a router, and every called identifier must be
imported.

## Configuration

All optional; copy `.env.example` or set variables directly.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `4173` / `0.0.0.0` | |
| `DATA_DIR` / `DB_FILE` | `./data` / `sathvika.db` | WAL mode; delete the file to start clean |
| `OWNER_PIN` / `OWNER_PASSWORD` / `PIN_PEPPER` | demo values | change before real use; pepper protects the 4-digit keyspace |
| `COOKIE_SECRET` | random, persisted in `DATA_DIR` | keeps sessions alive across restarts |
| `SESSION_DAYS` / `ELEVATED_MINUTES` | `30` / `30` | elevation drops back to PIN-only automatically |
| `EXPOSE_OTP` | `1` | **set to `0` for production** — codes stop appearing in API responses |
| `RATE_LIMIT` / `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | on / `120` / `15` / `600000` | `RATE_LIMIT=0` disables limiting (tests, local demos) |
| `OTP_TTL_MINUTES` / `OTP_MAX_ATTEMPTS` | `5` / `5` | |
| `SECURE_COOKIES` / `SAME_SITE` | `0` / `lax` | turn on `SECURE_COOKIES` once you have HTTPS |
| `NOTIFY_PROVIDER` / `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_TOKEN` / `NOTIFY_SENDER_ID` | `log` | `log` writes to the in-app outbox; `webhook` POSTs to your SMS/WhatsApp gateway |
| `UPI_INTENT_SCHEME` | `upi` | used to build the `upi://pay` link on the payment screen |

## Before this goes live

1. Change the owner PIN and password, and set `PIN_PEPPER` + `COOKIE_SECRET` (never commit them).
2. `EXPOSE_OTP=0`, `SECURE_COOKIES=1`, HTTPS in front of Node, and a real OTP provider — or point
   `NOTIFY_PROVIDER=webhook` at your MSG91/Twilio/Gupshup sender.
3. Back up `data/` (it is the whole app: one SQLite file, WAL sidecars included).
4. Replace generated product artwork with photos when you have them — the `products.image` column takes a
   URL, and `/img/products/placeholder-1.svg` covers anything without one.
5. One caveat worth knowing: the customer and owner session share a cookie, so signing into `/owner` on a
   device replaces the shopper session on that same device. Two tablets (counter + owner) is the intended
   setup; split the cookie if you need both identities in one browser.
