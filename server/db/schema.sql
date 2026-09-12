-- ============================================================================
-- Sathvika MV — SQLite schema (single store, low-hundreds of SKUs)
-- Idempotent: safe to execute on every boot. Destructive changes go through
-- server/db/migrate.js as numbered migrations.
-- ============================================================================

-- ---------------------------------------------------------------- accounts ---
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  role           TEXT    NOT NULL CHECK (role IN ('retail','wholesale')),
  full_name      TEXT    NOT NULL,
  mobile         TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  verified       INTEGER NOT NULL DEFAULT 0,          -- mobile OTP verified
  status         TEXT    NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','pending_verification','suspended','rejected')),
  business_name  TEXT,
  business_type  TEXT,                                 -- shop|restaurant|canteen|office|institution|other
  gst_number     TEXT,
  email          TEXT,
  lang           TEXT    NOT NULL DEFAULT 'en',          -- UI/notification language: en|ta
  notes          TEXT,
  discount_pct   REAL,                                 -- optional per-account override (phase 2 hook)
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  approved_at    TEXT,
  approved_by    TEXT,
  rejected_reason TEXT,
  last_login_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, role);

CREATE TABLE IF NOT EXISTS addresses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL DEFAULT 'Home',
  kind        TEXT    NOT NULL DEFAULT 'home' CHECK (kind IN ('home','business')),
  contact_name TEXT,
  contact_phone TEXT,
  line1       TEXT    NOT NULL,
  line2       TEXT,
  area        TEXT,
  city        TEXT    NOT NULL DEFAULT 'Chennai',
  pincode     TEXT,
  landmark    TEXT,
  lat         REAL,
  lng         REAL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

CREATE TABLE IF NOT EXISTS otps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mobile     TEXT    NOT NULL,
  code_hash  TEXT    NOT NULL,
  purpose    TEXT    NOT NULL CHECK (purpose IN ('register','reset','login')),
  user_id    INTEGER,
  payload    TEXT,                                     -- e.g. JSON of pending signup form
  expires_at TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  consumed   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otp_lookup ON otps(mobile, purpose, consumed, expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  subject    TEXT NOT NULL CHECK (subject IN ('customer','owner')),
  user_id    INTEGER,                                   -- customers.id (null for owner sessions)
  staff_id   INTEGER,                                   -- staff.id (null for customer sessions)
  level      TEXT    NOT NULL DEFAULT 'basic',          -- basic | ops | admin
  elevated_until TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(subject, user_id);

-- Store owner + counter staff. PIN = fast daily login (ops dashboard only).
-- Password = the stronger factor required for pricing, approvals and settings.
CREATE TABLE IF NOT EXISTS staff (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  designation   TEXT NOT NULL DEFAULT 'Owner',
  username      TEXT NOT NULL UNIQUE,
  mobile        TEXT,
  role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff')),
  pin_hash      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_pin_login_at TEXT,
  last_admin_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- catalogue ---
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  name_ta    TEXT,
  parent_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  icon       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name ON categories(IFNULL(parent_id,0), name);

CREATE TABLE IF NOT EXISTS brands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  name_ta          TEXT,
  description      TEXT,
  brand_id         INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  pack_size        TEXT,                                 -- free text: "1 kg", "500 g", "12 pcs"
  unit             TEXT    NOT NULL DEFAULT 'piece',     -- kg|g|litre|ml|piece|packet|box|dozen
  mrp              REAL    NOT NULL DEFAULT 0,
  retail_price     REAL    NOT NULL DEFAULT 0,
  wholesale_price  REAL,                                 -- null => wholesale falls back to retail
  stock_status     TEXT    NOT NULL DEFAULT 'in_stock'
                   CHECK (stock_status IN ('in_stock','low_stock','out_of_stock')),
  stock_qty        REAL,                                 -- owner-managed count of packs/units
  low_stock_qty    REAL    NOT NULL DEFAULT 5,
  moq_wholesale    INTEGER NOT NULL DEFAULT 1,           -- minimum packs a wholesale buyer must take
  min_qty_retail   INTEGER NOT NULL DEFAULT 1,
  max_qty_retail   INTEGER,                              -- optional cap for scarce items
  image            TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  is_featured      INTEGER NOT NULL DEFAULT 0,
  search_text      TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock_status);

-- quantity tiers. scope keeps the door open for retail tiers in phase 2.
CREATE TABLE IF NOT EXISTS price_tiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  scope       TEXT    NOT NULL DEFAULT 'wholesale' CHECK (scope IN ('retail','wholesale')),
  min_qty     INTEGER NOT NULL,
  max_qty     INTEGER,                                   -- null = open ended
  unit_price  REAL    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tiers_unique ON price_tiers(product_id, scope, min_qty);

-- --------------------------------------------------------------------- cart ---
CREATE TABLE IF NOT EXISTS carts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id    INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cart_id, product_id)
);

-- ------------------------------------------------------------------- orders ---
CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at   TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at   TEXT,
  opened_by   TEXT NOT NULL DEFAULT 'owner',
  note        TEXT,
  -- snapshot written when the shift is closed (live numbers are always recomputed)
  orders_count INTEGER,
  gross_sales  REAL,
  online_rcvd  REAL,
  cod_rcvd     REAL
);
CREATE INDEX IF NOT EXISTS idx_shifts_open ON shifts(closed_at);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id      TEXT NOT NULL UNIQUE,                    -- SMV-2026-00042
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  shift_id       INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  account_type   TEXT NOT NULL DEFAULT 'retail',         -- pricing scope snapshot
  status         TEXT NOT NULL DEFAULT 'placed'
                 CHECK (status IN ('placed','confirmed','preparing','out_for_delivery','delivered','cancelled')),
  subtotal       REAL NOT NULL DEFAULT 0,                 -- sum of chargeable line totals
  mrp_value      REAL NOT NULL DEFAULT 0,                 -- what the same basket costs at MRP
  discount       REAL NOT NULL DEFAULT 0,                 -- mrp_value - subtotal
  delivery_charge REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,                 -- server computed; never taken from client
  payment_method TEXT NOT NULL DEFAULT 'cod' CHECK (payment_method IN ('upi','cod')),
  payment_app    TEXT,                                    -- gpay|phonepe|paytm|other
  payment_status TEXT NOT NULL DEFAULT 'pending'
                 CHECK (payment_status IN ('pending','paid','failed','refunded','cash_due','cash_collected')),
  upi_ref        TEXT,
  address_snapshot TEXT,                                   -- JSON (survives address edits/deletions)
  instructions   TEXT,
  promised_at    TEXT,
  placed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at   TEXT,
  preparing_at   TEXT,
  otd_at         TEXT,
  delivered_at   TEXT,
  cancelled_at   TEXT,
  cancel_reason  TEXT,
  voided         INTEGER NOT NULL DEFAULT 0,              -- "Scratch" on the owner dashboard
  void_note      TEXT,
  voided_at      TEXT,
  eta_minutes    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, voided);
CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id);
CREATE INDEX IF NOT EXISTS idx_orders_placed ON orders(placed_at);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  brand       TEXT,
  category    TEXT,
  pack_size   TEXT,
  unit        TEXT,
  qty         INTEGER NOT NULL,
  mrp         REAL NOT NULL DEFAULT 0,
  unit_price  REAL NOT NULL,
  line_total  REAL NOT NULL,
  price_scope TEXT NOT NULL DEFAULT 'retail',
  tier_label  TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

-- ------------------------------------------------------- notifications etc ---
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  order_id   INTEGER,
  channel    TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','whatsapp')),
  to_number  TEXT NOT NULL,
  template   TEXT,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  provider   TEXT,
  provider_msg TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_order ON notifications(order_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL DEFAULT 'owner',
  action     TEXT NOT NULL,                -- marked_paid|marked_failed|refunded|customer_claimed
  amount     REAL,
  ref        TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payev_order ON payment_events(order_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,                -- customer|owner
  actor_id   INTEGER,
  actor_label TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
