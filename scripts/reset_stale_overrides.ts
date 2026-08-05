import { config } from '../src/config.js';
import { companies, contentOverrides } from '../src/db/repositories.js';
import { buildSignature } from '../src/layers/l3_content.js';

/**
 * Drop dashboard message/subject edits that were written against an older
 * sender identity or an older template.
 *
 * A manual edit is stored verbatim and wins over the rendered template forever
 * (that is the point — a human correction must survive a re-plan). But when the
 * sender identity itself changes — a corrected 社名, a new signature block — an
 * old pinned 本文 keeps sending the *wrong* company name, silently, with no sign
 * of it in the dashboard. So: clear only the stale 本文/件名, and keep every
 * other edited field (氏名・電話 等) untouched.
 *
 *   npx tsx scripts/reset_stale_overrides.ts          # 確認のみ（dry run）
 *   npx tsx scripts/reset_stale_overrides.ts --apply  # 実際に削除
 */

const apply = process.argv.includes('--apply');

const LEGAL_FORMS = ['株式会社', '有限会社', '合同会社', '一般社団法人', '一般財団法人'];

/**
 * Legal-name orderings of the sender company that are NOT the configured one —
 * e.g. 「ネオキャリア株式会社」 when we are 「株式会社ネオキャリア」.
 *
 * This is the failure that hides best: a hand-edited 本文 can carry a perfectly
 * up-to-date signature block and still open with the company's name in the wrong
 * order, because only the tail was re-pasted. Nothing else flags it.
 */
function wrongLegalNameVariants(): string[] {
  const full = config.sender.company;
  const form = LEGAL_FORMS.find((f) => full.startsWith(f) || full.endsWith(f));
  if (!form) return [];
  const core = full.replace(form, '').trim();
  if (!core) return [];
  return [`${core}${form}`, `${form}${core}`].filter((v) => v !== full);
}

/**
 * Staleness reasons for a pinned body:
 *  - it does not carry the *current* signature block (generated from the live
 *    sender identity, so an exact-substring check answers precisely "was this
 *    written against the identity we send as today?"), or
 *  - it spells our own company name in an ordering we no longer use.
 *
 * A human who edited the pitch but kept both correct is left alone.
 */
const signature = buildSignature();
const wrongNames = wrongLegalNameVariants();

function stalenessReasons(text: string): string[] {
  const reasons: string[] = [];
  if (!text.includes(signature)) reasons.push('署名ブロックが現行と不一致');
  const badName = wrongNames.find((v) => text.includes(v));
  if (badName) reasons.push(`旧社名「${badName}」を含む（正: ${config.sender.company}）`);
  return reasons;
}

let checked = 0;
let stale = 0;

for (const company of companies.all()) {
  const ov = contentOverrides.get(company.id);
  if (!ov) continue;
  checked++;

  const message = ov.values.message;
  if (typeof message !== 'string' || message.length === 0) continue;
  const reasons = stalenessReasons(message);
  if (reasons.length === 0) continue;

  stale++;
  // 件名は本文と同じ編集操作で保存されるため、まとめて破棄する。
  const dropped = ['message', ...(ov.values.subject != null ? ['subject'] : [])];
  console.log(`#${company.id} ${company.name}`);
  for (const r of reasons) console.log(`    - ${r}`);
  console.log(`    -> 破棄対象: ${dropped.join(', ')}`);
  if (!apply) continue;

  const kept = { ...ov.values };
  delete kept.message;
  delete kept.subject;
  if (Object.keys(kept).length === 0) contentOverrides.clear(company.id);
  else contentOverrides.set(company.id, { values: kept });
}

console.log(
  `\n手動編集あり=${checked} / 旧文面=${stale}` +
    (stale === 0
      ? ''
      : apply
        ? ' — 削除しました。次回プラン生成で最新テンプレートが使われます。'
        : ' — 削除するには --apply を付けて再実行してください。'),
);
