/**
 * バリデーションで弾かれた企業について、「どの欄が埋まっていないのか」を測る。
 *
 * **クリックも送信もしない。** フォームを開いて本番と同じ入力を行い、そのあと
 * HTML5 の制約検証 (checkValidity / validationMessage) と「必須なのに空の欄」を
 * DOM から読むだけ。送信ボタンには一切触れないので、相手には何も届かない。
 *
 * SUBMITTED_FAILED は 291 件あるが、result_detail には
 * 「validation/error text present」としか残っておらず、どの欄が原因なのかは
 * 記録されていない。原因の分布が分からなければ、直す順番も決められない。
 *
 *   npx tsx scripts/diagnose_validation.ts --limit 20
 */
import { companies, fieldMaps } from '../src/db/repositories.js';
import { BrowserSession } from '../src/browser/browser.js';
import { fillForm } from '../src/layers/l4_submit.js';
import { renderContent } from '../src/layers/l3_content.js';
import type { CompanyStatus } from '../src/types.js';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const status = arg('status', 'SUBMITTED_FAILED') as CompanyStatus;
const limit = Number(arg('limit', '20'));

interface Empty {
  label: string;
  tag: string;
  type: string;
  name: string;
  message: string;
}

const tally = new Map<string, number>();
const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);

const batch = companies.byStatus(status, limit).filter((c) => c.form_url);
console.log(`${status} の ${batch.length} 社を検査します（クリックも送信もしません）\n`);

let clean = 0;
let unreachable = 0;

for (const c of batch) {
  const schema = fieldMaps.latest(c.id);
  if (!schema) continue;
  const session = new BrowserSession({ seed: c.id });
  try {
    const page = await session.open();
    await page.goto(schema.formUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await fillForm(session, page, schema, renderContent(c, schema)).catch(() => {});

    // 必須なのに空のまま残っている欄を読む。ボタンには触れない。
    const empties: Empty[] = await page.evaluate(() => {
      function labelOf(el: Element): string {
        const id = (el as HTMLElement).id;
        if (id) {
          const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (l?.textContent?.trim()) return l.textContent.trim();
        }
        const wrap = el.closest('label');
        if (wrap?.textContent?.trim()) return wrap.textContent.trim();
        const row = el.closest('tr, dd, .form-group, li, div');
        const th = row?.previousElementSibling?.textContent?.trim();
        return (th || row?.querySelector('th, dt, label')?.textContent?.trim() || '').slice(0, 30);
      }
      const out: any[] = [];
      const els = Array.from(
        document.querySelectorAll('input, textarea, select'),
      ) as HTMLInputElement[];
      for (const el of els) {
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const required = el.required || el.getAttribute('aria-required') === 'true';
        const filled =
          el.type === 'checkbox' || el.type === 'radio' ? el.checked : !!el.value.trim();
        const invalid = typeof el.checkValidity === 'function' && !el.checkValidity();
        if ((required && !filled) || invalid) {
          out.push({
            label: labelOf(el).replace(/\s+/g, ' '),
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.name || '',
            message: el.validationMessage || '',
          });
        }
      }
      return out.slice(0, 12);
    });

    if (empties.length === 0) {
      clean++;
      console.log(`✅ #${c.id} ${c.name} — 必須欄はすべて埋まっている`);
    } else {
      console.log(`⚠ #${c.id} ${c.name} — 未充足 ${empties.length} 件`);
      for (const e of empties) {
        const key = `${e.tag}${e.type ? `[${e.type}]` : ''} ${e.label || e.name || '(ラベル不明)'}`;
        bump(key);
        console.log(`     ${key}${e.message ? ` … ${e.message}` : ''}`);
      }
    }
  } catch (e) {
    unreachable++;
    console.log(`… #${c.id} 到達不可: ${(e as Error).message.split('\n')[0].slice(0, 60)}`);
  } finally {
    await session.close();
  }
}

console.log(`\n=== 集計 (${batch.length} 社) ===`);
console.log(`必須欄がすべて埋まっていた: ${clean}`);
console.log(`到達不可                  : ${unreachable}`);
console.log('\n--- 埋まらなかった欄（多い順） ---');
[...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}x  ${k}`));
