# Deploying Sathvika MV

The app is one Node process: an Express API, the PWA shell it serves from `public/`, and one
SQLite file in `data/`. That single fact decides where it can run — and Vercel is a good home
for the shell and a bad one for the file. Three options below; A is the one to run a real shop
on, B is already wired in this repo if you just want a link to show someone.

## Why Vercel needs a decision first

Vercel gives you two primitives: static files on a CDN, and stateless functions. A function's
filesystem is **read-only**; only `/tmp` is writable, it caps at ~500 MB, and it is discarded
whenever the instance is recycled (functions also archive when idle). There is no volume and no
"keep this file between deploys". SQLite needs exactly that. Their own KB says as much —
"SQLite needs a local file system to store the data permanently… that permanent storage is not
available" ([vercel.com/kb/guide/is-sqlite-supported-in-vercel](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)),
and even the beta Container Images path is "the same limits" as functions, scale-to-zero after
5 idle minutes included
([vercel.com/docs/functions/container-images](https://vercel.com/docs/functions/container-images)).

| | On Vercel | Where orders live | Work | Good for |
| --- | --- | --- | --- | --- |
| **A — split** | the PWA shell + `/api` proxied | your own persistent host (Fly.io / Render / Railway / a ₹500 VPS) | ~30 min | **the real shop** |
| **B — all-in demo** | shell + Express as one captured server | `/tmp` on one instance, evaporates | done already | a link to hand someone |
| **C — all-in real** | shell + functions | a hosted DB (Turso / Vercel Postgres) | 1–2 days | only if "100% Vercel" is a hard rule |

Runtime-wise there is no obstacle: the app needs Node ≥ 22.5 for `node:sqlite` (`package.json`
`engines`), Vercel runs Node 24 by default and 22.x on request, and Express 5 is plain JS with
one dependency. The whole conversation is about the disk.

---

## Option A — Vercel serves the app, one small server holds the data

### 1. Put the app on a host with a disk

`Dockerfile` at the repo root does it. On Fly.io, which has volumes and a free-ish small tier:

```bash
fly launch                      # detects the Dockerfile, asks nothing else
fly volumes create data --size 1
fly secrets set COOKIE_SECRET=$(openssl rand -hex 32) PIN_PEPPER=$(openssl rand -hex 16)
fly secrets set EXPOSE_OTP=0 SECURE_COOKIES=1 OWNER_PIN=… OWNER_PASSWORD=…
fly deploy
```

(`fly secrets set` in one go, and add `DATA_DIR=/data` only if you mount the volume elsewhere.)
Same shape with plain Docker, if you already have a box:

```bash
docker run -d --name sathvika -p 127.0.0.1:4173:4173 \
  -v sathvika-data:/data --restart unless-stopped ghcr.io/<you>/web-app
```

Verify before touching Vercel:

```bash
curl -s https://<api-host>/api/health
```

`"storage": "persistent"` is the line that says the database landed on the volume and not in
`/tmp`. Alternatives, one line each: Render (works, but **add a Disk** — its free/ephemeral disk
is wiped on redeploy, so your orders vanish at deploy time), Railway (volume, ~$5/mo), or the
VPS + Caddy + systemd pair at the bottom of this file.

### 2. Let Vercel serve `public/` and proxy `/api`

```bash
npm i -g vercel && vercel login && vercel link && vercel
```

or import the repo in the dashboard with Framework Preset **Other**, Build Command empty, Output
Directory `public`. Then **replace** the repo's `vercel.json` (which is set up for option B) with
this — the point is one rewrite:

```json
{
  "buildCommand": "true",
  "outputDirectory": "public",
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://<api-host>/api/:path*" }
  ],
  "headers": [
    { "source": "/sw.js", "headers": [{ "key": "Cache-Control", "value": "no-store, must-revalidate" }] },
    { "source": "/img/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=604800, immutable" }] },
    { "source": "/app/(.*)", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
    { "source": "/styles/(.*)", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
    { "source": "/manifest.webmanifest", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] }
  ]
}
```

Why a rewrite instead of CORS: the proxy happens at Vercel's edge, so the browser only ever talks
to your own domain — same origin, a plain `SameSite=Lax` cookie works, no preflight, and
`ALLOWED_ORIGINS` stays empty. This is Vercel's own recommended pattern for serving an external
API on the same domain
([vercel.com/kb/guide/how-to-enable-cors](https://vercel.com/kb/guide/how-to-enable-cors)).

Two details: `public/` is now served by Vercel rather than Express, so the `headers` block above
is what keeps `sw.js` from being cached (a stale service worker pins customers to last week's
app). And `SECURE_COOKIES=1` belongs on the API host — Express already sets `trust proxy`, so the
`Secure` flag is honoured behind Vercel's TLS. Delete `server.js` for this variant: nothing routes
to it, but Vercel will still build a function for it.

### 3. Domain

`vercel domains add shop.example.in`, point the DNS record it prints, Vercel issues the cert.
Then `https://shop.example.in` is the whole shop and `https://<api-host>` never needs to be public
— close it to Vercel's edge IPs if you want (or leave it open; every endpoint re-checks the
session cookie, so it is not a back door).

---

## Option B — the whole app on Vercel, as a demo (already configured)

`server.js` at the repo root is the entrypoint Vercel's Node runtime auto-detects ("Vercel detects
a `server` entrypoint… routes incoming requests to the server through an internal port"
— [vercel.com/docs/functions/runtimes/node-js](https://vercel.com/docs/functions/runtimes/node-js)),
`vercel.json` keeps the source tree out of the public output and hands the CDN `public/`, and
`server/config.js` falls back to `/tmp` when the disk is read-only — so **it boots with zero
configuration**:

```bash
vercel link && vercel          # that's the deploy
# optional but worth it: one secret so a session survives an instance recycle
vercel env add COOKIE_SECRET production
```

What works: everything on screen — catalogue, English/தமிழ், OTP signup (codes are echoed, because
`EXPOSE_OTP` defaults to `1`), cart, checkout, the UPI link, the owner PIN pad, shift KPIs, PWA
install. A cold start seeds the demo catalogue in ~0.6 s.

What does not, in plain terms:

- **Writes are temporary.** Carts and orders live in `/tmp` and die with the instance; two
  customers can land on two instances that don't share a database. `/api/health` answers
  `"storage": "ephemeral"` when this is happening.
- **Products the owner adds have no artwork**, because `ensureProductImages` cannot write into
  the read-only `public/` — it skips quietly and the card falls back to the placeholder.
- **Rate limits are per instance.** Fine for a demo, not for a public PIN pad: set `PIN_PEPPER`
  and a non-default `OWNER_PIN` before you share the link.
- **Preview URLs are behind Vercel Authentication** (Settings → Deployment Protection), so the
  shop owner gets a login wall instead of the app. Turn it off for the project, or only share
  the production URL.
- **One region by default** (`iad1`, US-East). Settings → Functions → `bom1` (Mumbai) takes
  roughly 150 ms off every API call.
- **The Hobby plan is licensed for non-commercial use.** A shop taking orders is commercial, so a
  real deployment on Vercel means Pro ($20/mo) — more than option A's entire stack costs.
- Function duration is capped on Hobby (10 s default, 60 s max, 300 s with Fluid compute). Our
  endpoints answer in single-digit milliseconds, so this never bites — only that first cold seed.

Sanity-check any deployment (replace `<url>`):

```bash
curl -s  https://<url>/api/health | python3 -m json.tool   # products 57, storage
curl -sI https://<url>/sw.js     | grep -i cache-control   # no-store
curl -sI https://<url>/orders/12 | head -1                  # 200 — SPA deep links resolve
curl -sI https://<url>/server/config.js | head -1            # 404 — source is not published
```

---

## Option C — real data and still 100% Vercel

The blocker is the data layer, not the platform. `server/db/index.js` deliberately exposes a
**synchronous** `all / get / run / tx`, and 193 call sites across 13 files use it — which is why
a hosted database is a conversion, not a config change:

1. Replace `node:sqlite` with `@libsql/client` (Turso keeps your SQLite dialect almost as-is;
   Vercel Postgres/Neon means rewriting `INSERT OR REPLACE`, `IFNULL(x, '')`, `AUTOINCREMENT` and
   `sqlite_sequence`) and `await` every query, which turns the whole route/service surface async.
2. Move the rate-limit buckets (`server/lib/ratelimit.js`, an in-process `Map`) to Vercel KV /
   Upstash Redis, or brute-force protection resets per instance.
3. Generate product artwork at build time or push it to Vercel Blob, since `public/` stays
   read-only at runtime.
4. Leave the session code alone — cookie-with-bearer-fallback already copes with restrictive
   browsers, which is the part serverless hosting usually breaks.

Estimate: 1–2 days, with `npm test` (16 API cases) and `npm run smoke` (35 steps) as the safety
net. Worth doing if you expect real traffic spikes; not worth it for one counter and a few
hundred SKUs.

---

## Environment, whichever you pick

| Var | Production value | Why it matters here |
| --- | --- | --- |
| `COOKIE_SECRET` | 64 hex chars | without it, sessions die on every restart (on option B, on every instance) |
| `PIN_PEPPER` | long random | a 4-digit owner PIN is brute-forceable offline without a pepper |
| `EXPOSE_OTP` | `0` | **the app does not auto-harden** on `NODE_ENV=production`; default `1` returns OTP codes in API responses |
| `SECURE_COOKIES` | `1` | HTTPS-only cookies (`trust proxy` is already set, so it works behind a proxy) |
| `NODE_ENV` | `production` | reported by `/api/health` |
| `OWNER_PIN` / `OWNER_PASSWORD` | not the repo defaults | `4321` / `sathvika@owner2026` are committed in this repo — treat them as public |
| `DATA_DIR` | `/data` (volume) | the whole app state is this one directory |
| `FRAME_ANCESTORS` | `'none'` | only widen it for a deliberate embed; `'self' *` is for device previews |
| `ALLOWED_ORIGINS` | empty | options A and B are same-origin by design |
| `AUTH_RATE_LIMIT_MAX` / `OWNER_PIN_RATE_MAX` | defaults | raise the PIN budget only if the counter tablet is shared |
| `NOTIFY_PROVIDER` / `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_TOKEN` | `webhook` + your gateway | `log` (default) keeps order messages in the in-app outbox only |
| `SESSION_DAYS` / `ELEVATED_MINUTES` | `30` / `30` | |

## VPS, if you would rather own one box

Cheapest honest option: a 1 GB VPS, Caddy for TLS, systemd for the process.

```ini
# /etc/systemd/system/sathvika.service
[Unit]
Description=Sathvika MV
After=network.target

[Service]
User=sathvika
WorkingDirectory=/srv/web-app
EnvironmentFile=/etc/sathvika.env
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning server/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```caddyfile
# /etc/caddy/Caddyfile
shop.example.in {
    reverse_proxy 127.0.0.1:4173
}
```

Then `npm ci --omit=dev`, one crontab line for backups — `.backup`, not `cp`, because the
database is in WAL mode:

```
0 21 * * * sqlite3 /srv/web-app/data/sathvika.db ".backup '/backups/$(date +\%F).db'"
```

## What I actually verified

Option B's platform-facing assumptions were exercised locally by booting a **read-only copy** of
the repo (Vercel's disk shape): the seed ran, `/api/health` reported `storage: ephemeral`, an
`/orders/12` deep link returned the shell, and login + cart writes succeeded against the `/tmp`
database. The Vercel control-plane steps (dashboard settings, env vars, regions, Deployment
Protection, limits) are quoted from Vercel's current docs as of 2026-09-06 — they have not been
run from here, because this sandbox has no Vercel credentials.
