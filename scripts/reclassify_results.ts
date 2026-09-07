/**
 * 旧 L5 が「成功」と記録した行のうち、**画面が一度も変化していないもの**を
 * `uncertain` に落とす一度きりの補正。
 *
 * 旧判定は本文に「ありがとうございます」等が含まれるだけで成功にしていた。
 * この文言は問い合わせフォーム画面の常設の挨拶として普通に出るため、
 * `nav=false url=false ... formGone=false`（URL も DOM も変わっていない）
 * の行は、送信が成立した形跡が一つも無いまま成功に数えられている。
 * その母数の上でアポ率を見ていたので、分母が実態より大きかった。
 *
 * 触るのは submissions.status だけ。企業の状態と抑制リストは動かさない
 *   - 抑制を外すと再送になり、万一届いていた企業へ二重送信になる
 *   - 二重送信は「届かなかった」より相手に対して明確に有害で、取り返せない
 * ので、判断材料（証拠）が無い以上ここでは再送可能にしない。
 *
 *   npx tsx scripts/reclassify_results.ts          # 件数だけ表示
 *   npx tsx scripts/reclassify_results.ts --apply  # 実際に更新
 */
import { db, tx } from '../src/db/db.js';
import { audit } from '../src/db/repositories.js';

const apply = process.argv.includes('--apply');
const conn = db();

// 「URL が変わらず・完了URLでもなく・フォームも消えていない」= 変化ゼロ。
const SELECT = `
  SELECT id, company_id, result_detail
    FROM submissions
   WHERE status = 'submitted_success'
     AND result_detail LIKE '%nav=false%'
     AND result_detail LIKE '%url=false%'
     AND result_detail LIKE '%formGone=false%'`;

const rows = conn.prepare(SELECT).all() as { id: number; company_id: number; result_detail: string }[];
const total = Number(
  (conn.prepare(`SELECT COUNT(*) n FROM submissions WHERE status='submitted_success'`).get() as any).n,
);

console.log(`成功と記録されている送信: ${total} 件`);
console.log(`うち画面が一度も変化していないもの: ${rows.length} 件 (${((rows.length / total) * 100).toFixed(1)}%)`);

if (!apply) {
  console.log('\n--apply を付けると uncertain に変更します（企業状態・抑制リストは変更しません）。');
  for (const r of rows.slice(0, 5)) console.log(`  例: submission#${r.id} company#${r.company_id}`);
  process.exit(0);
}

tx(() => {
  const upd = conn.prepare(
    `UPDATE submissions
        SET status = 'uncertain',
            result_detail = '[再分類] 画面が一度も変化していないため到達の確証なし / ' || result_detail
      WHERE id = ?`,
  );
  for (const r of rows) {
    upd.run(r.id);
    audit.log({
      companyId: r.company_id,
      layer: 'L5',
      action: 'reclassify:submitted_success->uncertain',
      actor: 'reclassify_results',
      detail: '旧判定は成功文言のみで成功としていた。画面変化の証拠が無いため到達未確認へ。',
    });
  }
});
console.log(`\n${rows.length} 件を uncertain に変更しました。\`npx tsx src/index.ts funnel\` で確認してください。`);
