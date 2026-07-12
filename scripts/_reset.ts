import Database from 'better-sqlite3';
const ids = process.argv.slice(2).map(Number);
const db = new Database('./data/app.db');
const upd = db.prepare("UPDATE companies SET status='NEW', form_url=NULL, form_confidence=NULL, updated_at=datetime('now') WHERE id=?");
for (const id of ids) { upd.run(id); console.log('reset #' + id + ' -> NEW'); }
