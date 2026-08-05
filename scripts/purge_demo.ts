/**
 * デモ／テストデータの削除スクリプト。
 *
 * `npm run seed`（seed_demo）が投入する demo-*.example.jp、動作確認で入った
 * *.example.com、および「会社サイトではないホスト」を誤って取り込んでしまった
 * 行（SFA のリードURL 等）を DB から取り除く。実データ（実在ドメインの企業）は
 * 残す。
 *
 * 使い方:
 *   npm run purge-demo -- --dry-run   削除対象を表示するだけ（実行しない）
 *   npm run purge-demo                デモ／テスト行を削除
 *   npm run purge-demo -- --all       companies を全削除（完全リセット）
 *
 * companies を消すと field_maps / submissions / content_overrides は FK の
 * ON DELETE CASCADE で連動して消える。audit_log と send_ledger は FK が無いので
 * 明示的に消す。対応する Plan スクショも削除する。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../src/db/db.js';
import { config } from '../src/config.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const purgeAll = args.has('--all');

/** デモ／テスト専用のドメイン。RFC 2606 の予約 TLD と seed_demo の固定値。 */
const DEMO_DOMAIN_PATTERNS = [
  'demo-%',
  '%.example.jp',
  '%.example.com',
  '%.example.net',
  '%.example.org',
  'example.jp',
  'example.com',
];
/** 企業サイトではないホスト＝取り込みミス。ここに入った行は営業対象になり得ない。 */
const NON_COMPANY_HOSTS = ['mochica.balescloud.jp', 'balescloud.jp'];

const conn = db();

const where = purgeAll
  ? '1 = 1'
  : [
      ...DEMO_DOMAIN_PATTERNS.map((p) => `domain LIKE '${p}'`),
      ...NON_COMPANY_HOSTS.map((h) => `domain = '${h}'`),
      // 正規化に失敗した空/壊れたドメイン（例: ".example.com"）。
      `domain = ''`,
      `domain LIKE '.%'`,
    ].join(' OR ');

const targets = conn
  .prepare(`SELECT id, name, domain, status FROM companies WHERE ${where} ORDER BY id`)
  .all() as { id: number; name: string; domain: string; status: string }[];

if (targets.length === 0) {
  console.log('削除対象のデモ／テストデータはありません。');
  process.exit(0);
}

console.log(`削除対象: ${targets.length} 社`);
for (const t of targets) console.log(`  #${t.id}\t${t.status.padEnd(18)}\t${t.domain}\t${t.name}`);

const ids = targets.map((t) => t.id);
const domains = targets.map((t) => t.domain);
const idList = ids.join(',');
const domList = domains.map((d) => `'${d.replace(/'/g, "''")}'`).join(',');

const counts = {
  field_maps: (conn.prepare(`SELECT COUNT(*) n FROM field_maps WHERE company_id IN (${idList})`).get() as any).n,
  submissions: (conn.prepare(`SELECT COUNT(*) n FROM submissions WHERE company_id IN (${idList})`).get() as any).n,
  content_overrides: (conn.prepare(`SELECT COUNT(*) n FROM content_overrides WHERE company_id IN (${idList})`).get() as any).n,
  audit_log: (conn.prepare(`SELECT COUNT(*) n FROM audit_log WHERE company_id IN (${idList})`).get() as any).n,
  send_ledger: (conn.prepare(`SELECT COUNT(*) n FROM send_ledger WHERE company_id IN (${idList})`).get() as any).n,
  suppression: (conn.prepare(`SELECT COUNT(*) n FROM suppression WHERE domain IN (${domList})`).get() as any).n,
};
console.log('\n連動して削除される関連レコード:');
for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(18)} ${n}`);

// 対象企業の Plan スクショ（artifacts/plan_<id>.png）と発見ログ。
const files = ids
  .flatMap((id) => [`plan_${id}.png`, `${id}_no_form.txt`])
  .map((f) => resolve(config.artifactsDir, f))
  .filter((p) => existsSync(p));
if (files.length) {
  console.log(`\n削除される成果物ファイル: ${files.length} 件`);
  for (const f of files) console.log(`  ${f}`);
}

if (dryRun) {
  console.log('\n--dry-run のため何も削除していません。');
  process.exit(0);
}

conn.transaction(() => {
  conn.prepare(`DELETE FROM audit_log WHERE company_id IN (${idList})`).run();
  conn.prepare(`DELETE FROM send_ledger WHERE company_id IN (${idList})`).run();
  conn.prepare(`DELETE FROM suppression WHERE domain IN (${domList})`).run();
  // field_maps / submissions / content_overrides は FK CASCADE で消える。
  conn.prepare(`DELETE FROM companies WHERE id IN (${idList})`).run();
})();
for (const f of files) rmSync(f, { force: true });

const left = (conn.prepare('SELECT COUNT(*) n FROM companies').get() as any).n;
console.log(`\n削除しました。残りの企業: ${left} 社`);
if (left > 0) {
  console.log('\n=== 残存企業 ===');
  for (const c of conn.prepare('SELECT id,name,domain,status FROM companies ORDER BY id').all() as any[]) {
    console.log(`  #${c.id}\t${c.status.padEnd(18)}\t${c.domain}\t${c.name}`);
  }
}
