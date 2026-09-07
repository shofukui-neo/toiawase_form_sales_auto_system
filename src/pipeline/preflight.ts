import { accessSync, constants, mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { db } from '../db/db.js';
import { renderContent } from '../layers/l3_content.js';
import { VARIANTS, assignVariant } from './experiment.js';
import { companies } from '../db/repositories.js';
import type { CompanyRow, FormSchema } from '../types.js';

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

const SAMPLE = {
  id: 999999,
  name: 'サンプル株式会社',
  domain: 'example.co.jp',
  status: 'PARSED',
} as unknown as CompanyRow;

const sampleSchema = {
  formUrl: 'https://example.co.jp/contact/',
  fields: [],
  mappings: [{ role: 'message', selector: '#msg', confidence: 1 }],
  hasConfirmScreen: false,
  hasCaptcha: 'none',
  mappingConfidence: 1,
} as unknown as FormSchema;

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
  for (const v of VARIANTS) {
    try {
      const { body } = renderContent(SAMPLE, sampleSchema, { templateName: v.template });
      const problems: string[] = [];
      if (!body.includes(config.sender.company)) problems.push('社名が無い');
      if (config.sender.email && !body.includes(config.sender.email)) problems.push('返信先が無い');
      if (!/不要|以後お送りいたしません/.test(body)) problems.push('配信停止の案内が無い');
      if (!body.includes(SAMPLE.name)) problems.push('宛先企業名が入らない');
      if (/\{\{|<!--/.test(body)) problems.push('テンプレートの記法が本文に残っている');
      out.push(
        problems.length
          ? { level: 'ng', title: `文面 ${v.name}`, detail: problems.join(' / ') }
          : { level: 'ok', title: `文面 ${v.name}`, detail: `${body.length}字 — ${v.hypothesis}` },
      );
    } catch (e) {
      out.push({ level: 'ng', title: `文面 ${v.name}`, detail: `読み込めない: ${(e as Error).message}` });
    }
  }
  return out;
}

function checkExperiment(): Check[] {
  const pending = companies.byStatus('PENDING_APPROVAL', 2000);
  if (pending.length === 0) {
    return [{ level: 'warn', title: '文面の割り当て', detail: '承認待ちの企業が無いので偏りを確認できない' }];
  }
  const counts = new Map<string, number>();
  for (const c of pending) {
    const n = assignVariant(c.id).name;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const shares = VARIANTS.map((v) => (counts.get(v.name) ?? 0) / pending.length);
  const skewed = shares.some((s) => s < 0.35 || s > 0.65);
  const detail = VARIANTS.map((v) => `${v.name} ${(((counts.get(v.name) ?? 0) / pending.length) * 100).toFixed(1)}%`).join(' / ');
  return [
    skewed
      ? { level: 'warn', title: '文面の割り当て', detail: `偏っている: ${detail}` }
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
