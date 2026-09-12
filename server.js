/**
 * Vercel entrypoint.
 *
 * Vercel's Node.js runtime looks for `server.js` (or `src/server.js`) at the project root,
 * starts it, and routes every request the CDN did not answer from `outputDirectory` to that
 * server — through an internal port, with real Node `req`/`res` objects, so Express sees the
 * original URL and no adapter or rewrite hackery is involved. The `listen()` call below is
 * what Vercel detects; the port itself is only used when you run this file locally.
 *
 * Everything else in the app is unchanged: this is `server/index.js` minus the banner.
 *
 * ⚠️ On Vercel the deployment disk is read-only, so `data/sathvika.db` falls back to /tmp
 * (see server/config.js) and is lost whenever an instance is recycled. Good enough to demo
 * or to hand to a client for a walkthrough; DEPLOY.md explains the two ways to run it for
 * real. `npm start` / a normal host are unaffected.
 */
import { config, storageEphemeral } from './server/config.js';
import { createApp } from './server/app.js';
import { ensureSeeded } from './server/seed/index.js';

// A brand-new instance has an empty database, so the catalogue is seeded on cold start.
// A seeding hiccup must not take the function down — the API still answers, it just looks empty.
await ensureSeeded().catch((err) => console.error('[vercel] seed skipped:', err?.message || err));

if (storageEphemeral) {
  console.warn(
    '[vercel] read-only deployment disk: database is at %s and will be discarded when this ' +
      'instance is recycled. Use a persistent host (DEPLOY.md, option A) for live orders.',
    config.dbFile,
  );
}

createApp().listen(config.port, config.host);
