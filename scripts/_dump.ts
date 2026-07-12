import Database from 'better-sqlite3';
const id = Number(process.argv[2]);
const db = new Database('./data/app.db');
const row = db.prepare('SELECT schema_json FROM field_maps WHERE company_id=? ORDER BY id DESC LIMIT 1').get(id) as any;
if (!row) { console.log('no field_maps for', id); process.exit(0); }
const s = JSON.parse(row.schema_json);
console.log('formUrl:', s.formUrl, 'gate:', s.gate, 'captcha:', s.hasCaptcha);
console.log('\nMAPPINGS:');
for (const m of s.mappings) console.log(`  ${m.role.padEnd(10)} conf=${m.confidence} src=${m.source}  ${m.selector}`);
console.log('\nCHECKBOX / agree-ish FIELDS:');
for (const f of s.fields) {
  const t = (f.type||f.tag);
  if (t==='checkbox' || /同意|個人情報|プライバシー|規約|承諾/.test((f.labelText||'')+(f.name||'')+(f.id||''))) {
    console.log(`  [${t}] req=${f.required} hp=${f.honeypot} label="${(f.labelText||'').slice(0,50)}" name=${f.name} id=${f.id} sel=${f.selector}`);
  }
}
console.log('\nREQUIRED unmapped fields:');
const mappedSel = new Set(s.mappings.map((m:any)=>m.selector));
for (const f of s.fields) {
  if (f.required && !f.honeypot && !mappedSel.has(f.selector)) console.log(`  [${f.type||f.tag}] label="${(f.labelText||'').slice(0,40)}" name=${f.name} sel=${f.selector}`);
}
