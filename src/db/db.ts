import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

/** Open (and lazily migrate) the singleton DB connection. */
export function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const conn = new Database(config.dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  conn.exec(schema);
  _db = conn;
  return _db;
}

/** For tests / scripts that need a clean in-memory DB. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
