import Database from 'better-sqlite3';
const id = Number(process.argv[2]);
const db = new Database('./data/app.db');
const row = db.prepare('SELECT schema_json FROM field_maps WHERE company_id=? ORDER BY id DESC LIMIT 1').get(id) as any;
const s = JSON.parse(row.schema_json);
const mapped = new Set(s.mappings.map((m:any)=>m.selector));
console.log('SELECT / RADIO fields:');
for (const f of s.fields) {
  if (f.tag==='select' || (f.type||'')==='radio') {
    console.log(`  [${f.tag}/${f.type||''}] req=${f.required} hp=${f.honeypot} mapped=${mapped.has(f.selector)} label="${(f.labelText||'').slice(0,30)}" opts=${(f.options||[]).slice(0,4).join('|')} sel=${f.selector}`);
  }
}
