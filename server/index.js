/** Entry point: make sure the DB has demo data on first boot, then serve. */
import { config } from './config.js';
import { createApp } from './app.js';
import { ensureSeeded } from './seed/index.js';

const seedResult = await ensureSeeded();
const app = createApp();

const server = app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  console.log('\n  Sathvika MV — single-store grocery & provisions app');
  console.log(`  ├─ app      ${url}`);
  console.log(`  ├─ api ping ${url}/api/health`);
  console.log(`  ├─ database ${config.dbFile}`);
  if (seedResult) console.log('  ├─ seeded   demo catalogue, accounts and orders created');
  console.log(`  ├─ owner    PIN ${config.ownerPin} · owner password ${config.ownerPassword} (change before going live)`);
  console.log(`  └─ otp      ${config.exposeOtp ? 'codes are echoed in the UI (demo mode)' : 'gateway only — codes are never returned by the API'}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n  ${sig} received — closing server.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
