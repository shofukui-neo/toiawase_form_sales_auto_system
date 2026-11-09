import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config } from '../config.js';
import { prep } from '../db/db.js';
import { clearTemplateCache } from '../layers/l3_content.js';
import { logger } from '../utils/logger.js';
import { latestRound, learn, type ArmResult } from './learning.js';
import { addVariant, allVariants, templateProblems, type Variant } from './variants.js';

const log = logger('challenger');

/**
 * 次の挑戦者文面を作る（PDCA の Plan）。
 *
 * 勝っている文面（無ければ最良である確率が最も高い文面）を親にし、
 *   - これまでの各文面の仮説と結果（何が勝ち、何が負けたか）
 *   - 実際に届いた返信・お断りのメモ
 * を読ませて、**変更点を一つだけ**にした新しい文面を LLM に書かせる。
 * 一度に複数を変えると、勝っても負けても何が効いたのか分からなくなるため。
 *
 * **生成した文面は自動では配信しない。** 実在の企業に届く文章なので、
 * status=draft で台帳に入れ、人が読んで `variant activate` したものだけが
 * 配信に入る。自動で行うのは「下書きを作る」まで。
 *
 * 根拠の無い数字（導入社数・改善率など）を書かれると虚偽表示になるので、
 * 親文面に無い数字が入った下書きは保存せずに捨てる。
 */

export interface ChallengerResult {
  ok: boolean;
  variant?: Variant;
  body?: string;
  change?: string;
  problems: string[];
}

const COPY_MODEL = () => process.env.COPY_LLM_MODEL || 'claude-opus-5-5';

function templatePath(name: string): string {
  return resolve(ROOT, 'config/templates', `${name}.md`);
}

function pickParent(arms: ArmResult[], explicit?: string): Variant {
  const all = allVariants();
  if (explicit) {
    const v = all.find((x) => x.name === explicit);
    if (!v) throw new Error(`親にする文面 ${explicit} が台帳にありません`);
    return v;
  }
  const best = [...arms].filter((a) => a.share > 0).sort((a, b) => b.pBest - a.pBest)[0];
  return all.find((v) => v.name === best?.name) ?? all.find((v) => v.status === 'active') ?? all[0];
}

/** 返信・お断りの生の声。文面の何が刺さり、何が嫌がられたかの一次情報。 */
function recentVoices(limit = 40): string[] {
  const rows = prep(
    `SELECT o.kind, o.note, s.variant FROM outcomes o
       LEFT JOIN submissions s ON s.id = COALESCE(o.submission_id,
         (SELECT id FROM submissions WHERE company_id = o.company_id AND submitted_at IS NOT NULL
           ORDER BY id DESC LIMIT 1))
      WHERE o.note IS NOT NULL AND TRIM(o.note) != ''
      ORDER BY o.id DESC LIMIT ?`,
  ).all(limit) as { kind: string; note: string; variant: string | null }[];
  return rows.map((r) => `- [${r.kind} / ${r.variant ?? '?'}] ${r.note.replace(/\s+/g, ' ').slice(0, 200)}`);
}

function history(arms: ArmResult[]): string {
  const all = allVariants();
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  return all
    .filter((v) => v.status !== 'draft')
    .map((v) => {
      const a = arms.find((x) => x.name === v.name);
      const result = a
        ? `送信 ${a.delivered} / アポ ${a.appointments} / 前向き返信 ${a.positiveReplies} / お断り・停止 ${a.refusals + a.optouts} / 成果率 ${pct(a.rate)} / 最良の確率 ${a.share ? pct(a.pBest) : '—'}`
        : 'まだ送信なし';
      const status = v.status + (v.statusReason ? `（${v.statusReason}）` : '');
      return `- ${v.name} [${status}] 親=${v.parent ?? 'なし'}\n  仮説: ${v.hypothesis}\n  結果: ${result}`;
    })
    .join('\n');
}

function digits(s: string): Set<string> {
  return new Set((s.normalize('NFKC').match(/\d+(?:[.,]\d+)?/g) ?? []).map((d) => d.replace(/,/g, '')));
}

function buildPrompt(parent: Variant, parentRaw: string, arms: ArmResult[], voices: string[]): string {
  return `あなたは BtoB のフォーム営業（企業の問い合わせフォームへの営業文送信）の文面改善担当です。
商材は新卒採用管理システム（応募者とのやり取りを LINE に集約するもの）、宛先は企業の新卒採用担当者です。
目的は「返信」ではなく「商談（アポ）」の獲得です。お断り・配信停止が増える文面は失敗とみなします。

## これまでの文面と結果
${history(arms)}

## 実際に届いた反応のメモ（新しい順）
${voices.length ? voices.join('\n') : '（まだ記録なし）'}

## 親にする文面（${parent.name}）
\`\`\`
${parentRaw}
\`\`\`

## 依頼
親の文面から**変更点を一つだけ**選んで、新しい挑戦者文面を書いてください。
変更点は、上の結果と反応から「次に確かめる価値が最も高い」と考える一点にしてください。
既に試して負けた方向（引退・停止した文面の仮説）は繰り返さないでください。
変更点の例: 件名の切り口 / 冒頭の一文 / 依頼（CTA）の言い方や数 / 本文の長さ / 課題提起の角度。

## 守ること（一つでも破ると使えません）
- テンプレート記法はそのまま使う: {{company}} {{senderCompany}} {{senderPerson}} {{senderProduct}} {{signature}} は必ず残す。
  親にある {{reason}} {{senderDepartment}} は使ってもよい。新しい {{変数}} は作らない。
- 親に <!--if:bookingUrl--> … {{bookingUrl}} … <!--/if--> があれば、その形のまま必ず残す。
- 配信停止の案内（「ご不要でしたらその旨ご返信ください。以後お送りいたしません。」に相当する文）を必ず残す。
- 親の文面に無い数字・実績・導入社数・改善率・顧客名・受賞歴・期間限定などの事実を書かない（虚偽表示になる）。
- 誇張・煽り・なれなれしい表現をしない。採用担当者が社内に転送しても恥ずかしくない文体にする。
- 本文は親の 1.3 倍の長さを超えない。

## 出力
説明文を付けず、次の JSON だけを出力してください。
{"change": "変えた一点（20字程度）", "hypothesis": "なぜそれでアポが増えると考えるか（60字程度）", "subject": "件名（テンプレート記法可）", "body": "本文（テンプレート記法をそのまま含む）"}`;
}

function parseJson(text: string): { change: string; hypothesis: string; subject: string; body: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.subject === 'string' && typeof j.body === 'string' && typeof j.hypothesis === 'string') {
      return { change: String(j.change ?? ''), hypothesis: j.hypothesis, subject: j.subject, body: j.body };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** LLM の出力が実在の相手に送ってよい形かを確かめる。テンプレートとして書き出した後に呼ぶ。 */
export function validateChallenger(name: string, parentRaw: string, raw: string): string[] {
  const problems: string[] = [];
  for (const v of ['company', 'senderCompany', 'senderPerson', 'signature']) {
    if (!raw.includes(`{{${v}}}`)) problems.push(`{{${v}}} が無い`);
  }
  const allowed = new Set(['company', 'senderCompany', 'senderPerson', 'senderProduct', 'signature', 'reason', 'senderDepartment', 'bookingUrl']);
  for (const m of raw.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (!allowed.has(m[1])) problems.push(`未知の変数 {{${m[1]}}}`);
  }
  if (parentRaw.includes('<!--if:bookingUrl-->') && !/<!--if:bookingUrl-->[\s\S]*\{\{bookingUrl\}\}[\s\S]*<!--\/if-->/.test(raw)) {
    problems.push('日程調整リンクの条件ブロックが崩れている');
  }
  const parentDigits = digits(parentRaw);
  const invented = [...digits(raw)].filter((d) => !parentDigits.has(d));
  if (invented.length) problems.push(`親に無い数字がある（根拠の無い実績の恐れ）: ${invented.join(', ')}`);
  if (raw.length > parentRaw.length * 1.3) problems.push(`長すぎる（${raw.length}字 / 親 ${parentRaw.length}字）`);
  problems.push(...templateProblems(name).problems);
  return problems;
}

export async function generateChallenger(opts: { parent?: string; dryRun?: boolean } = {}): Promise<ChallengerResult> {
  if (!config.anthropicApiKey) {
    return { ok: false, problems: ['ANTHROPIC_API_KEY が未設定のため挑戦者文面を生成できません'] };
  }
  const round = latestRound() ?? learn({ apply: true });
  const parent = pickParent(round.arms, opts.parent);
  const parentRaw = readFileSync(templatePath(parent.template), 'utf8');
  const prompt = buildPrompt(parent, parentRaw, round.arms, recentVoices());

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  let text = '';
  try {
    const res = await client.messages.create({
      model: COPY_MODEL(),
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    });
    if ((res.stop_reason as string) === 'refusal') {
      return { ok: false, problems: ['モデルが生成を断りました（stop_reason=refusal）'] };
    }
    if (res.stop_reason === 'max_tokens') {
      return { ok: false, problems: ['出力が途中で切れました（max_tokens）'] };
    }
    text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  } catch (e) {
    if (e instanceof Anthropic.APIError) return { ok: false, problems: [`API エラー ${e.status}: ${e.message}`] };
    throw e;
  }

  const out = parseJson(text);
  if (!out) return { ok: false, problems: ['モデルの出力を JSON として読めませんでした'] };

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let name = `gen${stamp}`;
  for (let i = 2; allVariants().some((v) => v.name === name) || existsSync(templatePath(`mochica_${name}`)); i++) {
    name = `gen${stamp}_${i}`;
  }
  const template = `mochica_${name}`;
  const raw = `---\nsubject: ${out.subject.replace(/\n/g, ' ').trim()}\n---\n${out.body.trim()}\n`;

  writeFileSync(templatePath(template), raw, 'utf8');
  clearTemplateCache();
  const problems = validateChallenger(template, parentRaw, raw);
  const { body } = templateProblems(template);

  if (problems.length || opts.dryRun) {
    unlinkSync(templatePath(template));
    clearTemplateCache();
    if (problems.length) log.warn(`挑戦者文面を破棄: ${problems.join(' / ')}`);
    return { ok: problems.length === 0, body, change: out.change, problems };
  }

  const variant: Variant = {
    name,
    template,
    hypothesis: `${out.change ? `【${out.change}】` : ''}${out.hypothesis}`,
    status: 'draft',
    parent: parent.name,
    createdAt: new Date().toISOString().slice(0, 10),
  };
  addVariant(variant);
  return { ok: true, variant, body, change: out.change, problems: [] };
}
