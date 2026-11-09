import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config } from '../config.js';
import { prep } from '../db/db.js';
import { renderContent } from '../layers/l3_content.js';
import type { CompanyRow, FormSchema } from '../types.js';

/**
 * 文面パターンの台帳。
 *
 * **なぜファイル + DB の二段なのか。** 文面の定義（どのテンプレートで、何を
 * 確かめたいのか）は人が読み書きしてレビューするものなので
 * `config/variants.json` に置く。一方で「負けたので引退」「配信停止が多いので
 * 停止」のように学習ループが自動で変える状態は、バージョン管理下のファイルを
 * 実行のたびに書き換えないよう DB（variant_state）に置き、こちらを優先する。
 */

export type VariantStatus = 'draft' | 'active' | 'paused' | 'retired';

export interface Variant {
  /** 記録に残る名前。submissions.variant と集計の軸になる。 */
  name: string;
  /** config/templates/<template>.md */
  template: string;
  /** 何を検証しているのか。後から結果を読む人と、次の文面を作る LLM のために残す。 */
  hypothesis: string;
  status: VariantStatus;
  /** 対照群。未知の名前・未記録の送信はここに倒す。 */
  control?: boolean;
  /** どの文面から派生したか（変更点を一つに絞った比較の相手）。 */
  parent?: string;
  createdAt?: string;
  /** 状態が DB 側で上書きされている場合、その理由。 */
  statusReason?: string | null;
}

const REGISTRY_PATH = () => resolve(ROOT, 'config/variants.json');

/** 台帳ファイルが無いとき（古い checkout など）の既定値。 */
const FALLBACK: Variant[] = [
  {
    name: 'default',
    template: 'mochica_default',
    hypothesis: '対照群。約1,050字・依頼3つ（返信/資料送付/日程調整）。',
    status: 'active',
    control: true,
  },
  {
    name: 'short',
    template: 'mochica_short',
    hypothesis: '約半分の長さ・依頼は日程調整リンクの一つだけ。',
    status: 'active',
    parent: 'default',
  },
];

let _file: { mtimeMs: number; variants: Variant[] } | null = null;

function readFile(): Variant[] {
  const path = REGISTRY_PATH();
  if (!existsSync(path)) return FALLBACK.map((v) => ({ ...v }));
  const mtimeMs = statSync(path).mtimeMs;
  if (_file && _file.mtimeMs === mtimeMs) return _file.variants.map((v) => ({ ...v }));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { variants?: Variant[] };
  const variants = (raw.variants ?? []).filter((v) => v && v.name && v.template);
  _file = { mtimeMs, variants };
  return variants.map((v) => ({ ...v }));
}

/** 全パターン（状態は DB の上書きを反映済み）。 */
export function allVariants(): Variant[] {
  const defs = readFile();
  const states = new Map(
    (prep('SELECT name, status, reason FROM variant_state').all() as {
      name: string;
      status: VariantStatus;
      reason: string | null;
    }[]).map((r) => [r.name, r]),
  );
  return defs.map((v) => {
    const s = states.get(v.name);
    return s ? { ...v, status: s.status, statusReason: s.reason } : v;
  });
}

/** 配信中のパターン。名前順で返す（割り当ての累積順を固定するため）。 */
export function activeVariants(): Variant[] {
  return allVariants()
    .filter((v) => v.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function controlVariant(): Variant {
  const all = allVariants();
  return all.find((v) => v.control) ?? all[0] ?? FALLBACK[0];
}

/** 記録された名前から復元する。引退済みでも過去の送信は再現できる必要がある。 */
export function variantByName(name: string | null | undefined): Variant {
  if (name?.startsWith('manual:')) {
    const template = name.slice('manual:'.length);
    return { name, template, hypothesis: '手動指定', status: 'active' };
  }
  return allVariants().find((v) => v.name === name) ?? controlVariant();
}

export function setVariantStatus(
  name: string,
  status: VariantStatus,
  reason: string | null,
  actor: 'learning' | 'human' = 'human',
): void {
  if (!readFile().some((v) => v.name === name)) throw new Error(`文面パターン ${name} は台帳にありません`);
  prep(
    `INSERT INTO variant_state (name, status, reason, actor, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET status = excluded.status, reason = excluded.reason,
       actor = excluded.actor, updated_at = excluded.updated_at`,
  ).run(name, status, reason, actor);
}

/** 新しいパターンを台帳ファイルに追記する（挑戦者文面の生成時）。 */
export function addVariant(v: Variant): void {
  const path = REGISTRY_PATH();
  const raw = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { variants: Variant[] })
    : { variants: FALLBACK.map((x) => ({ ...x })) };
  if (raw.variants.some((x) => x.name === v.name)) throw new Error(`文面パターン ${v.name} は既にあります`);
  const { statusReason: _drop, ...def } = v;
  raw.variants.push(def);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  _file = null;
}

/** 状態の組み合わせ。学習結果が今の台帳に対して有効かを判定する指紋に使う。 */
export function registryKey(): string {
  return activeVariants()
    .map((v) => v.name)
    .join(',');
}

/* ------------------------------ 文面の点検 ------------------------------ */

const SAMPLE = {
  id: 999999,
  name: 'サンプル株式会社',
  domain: 'example.co.jp',
  status: 'PARSED',
} as unknown as CompanyRow;

const SAMPLE_SCHEMA = {
  formUrl: 'https://example.co.jp/contact/',
  fields: [],
  mappings: [{ role: 'message', selector: '#msg', confidence: 1 }],
  hasConfirmScreen: false,
  hasCaptcha: 'none',
  mappingConfidence: 1,
} as unknown as FormSchema;

/**
 * 実際の相手に届く前に、文面が最低限の条件を満たすかを確かめる。
 * 送信前点検・挑戦者文面の生成・人による承認の三か所で同じ基準を使う。
 */
export function templateProblems(template: string): { body: string; problems: string[] } {
  let body = '';
  try {
    body = renderContent(SAMPLE, SAMPLE_SCHEMA, { templateName: template }).body;
  } catch (e) {
    return { body, problems: [`読み込めない: ${(e as Error).message}`] };
  }
  const problems: string[] = [];
  if (!body.includes(config.sender.company)) problems.push('社名が無い');
  if (config.sender.email && !body.includes(config.sender.email)) problems.push('返信先が無い');
  if (!/不要|以後お送りいたしません/.test(body)) problems.push('配信停止の案内が無い');
  if (!body.includes(SAMPLE.name)) problems.push('宛先企業名が入らない');
  if (/\{\{|<!--/.test(body)) problems.push('テンプレートの記法が本文に残っている');
  if (config.sender.bookingUrl && !body.includes(config.sender.bookingUrl)) {
    problems.push('日程調整リンクが入らない');
  }
  return { body, problems };
}
