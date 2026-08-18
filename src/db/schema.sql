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
-- byStatus() orders by (icp_score DESC, id) — with 3万件 in the table the sort
-- alone dominates the query, so cover it in the index.
CREATE INDEX IF NOT EXISTS idx_companies_status_score ON companies(status, icp_score DESC, id);

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

-- Manual edits from the approval dashboard: per-company role->value overrides
-- applied on top of the deterministic L3 render (preview == plan == execute).
CREATE TABLE IF NOT EXISTS content_overrides (
  company_id     INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  overrides_json TEXT NOT NULL,                 -- { values: { <role>: <value> } }
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- ============================ 取り込みジョブ (L0) ============================
-- 3万件規模のリストは 1 リクエストでは処理しきれない（途中でブラウザが切れる／
-- サーバが再起動する）。そこで「取り込み対象そのもの」を先に DB へ保存し、
-- カーソルを進めながら少しずつ処理する。中断しても続きから再開でき、同じ企業を
-- 二度読み込むことがない。
CREATE TABLE IF NOT EXISTS import_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  status        TEXT NOT NULL DEFAULT 'running',  -- running/paused/done/failed
  phase         TEXT NOT NULL DEFAULT 'ingest',   -- ingest/resolve/pipeline/done
  options_json  TEXT NOT NULL DEFAULT '{}',
  total         INTEGER NOT NULL DEFAULT 0,
  counters_json TEXT NOT NULL DEFAULT '{}',
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status);

-- 1 行 = 取り込みリストの 1 社。state がその行のセーブポイント。
--   pending    未処理
--   ingested   companies に登録済み（パイプライン待ち）
--   known      すでに取り込み済みの企業（再処理しない）
--   suppressed 競合等で除外   nodomain ドメイン無しでスキップ
--   unresolved HP を特定できず  done パイプライン完了  error 失敗
CREATE TABLE IF NOT EXISTS import_rows (
  job_id     INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  name       TEXT NOT NULL,
  domain     TEXT,
  industry   TEXT,
  employees  INTEGER,
  prefecture TEXT,
  source     TEXT,
  state      TEXT NOT NULL DEFAULT 'pending',
  company_id INTEGER,
  detail     TEXT,
  PRIMARY KEY (job_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_import_rows_state ON import_rows(job_id, state, seq);

-- HP 自動探索の結果キャッシュ。1 社あたり複数回の Web 検索＋取得が走るため、
-- 一度探した会社名は（見つからなかった場合も含めて）二度と探索しない。
CREATE TABLE IF NOT EXISTS hp_resolutions (
  name_key   TEXT PRIMARY KEY,           -- 正規化した会社名（+業種/都道府県）
  domain     TEXT,                       -- NULL = 見つからなかった
  method     TEXT,
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pacing ledger: one row per final (Execute) submission, used to enforce daily send cap.
CREATE TABLE IF NOT EXISTS send_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  day        TEXT NOT NULL,                    -- YYYY-MM-DD (local)
  sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_send_ledger_day ON send_ledger(day);
