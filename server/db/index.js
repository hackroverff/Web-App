/**
 * Thin, dependency-free data layer on top of Node's built-in SQLite
 * (`node:sqlite`). Deliberately small: a single store with a few hundred SKUs
 * does not need an ORM, and avoiding native modules keeps deploys to
 * `npm install && npm start` on any box.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config, DATA_DIR } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/** SQLite can only bind these — booleans/undefined must be normalised. */
function bindable(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function all(sql, params = []) {
  return db.prepare(sql).all(...(Array.isArray(params) ? params : []).map(bindable)).map(plain);
}

export function get(sql, params = []) {
  const row = db.prepare(sql).get(...(Array.isArray(params) ? params : []).map(bindable));
  return row ? plain(row) : null;
}

export function run(sql, params = []) {
  const r = db.prepare(sql).run(...(Array.isArray(params) ? params : []).map(bindable));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function pluck(sql, params = [], column = null) {
  const row = get(sql, params);
  if (!row) return null;
  if (column) return row[column];
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

/** node:sqlite returns null-prototype objects; spread for JSON-safety + ease of use. */
function plain(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k] = row[k];
  return out;
}

let txDepth = 0;
/** Synchronous transaction helper (SQLite driver is sync, so no deadlocks). */
export function tx(fn) {
  const savepoint = `sp_${txDepth}`;
  if (txDepth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${savepoint}`);
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    if (txDepth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    txDepth -= 1;
    try {
      if (txDepth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      /* report the original error */
    }
    throw err;
  }
}

/** Build an INSERT from an object, returning the new row id. */
export function insert(table, data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return run(sql, keys.map((k) => data[k])).lastInsertRowid;
}

/** Build an UPDATE from an object. Returns changed-row count. */
export function update(table, id, data, idColumn = 'id') {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE ${idColumn}=?`;
  return run(sql, [...keys.map((k) => data[k]), id]).changes;
}

// ------------------------------------------------------------------ settings --
const DEFAULT_SETTINGS = {
  store_name: 'Sathvika MV',
  store_tagline: 'Groceries & provisions for homes and shops',
  store_phone: '+91 98400 00000',
  store_address: 'No. 14, Big Bazaar Street, T. Nagar, Chennai 600017',
  google_maps_query: 'T Nagar, Chennai',
  upi_id: 'sathvika.mv@okaxis',
  upi_display_name: 'Sathvika MV',
  cod_enabled: '1',
  delivery_charge: '30',
  free_delivery_above: '999',
  min_order_retail: '150',
  min_order_wholesale: '0',
  eta_minutes: '90',
  low_stock_threshold: '5',
  shop_open: '1',
  wholesale_requires_approval: '1',
  currency: 'INR',
  logo_accent: '#0f7b4f',
};

/** Cached settings map; invalidated by setSetting(). */
let settingsCache = null;

export function settings() {
  if (settingsCache) return settingsCache;
  const map = { ...DEFAULT_SETTINGS };
  for (const row of all('SELECT key, value FROM settings')) {
    if (row.value !== null && row.value !== undefined) map[row.key] = row.value;
  }
  settingsCache = map;
  return map;
}

export function getSetting(key, fallback = '') {
  const v = settings()[key];
  return v === undefined || v === null ? fallback : v;
}

export function getNumberSetting(key, fallback = 0) {
  const v = Number(settings()[key]);
  return Number.isFinite(v) ? v : fallback;
}

export function getBoolSetting(key, fallback = false) {
  const v = settings()[key];
  return v === undefined ? fallback : ['1', 'true', 'yes'].includes(String(v).toLowerCase());
}

export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, value === undefined || value === null ? null : String(value)],
  );
  settingsCache = null;
}

export function setSettings(obj) {
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) setSetting(k, v);
}

export function metaGet(key) {
  return pluck('SELECT value FROM meta WHERE key=?', [key]);
}
export function metaSet(key, value) {
  run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, String(value)],
  );
}

export function dbStats() {
  const tables = all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name);
  const counts = {};
  for (const t of tables) counts[t] = Number(pluck(`SELECT COUNT(*) AS n FROM "${t}"`) || 0);
  return { file: config.dbFile, tables: counts };
}

export function closeDb() {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}
