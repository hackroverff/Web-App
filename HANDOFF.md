# HANDOFF — "Please sign in to continue." while already signed in

Read this before changing anything. Several plausible fixes have already been tried, shipped and
verified; the notes below say which, so they don't get re-litigated.

## 1. What this is

Single-store grocery & provisions app for one shop (English + Tamil): customer accounts with OTP
verification, wholesale pricing slabs with owner approval, cart → order → owner dashboard, plus a
counter/owner portal behind a PIN. It is an installable PWA.

- **Server:** Express 5 on plain Node (`engines.node >= 22.5.0`), SQLite through `node:sqlite`
  (the built-in module — no native dependency, no ORM, no migration runner: `server/db/schema.sql`
  is applied at boot).
- **Client:** hand-written ES modules in `public/app/**`, loaded directly by the browser.
  **There is no build step, no bundler and no framework.** Module URLs are therefore *not*
  content-hashed — this matters a lot for the bug being reported (see §5).
- Only dependency: `express`. No test framework either: `npm test` is `node:test`, and
  `npm run smoke` is a scripted browser-less flow runner.

## 2. The reported symptom (verbatim from the shop owner)

> unable to add item in cart, it says please sign in to continue, though already logined
> unable to login into owner portal
> pin entering page ui looks horrible

The first line is the live issue. "Please sign in to continue." is **not** a client-side guess —
it is the server's 401 body:

- `server/lib/errors.js:13` — `unauthorized(msg = 'Please sign in to continue.')`
- `server/middleware/session.js:149` — `requireCustomer()` raises it when `req.user` is empty.
  Every cart/order write goes through it (`server/routes/cart.js`, `server/routes/orders.js`).

So the request **was** sent and the server did not recognise the session. Two families of causes:
(A) the shell being executed is an older build than the one in this repo (see §5), or (B) the
credential did not survive the trip (see §3–§4).

## 3. How a session is carried (the whole model)

1. `POST /api/auth/login` (or `/verify` after signup, or `/api/owner/login` for the PIN) calls
   `createSession()` → a random token. The DB stores only `token_hash = sha256(cookieSecret|token)`,
   so a leaked DB cannot be replayed.
2. The token is returned to the browser in **two** channels:
   - `Set-Cookie: smv_session=<token>` — attributes from `cookieAttrs(req)`:
     `SameSite=lax` for a normal tab; `SameSite=None; Secure; Partitioned` when the request is
     judged **embedded** (`isEmbedded(req)`: `x-app-context: embedded`, or `sec-fetch-dest:
     iframe|frame|embed|object`, or `sec-fetch-site: cross-site|same-site-ancestor`).
   - `session_token` in the JSON **body**, mirrored by the `/api` middleware in `server/app.js`
     whenever `res.locals.embedded || res.locals.wantBearer` and `config.allowBearer`.
     `wantBearer` is set from the request header `x-want-bearer: 1`, which `public/app/core/api.js`
     sends on **every** call. That is what keeps a shopper signed in when a proxy drops
     `Set-Cookie`, when the frame may not store anything, or when the shop is opened at
     `http://192.168.x.x:4173` from a tablet (a `Secure` cookie cannot exist there).
3. `attachIdentity` (`server/middleware/session.js`) then reads either credential —
   `Authorization: Bearer <token>` takes precedence over the cookie — and populates `req.user`,
   `req.staff`, `req.session`. Owner `admin` sessions lazily downgrade to `ops` after
   `config.elevatedMinutes`, which is why some owner writes 403 rather than 401 (403 is *not* a
   sign-in failure; the client's 401-replay logic must not try to "fix" it).
4. On the client, the mirrored token is kept in memory **and** in `localStorage`/`sessionStorage`
   (`public/app/core/storage.js`), because in a frame `localStorage` can throw and
   `sessionStorage` dies with the tab.

Turn the body-mirror off entirely with `BEARER_TOKENS=0` (then framed clients must be able to keep
a cookie or they cannot sign in — that switch is for production hardening, not for debugging).

## 4. Environment variables that change this behaviour

`COOKIE_SECRET` (signs session hashes — **changing it revokes every session**), `SESSION_DAYS`,
`SECURE_COOKIES`, `SAME_SITE`, `SAME_SITE_AUTO`, `BEARER_TOKENS`, `ALLOWED_ORIGINS` (opt-in CORS;
empty means same-origin only), `FRAME_ANCESTORS` (CSP `frame-ancestors`; the preview launcher sets
`'self' *`), `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` / `OWNER_PIN_RATE_MAX`, `DATA_DIR`,
`EXPOSE_OTP`, `ELEVATED_MINUTES`, `NODE_ENV`.

`GET /api/health` reports catalogue counts plus `storage: persistent|ephemeral` — `ephemeral` means
the DB is in `/tmp` because the platform gave a read-only disk, so sessions cannot survive an
instance recycle. `GET /api/auth/diag` reports what the server received for *your* request — see §6.

## 5. The build-staleness trap (this is why "same error" kept happening)

`public/sw.js` is a service worker. Historically it answered every same-origin GET with
`caches.match(req) || fetch(req)` — cache-first — for `/app/**.js`, `/styles/app.css` and
`/img/products/*.svg`. None of those URLs change when the files change, so a browser holding a
copy of the old shell never asked the server and **no number of reloads would show a fix**. A
screenshot from such a browser looks exactly like "the bug is not fixed".

Current policy (keep it): `VERSION` bump per deploy; **network-first** for
`/app/`, `/styles/`, `/img/products/`, `/img/categories/` (they are served `no-cache`, so a hit is
a cheap 304 and the cache still answers offline); cache-first + 7-day immutable for icons/logo;
`skipWaiting()` + `clients.claim()`; `public/app/main.js` reloads once on `controllerchange`
*only* when a controller already existed (otherwise a first visit loops). `index.html` and `sw.js`
are served `no-store` by `setHeaders` in `server/app.js`.

Corollary: **never** reintroduce cache-first for unhashed code, and never put regenerated files
(the seed paints SVG artwork at fixed paths) behind an `immutable` URL.

## 6. Diagnose in this order

0. Confirm which build is running. `curl -s <origin>/sw.js | grep VERSION` must match the repo, and
   `curl -s <origin>/app/core/api.js | grep x-want-bearer` must be non-empty. If either fails, stop
   — the deployed code is old (redeploy, or click "Reload a fresh copy" on the sign-in screen).
1. Reproduce with a fresh, framed request pair and read the server's view:
   ```bash
   B=https://the-host
   curl -si -X POST $B/api/auth/login -H 'content-type: application/json' \
        -H 'x-app-context: embedded' -H 'x-want-bearer: 1' -H "Origin: $B" \
        -d '{"mobile":"9840012345","password":"priya@123"}' | grep -i '^set-cookie\|session_token'
   curl -s $B/api/auth/diag -H "Authorization: Bearer <session_token from above>"
   ```
2. `GET /api/auth/diag` returns exactly:
   ```json
   { "ok": true, "embedded": true, "cookie_present": false, "bearer_present": true,
     "session_valid": true, "level": "basic", "signed_in_as": "9840012345",
     "policy": { "same_site_auto": true, "base_same_site": "lax", "secure_cookies": false,
                 "bearer_tokens": true, "partitioned_when_embedded": true, "allowed_origins": [] },
     "request": { "host": "…", "forwarded_host": null, "origin": "…", "sec_fetch_site": null,
                  "sec_fetch_dest": null, "storage": "persistent" },
     "rate": { "remaining": 597 } }
   ```
   The same screen exists **in the app** ("Check this session", reachable from the sign-in screen,
   the owner PIN pad, and as an action on the toast when a request comes back unsigned).
3. Check the limiter before believing an auth bug: "Too many attempts from this device — try again
   in N minutes." is a 429 from `server/lib/ratelimit.js` (in-memory, fixed window, keyed by client
   IP — a shared NAT/preview proxy means one bucket for everyone; GET `/api/catalog*`,
   `/api/health`, `/api/auth/diag` are exempt).
4. Only then touch the app logic.

### Reading the diag values

| diag | meaning | fix |
| --- | --- | --- |
| `cookie_present:true, session_valid:true` | server is fine | whatever you saw came from an old build → §5 |
| `cookie_present:false, bearer_present:true, session_valid:true` | cookie not kept, token path working | expected inside a locked-down frame; nothing to fix |
| `cookie_present:false, bearer_present:false` | nothing came back | browser blocked storage (check `storageAvailable()` / the app's warn banner), or a proxy stripped `Set-Cookie`, or `COOKIE_SECRET` changed → sessions revoked → sign in again |
| `session_valid:false, cookie_present:true` | token is real but unknown to this DB | ephemeral disk (serverless `/tmp`): a different instance answers. Not an auth bug — the storage is (see `DEPLOY.md`) |
| `embedded:true` with `policy.secure_cookies:false` and no TLS | `SameSite=None` without `Secure` | the browser refuses to store that cookie; serve the app over https, or leave the frame |
| `request.forwarded_host` differs from `request.host` | a proxy rewrote the host | the CSRF guard in `server/app.js` trusts the forwarded host; a mismatch makes writes fail in ways that look like auth |
| `embedded:true` for a plain tab | framing inferred wrongly | `isEmbedded` must key off headers, **never** off the presence of a bearer token (that bug forced `Secure` onto LAN http sign-ins) |

## 7. Decisions already made — do not re-litigate

- A bearer token does **not** imply an embedded client. Framing decides cookie attributes;
  `x-want-bearer` decides whether the body carries a copy.
- `x-app-context: embedded` is sent only when `window.self !== window.top`.
- The client adopts `session_token` from *any* response body that contains it
  (`'session_token' in data`), so a token issued by login/verify/owner-login is never lost.
- Owner elevation failures are 403; the client's 401 probe-and-replay must not treat them as
  sign-in loss.
- Gate screens (owner PIN, sign-in) use an in-flow `min-height:100dvh` flex wrapper plus
  `body:has(.keypad-card)`; `position:fixed` there is unreliable because view transitions animate
  with `both`, which makes transformed/filter/`contain` ancestors the containing block (that is how
  the "half dark page" screenshot happened).
- Product/category artwork is generated SVG (`server/seed/images.js`). It must not draw the product
  name (the card already prints it — long strings collided in the small viewBox). `ensureProductImages`
  skips writing when bytes are unchanged, otherwise a test run against a throwaway DB rewrites the
  57 tracked SVGs.
- `scripts/check-frontend.mjs` is a project-specific static sweep (i18n keys used vs. defined, CSS
  classes, icons, api paths, used-but-not-imported identifiers). Keep it green; it catches whole
  classes of client bugs.

## 8. Run it

```bash
npm install            # only `express`; no build step
npm run reset          # recreate data/sathvika.db + seed catalogue + paint SVG artwork
npm run start:preview  # :4173, frame-agnostic + generous rate limits (for embeds/preview proxies)
npm test               # node:test API suite
npm run smoke          # scripted full flows against a running server
node scripts/check-frontend.mjs
```

Demo accounts: retail `9840012345 / priya@123`, wholesale `9840034567 / balaji@123`, Tamil
`9840023456 / gokul@1234`, pending wholesale `9840045678 / newmumbai@123`, owner PIN `4321`,
owner password `sathvika@owner2026`, staff PIN `1234`. OTP codes are echoed in the response when
`EXPOSE_OTP=1` (the preview default) and are also readable in the in-app outbox.

Note `SameSite`/`Secure` rules mean `curl` cannot store a `Secure` cookie over http — pass the
token explicitly with `-b "smv_session=<token>"` or `-H "Authorization: Bearer <token>"`.
`curl -H "Host: https://host"`-style overrides trip the CSRF guard in `server/app.js`; set
`Host`/`Origin` to bare authorities.

## 9. Where things live

| path | what |
| --- | --- |
| `server/app.js` | middleware order: headers/`no-cache` rules → CORS (opt-in) → CSRF-on-forwarded-host → JSON → `/api` wrapper that injects `session_token` → routers → SPA fallback |
| `server/middleware/session.js` | `isEmbedded`, `cookieAttrs`, `createSession`, `attachIdentity`, `setSessionCookie`, `requireCustomer/Owner/Elevated` |
| `server/routes/auth.js` | register → verify OTP → login, `GET /api/auth/diag`, addresses, password change |
| `server/routes/cart.js`, `orders.js` | cart writes and checkout (all behind `requireCustomer`) |
| `server/routes/owner.js`, `admin.js` | PIN/OTP login, shift dashboard, catalogue & approval admin |
| `server/lib/cookies.js` | cookie serialisation incl. `Partitioned` (only with `None` + `Secure`) |
| `server/lib/ratelimit.js` | fixed-window limiter + `clientIp` |
| `public/app/core/api.js` | every request: headers, credential adoption, offline mirror, 401 probe-and-replay |
| `public/app/core/session-check.js` | the in-app diagnostics sheet |
| `public/app/core/store.js`, `storage.js` | app state; storage that tolerates a blocked frame |
| `public/app/views/*.js`, `public/app/owner/*.js` | screens (vanilla `h()` DOM helpers in `core/dom.js`) |
| `public/app/core/i18n.js` | flat `{key: [en, ta]}` dictionary; it imports nothing, so it stays usable from the service worker and the sweep in §7 |
| `public/sw.js` | precache list + cache policy (see §5) |
| `scripts/check-frontend.mjs` | static sweep described in §7 |
| `DEPLOY.md` | three deployment routes (Vercel + volume, Vercel + managed DB, Docker/Fly) and why serverless SQLite is demo-only |

## 10. Still open, by the way

`public/img/brand/source.png` is a placeholder; the owner has not supplied the real logo yet.
`npm run logo` regenerates all icons and `public/img/logo.svg` from it.
