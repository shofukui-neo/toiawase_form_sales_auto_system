import { accessSync, constants, mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { db } from '../db/db.js';
import { assignVariant } from './experiment.js';
import { currentWeights } from './learning.js';
import { activeVariants, allVariants, templateProblems } from './variants.js';
import { companies } from '../db/repositories.js';

/**
 * 送信を始める前の点検。
 *
 * これまでに見つかった不具合は、どれも「動いてはいるが、出している数字が
 * 実態と違う」種類のものだった。送信結果の証拠が一枚も残っていない、
 * 除外理由が実態を指していない、承認画面と送信内容が食い違う——いずれも
 * 例外は出ないので、走らせているだけでは気づけない。
 *
 * ここでは「気づけないまま走り続ける」状態を作らないために、送る前に
 * 確かめられることを全部確かめる。落ちるべきものは落とす。
 */

export type Level = 'ok' | 'warn' | 'ng';

export interface Check {
  level: Level;
  title: string;
  detail: string;
}

function checkSender(): Check[] {
  const s = config.sender;
  const out: Check[] = [];
  const missing = (['company', 'person', 'email'] as const).filter((k) => !s[k]);
  out.push(
    missing.length
      ? { level: 'ng', title: '送信者の身元', detail: `未設定: ${missing.join(', ')} — §9 が求める名乗りができない` }
      : { level: 'ok', title: '送信者の身元', detail: `${s.company} / ${s.person} / ${s.email}` },
  );

  // 日程調整リンクは short 群の唯一の依頼。落ちると片方の腕が依頼を失い、
  // A/B の比較そのものが成立しなくなる。
  out.push(
    s.bookingUrl
      ? { level: 'ok', title: '日程調整リンク', detail: s.bookingUrl }
      : {
          level: 'ng',
          title: '日程調整リンク',
          detail: 'SENDER_BOOKING_URL が未設定 — short 群が唯一の依頼を失い、A/B の比較にならない',
        },
  );
  return out;
}

function checkTemplates(): Check[] {
  const out: Check[] = [];
  // 配信中に加え、承認待ちの下書きも点検する（activate する前に問題が見えるように）。
  for (const v of allVariants().filter((x) => x.status === 'active' || x.status === 'draft')) {
    const { body, problems } = templateProblems(v.template);
    const title = `文面 ${v.name}${v.status === 'draft' ? '(下書き)' : ''}`;
    out.push(
      problems.length
        ? { level: v.status === 'draft' ? 'warn' : 'ng', title, detail: problems.join(' / ') }
        : { level: 'ok', title, detail: `${body.length}字 — ${v.hypothesis}` },
    );
  }
  return out;
}

function checkExperiment(): Check[] {
  const active = activeVariants();
  if (active.length < 2) {
    return [{ level: 'warn', title: '文面の割り当て', detail: `配信中の文面が ${active.length} 本 — 比較相手が無く学習が進まない` }];
  }
  const pending = companies.byStatus('PENDING_APPROVAL', 2000);
  if (pending.length === 0) {
    return [{ level: 'warn', title: '文面の割り当て', detail: '承認待ちの企業が無いので偏りを確認できない' }];
  }
  const counts = new Map<string, number>();
  for (const c of pending) {
    const n = assignVariant(c.id).name;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  // 配分は学習で意図的に偏る。見るのは「学習した配分どおりに割れているか」。
  const weights = currentWeights();
  const sumW = active.reduce((s, v) => s + (weights[v.name] ?? 1 / active.length), 0);
  const drift = active.some((v) => {
    const want = (weights[v.name] ?? 1 / active.length) / sumW;
    const got = (counts.get(v.name) ?? 0) / pending.length;
    return pending.length >= 200 && Math.abs(want - got) > 0.1;
  });
  const detail = active
    .map((v) => {
      const want = ((weights[v.name] ?? 1 / active.length) / sumW) * 100;
      const got = ((counts.get(v.name) ?? 0) / pending.length) * 100;
      return `${v.name} ${got.toFixed(1)}%（配分 ${want.toFixed(1)}%）`;
    })
    .join(' / ');
  return [
    drift
      ? { level: 'warn', title: '文面の割り当て', detail: `配分からずれている: ${detail}` }
      : { level: 'ok', title: '文面の割り当て', detail: `${pending.length} 社: ${detail}` },
  ];
}

function checkEvidence(): Check[] {
  const out: Check[] = [];
  try {
    mkdirSync(config.artifactsDir, { recursive: true });
    accessSync(config.artifactsDir, constants.W_OK);
    out.push({ level: 'ok', title: '証拠の保存先', detail: config.artifactsDir });
  } catch (e) {
    out.push({
      level: 'ng',
      title: '証拠の保存先',
      detail: `書き込めない: ${(e as Error).message} — 送信結果のスクリーンショットが残らない`,
    });
  }

  const row = db()
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN result_screenshot_url IS NOT NULL THEN 1 ELSE 0 END) shots
         FROM submissions WHERE submitted_at IS NOT NULL AND status != 'plan_ready'`,
    )
    .get() as { total: number; shots: number };
  if (row.total > 0 && (row.shots ?? 0) === 0) {
    out.push({
      level: 'warn',
      title: '過去の送信結果',
      detail: `${row.total} 件すべてに結果の証拠が無い（証拠を残すようになる前の送信）— 過去の到達件数は検証できない`,
    });
  }
  return out;
}

function checkPacing(): Check[] {
  const out: Check[] = [];
  const { sendWindowStart: start, sendWindowEnd: end } = config;
  const width = start === end ? 24 : start < end ? end - start : 24 - start + end;
  out.push(
    width >= 4
      ? { level: 'ok', title: '送信時間帯', detail: `${start}時〜${end}時（${width}時間）` }
      : { level: 'warn', title: '送信時間帯', detail: `${start}時〜${end}時 — 幅が狭く、1日の上限に届かない可能性` },
  );
  out.push({ level: 'ok', title: '1日の上限', detail: `${config.dailySendLimit} 件 / 同時実行 ${config.sendConcurrency}` });
  return out;
}

function checkOutcomes(): Check[] {
  const n = Number((db().prepare('SELECT COUNT(*) n FROM outcomes').get() as { n: number }).n);
  const sent = Number(
    (db().prepare(`SELECT COUNT(*) n FROM submissions WHERE status='submitted_success'`).get() as { n: number }).n,
  );
  if (n === 0 && sent > 0) {
    return [
      {
        level: 'warn',
        title: '返信・アポの記録',
        detail:
          `到達 ${sent} 件に対し記録 0 件 — 返信が本当に無いのか、記録していないだけなのかを区別できない。` +
          '`import-replies` か `outcome` で記録すること',
      },
    ];
  }
  return [{ level: 'ok', title: '返信・アポの記録', detail: `${n} 件` }];
}

export function preflight(): Check[] {
  return [
    ...checkSender(),
    ...checkTemplates(),
    ...checkExperiment(),
    ...checkEvidence(),
    ...checkPacing(),
    ...checkOutcomes(),
  ];
}

export function formatPreflight(checks: Check[]): string {
  const mark: Record<Level, string> = { ok: '✓', warn: '!', ng: '✗' };
  const lines = ['=== 送信前の点検 ==='];
  for (const c of checks) lines.push(`${mark[c.level]} ${c.title.padEnd(14, '　')} ${c.detail}`);

  const ng = checks.filter((c) => c.level === 'ng').length;
  const warn = checks.filter((c) => c.level === 'warn').length;
  lines.push('');
  if (ng > 0) lines.push(`✗ ${ng} 件が送信を止める問題です。直してから送信してください。`);
  else if (warn > 0) lines.push(`! 送信できますが、${warn} 件は結果の解釈に影響します。`);
  else lines.push('✓ 問題は見つかりませんでした。');
  return lines.join('\n');
}
