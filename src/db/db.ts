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
  _db = conn;
  return _db;
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
