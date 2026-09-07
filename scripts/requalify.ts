/**
 * 「非適格」で除外された企業のうち、今の判定なら送れるものを送信対象へ戻す。
 *
 * 除外の理由が実態を指していなかったケースをいくつも直したので、過去に
 * 捨てた企業の中に、本当は送れるものが混ざっている。ただし 1,672 社を
 * 全部パースし直すとフォームの数だけページを開くことになるため、
 * **まず保存済みのフィールド定義から机上で判定し**、通る見込みのある企業に
 * 絞って再パースする。ネットワークに出るのは絞り込んだ後だけ。
 *
 * 送信は一切しない。再パースは解析のやり直しであって、送信ではない。
 * 実際に送るには、このあと `plan` と承認を経る必要がある。
 *
 *   npx tsx scripts/requalify.ts              # 何社戻せるか数えるだけ
 *   npx tsx scripts/requalify.ts --apply      # 対象を再パースしてキューに戻す
 *   npx tsx scripts/requalify.ts --apply --limit 100
 */
import { companies, fieldMaps, suppression } from '../src/db/repositories.js';
import { computeCoverage } from '../src/layers/coverage.js';
import { classifyEligibility } from '../src/crosscutting/eligibility.js';
import { mapFields } from '../src/layers/l2_parsing.js';
import { reparse } from '../src/pipeline/pipeline.js';
import type { FormSchema } from '../src/types.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const apply = process.argv.includes('--apply');
const limit = Number(arg('limit', '500'));

/**
 * 保存済みの schema は当時の辞書で作った mappings を持っている。辞書の改善を
 * 反映するには、fields から対応付けをやり直したうえで判定する必要がある。
 */
function wouldQualifyNow(companyId: number): { ok: boolean; reason?: string } {
  const company = companies.byId(companyId);
  const schema = fieldMaps.latest(companyId);
  if (!company || !schema) return { ok: false, reason: 'スキーマ無し' };
  // 対応付けは mapFields で作る。ruleMap 単体だと姓名・フリガナ・住所・電話の
  // 分割欄を拾う detectSplitFields が走らず、分割欄を持つフォームが
  // 「必須なのに埋められない」に見えてしまう（本番の解析はこの合成を使う）。
  const remapped = { ...schema, mappings: mapFields(schema.fields).mappings } as FormSchema;
  const verdict = classifyEligibility(remapped, computeCoverage(company, remapped));
  return verdict.eligible ? { ok: true } : { ok: false, reason: verdict.reason };
}

// 対象は「解析の判断で除外された」企業だけ。営業お断り (no_sales_policy) と
// 送信済み (already_sent) は絶対に触らない — 前者は相手の意思表示、後者は
// 二重送信になる。
const target = suppression
  .all()
  .filter((s) => s.reason === 'ineligible_form')
  .map((s) => s.domain);

const domainSet = new Set(target);
const suppressed = companies.all().filter((c) => c.status === 'SUPPRESSED' && domainSet.has(c.domain.toLowerCase()));

console.log(`「非適格」で除外されている企業: ${suppressed.length} 社`);
console.log('保存済みのフィールド定義から、今の判定で通るかを机上で確認します（通信なし）\n');

const eligible: number[] = [];
const stillNo = new Map<string, number>();
for (const c of suppressed) {
  const v = wouldQualifyNow(c.id);
  if (v.ok) eligible.push(c.id);
  else stillNo.set(v.reason ?? '不明', (stillNo.get(v.reason ?? '不明') ?? 0) + 1);
}

console.log(`→ 今なら送信対象にできる: ${eligible.length} 社`);
console.log('→ 依然として除外:');
for (const [reason, n] of [...stillNo.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`     ${String(n).padStart(5)}  ${reason}`);
}

if (!apply) {
  console.log('\n--apply を付けると、上記を再パースして送信キューに戻します。');
  console.log('（再パースは解析のやり直しであって送信ではありません。実際に送るには plan と承認が要ります）');
  process.exit(0);
}

const batch = eligible.slice(0, limit);
console.log(`\n${batch.length} 社を再パースします（残り ${eligible.length - batch.length} 社は --limit を上げて再実行）`);

const tally = { reparsed: 0, skipped: 0, failed: 0 };
let done = 0;
for (const id of batch) {
  const r = await reparse(id, { includeSuppressed: true });
  tally[r]++;
  if (++done % 25 === 0) console.log(`  ${done}/${batch.length} …`);
}

console.log(`\n再パース完了: 成功 ${tally.reparsed} / 対象外 ${tally.skipped} / 失敗 ${tally.failed}`);
console.log('次に `toiawase plan` を実行すると、新しいマッピングでプレビューが作られます。');
