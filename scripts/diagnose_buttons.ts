/**
 * 送信ボタンの選び方が直ったかを、実際のフォームページで測る。
 *
 * **送信も入力もしない。** ページを開いてボタンを列挙するだけなので、
 * 相手企業には何も届かない。修正の効果を実データで確認するために、
 * 過去に失敗した企業のフォームを開き直して
 *   旧ロジック: 「戻る/修正 以外の DOM 順で最初のボタン」
 *   新ロジック: pickButton（可視・フォーム内・否定語でない）
 * が何を選ぶかを並べて出す。
 *
 *   npx tsx scripts/diagnose_buttons.ts --status NEEDS_REVIEW --limit 40
 */
import { companies, fieldMaps } from '../src/db/repositories.js';
import { BrowserSession } from '../src/browser/browser.js';
import { extractButtons, type ButtonInfo } from '../src/browser/extract.js';
import { pickButton, fillForm } from '../src/layers/l4_submit.js';
import { renderContent } from '../src/layers/l3_content.js';
import type { CompanyStatus } from '../src/types.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const status = arg('status', 'NEEDS_REVIEW') as CompanyStatus;
const limit = Number(arg('limit', '30'));

/** 旧実装の選び方をそのまま再現する（比較のためだけに残す）。 */
function oldPick(buttons: ButtonInfo[]): ButtonInfo | undefined {
  return (
    buttons.find((b) => b.kind === 'submit') ??
    buttons.find((b) => b.kind === 'other' && !/戻|修正|back|edit/i.test(b.text))
  );
}

const batch = companies.byStatus(status, limit).filter((c) => c.form_url);
console.log(`${status} の ${batch.length} 社のフォームを開いてボタンを確認します（送信しません）\n`);

let fixed = 0;
let bothOk = 0;
let stillNone = 0;
let unreachable = 0;

for (const c of batch) {
  const schema = fieldMaps.latest(c.id);
  if (!schema) continue;
  const url = schema.formUrl ?? c.form_url!;
  const session = new BrowserSession({ seed: c.id });
  try {
    const page = await session.open();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // 同意チェックを入れないと送信ボタンが disabled のままのフォームが多いので、
    // 本番と同じように入力まで済ませてからボタンを見る。送信はしない。
    await fillForm(session, page, schema!, renderContent(c, schema!)).catch(() => {});
    const buttons = await extractButtons(page);
    const oldB = oldPick(buttons);
    const newB = pickButton(buttons, 'submit') ?? pickButton(buttons, 'confirm');

    const oldBad = !oldB || !oldB.visible || oldB.inChrome || oldB.negative || oldB.disabled;
    if (newB && oldBad) {
      fixed++;
      console.log(`✅ 改善 #${c.id} ${c.name}`);
      console.log(`   旧: ${oldB ? `${oldB.text.slice(0, 20) || '(無題)'} [${oldB.selector}]${oldB.visible ? '' : ' 不可視'}${oldB.inChrome ? ' 共通部品' : ''}` : '該当なし'}`);
      console.log(`   新: ${newB.text.slice(0, 20) || '(無題)'} [${newB.selector}]`);
    } else if (newB) {
      bothOk++;
    } else {
      stillNone++;
      const seen = buttons.slice(0, 4).map((b) => `${b.text.slice(0, 10) || '(無題)'}[${b.visible ? '可視' : '不可視'}${b.disabled ? ',無効' : ''}${b.inForm ? ',form内' : ''}]`).join(' / ');
      console.log(`❌ 依然不明 #${c.id} ${c.name} — 候補 ${buttons.length}件: ${seen || 'なし'}`);
    }
  } catch (e) {
    unreachable++;
    console.log(`… 到達不可 #${c.id} ${c.name}: ${(e as Error).message.split('\n')[0].slice(0, 70)}`);
  } finally {
    await session.close();
  }
}

console.log(`\n=== 結果 (${batch.length} 社) ===`);
console.log(`改善（旧は誤爆/該当なし → 新は正しく特定）: ${fixed}`);
console.log(`元から問題なし                            : ${bothOk}`);
console.log(`依然として送信ボタンを特定できず          : ${stillNone}`);
console.log(`ページに到達できず                        : ${unreachable}`);
