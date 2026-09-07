import { db } from '../db/db.js';

/**
 * アポ率を測るためのファネル集計。
 *
 * **なぜ必要か。** これまでシステムが持っていた唯一の数字は「送信成功件数」で、
 * それも L5 の誤判定で水増しされていた。送って何が起きたのかを保存する場所が
 * 無いので、「アポが 0 件」が文面の問題なのか、そもそも届いていないのか、
 * 誰にも切り分けられない。改善の試行錯誤は、まずこの切り分けができる状態を
 * 作らないと始まらない。
 *
 * ここでは推測を混ぜない。分からないものは `uncertain` として別に出す。
 */

export interface FunnelStage {
  label: string;
  n: number;
  /** 直前の段からの通過率。 */
  rate?: string;
  note?: string;
}

export interface VariantStat {
  variant: string;
  delivered: number;
  replies: number;
  appointments: number;
  replyRate: string;
  apptRate: string;
}

const pct = (a: number, b: number) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);

export function funnel(sinceDays?: number): {
  stages: FunnelStage[];
  variants: VariantStat[];
  evidence: FunnelStage[];
} {
  const d = db();
  const where = sinceDays ? `AND submitted_at >= datetime('now', '-${Number(sinceDays)} days')` : '';
  const count = (sql: string): number =>
    Number((d.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);

  const attempted = count(
    `SELECT COUNT(*) n FROM submissions WHERE status != 'plan_ready' AND submitted_at IS NOT NULL ${where}`,
  );
  const delivered = count(
    `SELECT COUNT(*) n FROM submissions WHERE status = 'submitted_success' ${where}`,
  );
  const uncertain = count(`SELECT COUNT(*) n FROM submissions WHERE status = 'uncertain' ${where}`);
  const failed = count(`SELECT COUNT(*) n FROM submissions WHERE status = 'failed' ${where}`);
  const captcha = count(`SELECT COUNT(*) n FROM submissions WHERE status = 'captcha' ${where}`);
  const review = count(`SELECT COUNT(*) n FROM submissions WHERE status = 'needs_review' ${where}`);

  const outcome = (kind: string) =>
    count(`SELECT COUNT(DISTINCT company_id) n FROM outcomes WHERE kind = '${kind}'`);
  const replies = outcome('reply');
  const appts = outcome('appointment');
  const refusals = outcome('refusal');

  const stages: FunnelStage[] = [
    { label: '送信試行', n: attempted },
    { label: '  ├ 到達（確証あり）', n: delivered, rate: pct(delivered, attempted) },
    {
      label: '  ├ 不明（到達の確証なし）',
      n: uncertain,
      rate: pct(uncertain, attempted),
      note: uncertain > 0 ? 'artifacts/result_<id>.png を目視で確認' : undefined,
    },
    { label: '  ├ 失敗', n: failed, rate: pct(failed, attempted) },
    { label: '  ├ CAPTCHA', n: captcha, rate: pct(captcha, attempted) },
    { label: '  └ 要確認', n: review, rate: pct(review, attempted) },
    { label: '返信', n: replies, rate: pct(replies, delivered), note: '到達分に対する返信率' },
    { label: '  ├ アポ', n: appts, rate: pct(appts, delivered), note: '到達分に対するアポ率' },
    { label: '  └ お断り', n: refusals, rate: pct(refusals, replies) },
  ];

  // 証拠の有無。ここが 0 に近いうちは、上の数字はどれも検証できない。
  const withShot = count(
    `SELECT COUNT(*) n FROM submissions WHERE result_screenshot_url IS NOT NULL ${where}`,
  );
  const withText = count(`SELECT COUNT(*) n FROM submissions WHERE result_text IS NOT NULL ${where}`);
  const evidence: FunnelStage[] = [
    { label: '結果スクリーンショットあり', n: withShot, rate: pct(withShot, attempted) },
    { label: '結果ページ本文あり', n: withText, rate: pct(withText, attempted) },
  ];

  const variants = (
    d
      .prepare(
        `SELECT COALESCE(s.variant, '(未設定)') variant,
                SUM(CASE WHEN s.status = 'submitted_success' THEN 1 ELSE 0 END) delivered,
                COUNT(DISTINCT CASE WHEN o.kind = 'reply' THEN o.company_id END) replies,
                COUNT(DISTINCT CASE WHEN o.kind = 'appointment' THEN o.company_id END) appointments
           FROM submissions s
           LEFT JOIN outcomes o ON o.company_id = s.company_id
          WHERE s.submitted_at IS NOT NULL ${where}
          GROUP BY variant
          ORDER BY delivered DESC`,
      )
      .all() as { variant: string; delivered: number; replies: number; appointments: number }[]
  ).map((r) => ({
    ...r,
    replyRate: pct(r.replies, r.delivered),
    apptRate: pct(r.appointments, r.delivered),
  }));

  return { stages, variants, evidence };
}

/** 人が読む形。数字だけでなく「今この数字を信じてよいか」も併せて出す。 */
export function formatFunnel(sinceDays?: number): string {
  const { stages, variants, evidence } = funnel(sinceDays);
  const out: string[] = [];
  out.push(sinceDays ? `=== ファネル（直近 ${sinceDays} 日） ===` : '=== ファネル（全期間） ===');
  for (const s of stages) {
    out.push(
      `${s.label.padEnd(28, '　')} ${String(s.n).padStart(6)}` +
        (s.rate ? `  ${s.rate.padStart(7)}` : '') +
        (s.note ? `   ${s.note}` : ''),
    );
  }
  out.push('', '--- 証拠の保存状況 ---');
  for (const e of evidence) out.push(`${e.label.padEnd(28, '　')} ${String(e.n).padStart(6)}  ${e.rate}`);

  const total = stages[0].n;
  const withShot = evidence[0].n;
  if (total > 0 && withShot / total < 0.5) {
    out.push(
      '',
      '⚠ 送信結果の証拠が半分も残っていない。ここが埋まるまで、上の「到達」件数は',
      '  検証できない推定値として扱うこと（旧実装は証拠を一切残していなかった）。',
    );
  }
  const appts = stages.find((s) => s.label.includes('アポ'))?.n ?? 0;
  const replies = stages.find((s) => s.label === '返信')?.n ?? 0;
  if (replies === 0) {
    out.push(
      '',
      '⚠ outcomes テーブルが空。返信・アポが本当に 0 なのか、記録していないだけ',
      '  なのかを区別できない。`toiawase outcome` で受信した返信を登録すること。',
    );
  } else if (appts === 0) {
    out.push('', `⚠ 返信 ${replies} 件に対しアポ 0 件。文面ではなく CTA / 返信対応の問題を疑う。`);
  }

  out.push('', '--- 文面パターン別 ---');
  if (variants.length === 0 || (variants.length === 1 && variants[0].variant === '(未設定)')) {
    out.push('  文面パターンが記録されていない（全件同一文面）。比較対象が無いため、');
    out.push('  どの文面が効いたのかは原理的に判定できない。');
  }
  for (const v of variants) {
    out.push(
      `  ${v.variant.padEnd(20, '　')} 到達 ${String(v.delivered).padStart(5)}` +
        `  返信 ${String(v.replies).padStart(4)} (${v.replyRate})` +
        `  アポ ${String(v.appointments).padStart(4)} (${v.apptRate})`,
    );
  }
  return out.join('\n');
}
