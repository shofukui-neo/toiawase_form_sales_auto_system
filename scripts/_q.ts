import Database from 'better-sqlite3';
const db = new Database('./data/app.db');
const cols = db.prepare("PRAGMA table_info(companies)").all() as any[];
console.log('companies cols:', cols.map(c=>c.name).join(', '));
const rows = db.prepare('SELECT * FROM companies ORDER BY id').all() as any[];
for (const r of rows) console.log(`#${r.id}\t${String(r.status).padEnd(16)}\t${r.name}\t[${r.domain}]\t${r.form_url||''}`);
