import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;
/** Compiled-statement cache, keyed by SQL text. Dropped when the DB is closed. */
let _stmts = new Map<string, Database.Statement>();

/** Open (and lazily migrate) the singleton DB connection. */
export function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const conn = new Database(config.dbPath);
  // WAL + NORMAL: a bulk ingest of 3万件 costs one fsync per *transaction*
  // instead of one per row (FULL). Safe under WAL — only a host crash (not a
  // process crash) can lose the last commits, and an interrupted intake is
  // resumable from `import_jobs` anyway.
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('temp_store = MEMORY');
  conn.pragma('cache_size = -65536'); // 64MB page cache
  conn.pragma('foreign_keys = ON');
  try {
    conn.pragma('mmap_size = 268435456'); // 256MB; ignored where unsupported
  } catch {
    /* not fatal */
  }
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  conn.exec(schema);
  migrate(conn);
  _db = conn;
  return _db;
}

/**
 * 後から足した列を、既存の DB にも入れる。
 *
 * schema.sql は `CREATE TABLE IF NOT EXISTS` なので、既に表がある DB では
 * 新しい列定義が一切適用されない。列を足すたびに DB を作り直すわけには
 * いかない（送信履歴が唯一の実績データなので）ため、不足分だけ ALTER する。
 * 追加のみ・NULL 許容のみに限定しているので、途中で落ちても壊れない。
 */
function migrate(conn: Database.Database): void {
  const addColumn = (table: string, column: string, decl: string) => {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  };
  // 送信結果の証拠。これが無いと「成功」と記録された行を後から検証できない。
  addColumn('submissions', 'result_screenshot_url', 'TEXT');
  addColumn('submissions', 'result_text', 'TEXT');
  // どの文面パターンで送ったか。返信率を文面ごとに比較するための軸。
  addColumn('submissions', 'variant', 'TEXT');
}

/**
 * Prepare-once, reuse-forever. `db().prepare(sql)` recompiles the SQL on every
 * call — at 3万行 × several statements per row that compile cost dominates the
 * whole ingest. Every repository goes through here instead.
 */
export function prep(sql: string): Database.Statement {
  const hit = _stmts.get(sql);
  if (hit) return hit;
  const stmt = db().prepare(sql);
  _stmts.set(sql, stmt);
  return stmt;
}

/**
 * Run `fn` inside a transaction (a no-op wrapper when one is already open, so
 * batched helpers compose). Without this, every INSERT is its own transaction
 * — the single biggest cost when importing tens of thousands of rows.
 */
export function tx<T>(fn: () => T): T {
  const d = db();
  if (d.inTransaction) return fn();
  return d.transaction(fn)();
}

/** For tests / scripts that need a clean in-memory DB. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _stmts = new Map();
  }
}
