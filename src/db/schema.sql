-- Data model (spec §6). SQLite is the source of truth; Sheets is a report layer (L6).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- L0 product + master
CREATE TABLE IF NOT EXISTS companies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  domain        TEXT NOT NULL UNIQUE,
  icp_score     REAL,
  source        TEXT,
  status        TEXT NOT NULL DEFAULT 'NEW',   -- state machine §7
  form_url      TEXT,
  form_confidence REAL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

-- L2 product
CREATE TABLE IF NOT EXISTS field_maps (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  schema_json        TEXT NOT NULL,            -- full FormSchema
  has_confirm_screen INTEGER NOT NULL DEFAULT 0,
  has_captcha        TEXT NOT NULL DEFAULT 'none', -- none/v2/v3
  mapping_confidence REAL NOT NULL DEFAULT 0,
  gate               TEXT NOT NULL DEFAULT 'low',  -- high/mid/low/block
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_field_maps_company ON field_maps(company_id);

-- L4-L5 product (per attempt)
CREATE TABLE IF NOT EXISTS submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  content_rendered TEXT,                       -- actual message sent
  plan_screenshot_url TEXT,
  status           TEXT NOT NULL,              -- plan_ready/submitted_success/failed/captcha/needs_review
  approved_by      TEXT,
  approved_at      TEXT,
  submitted_at     TEXT,
  result_detail    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_company ON submissions(company_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

-- Cross-cutting suppression list
CREATE TABLE IF NOT EXISTS suppression (
  domain     TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,                    -- already_sent/opt_out/no_sales_policy/competitor
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cross-cutting audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  company_id INTEGER,
  layer      TEXT,
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'system',
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_log(company_id);

-- Pacing ledger: one row per final (Execute) submission, used to enforce daily send cap.
CREATE TABLE IF NOT EXISTS send_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  day        TEXT NOT NULL,                    -- YYYY-MM-DD (local)
  sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_send_ledger_day ON send_ledger(day);
