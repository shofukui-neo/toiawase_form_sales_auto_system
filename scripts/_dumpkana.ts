import Database from 'better-sqlite3';
const id=Number(process.argv[2]);
const db=new Database('./data/app.db');
const s=JSON.parse((db.prepare('SELECT schema_json FROM field_maps WHERE company_id=? ORDER BY id DESC LIMIT 1').get(id) as any).schema_json);
const kanaMap=s.mappings.find((m:any)=>m.role==='kana');
console.log('kana mapping:', kanaMap?.selector);
for(const f of s.fields){
  if(/ふりがな|フリガナ|カナ|かな|kana/i.test((f.labelText||'')+(f.name||'')+(f.id||'')+(f.placeholder||''))){
    console.log(`  label="${f.labelText}" name=${f.name} id=${f.id} ph="${f.placeholder}" sel=${f.selector}`);
  }
}
