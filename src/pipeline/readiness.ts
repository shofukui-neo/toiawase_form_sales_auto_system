import type { CompanyRow, CompanyStatus } from '../types.js';
import { companies, fieldMaps, submissions } from '../db/repositories.js';
import { computeCoverage, type Coverage, type FieldReview } from '../layers/coverage.js';
import { classifyEligibility, type IneligibleReason } from '../crosscutting/eligibility.js';
import { preSendCheck } from '../crosscutting/compliance.js';
import { verifyContent } from '../crosscutting/contentGuard.js';
import { renderContent } from '../layers/l3_content.js';
import { STATUS_JA } from './intake.js';

/**
 * 送信可否ゲート（一斉送信の入場条件）。
 *
 * 運用ルール: **すべての項目に問題がない企業だけ** を一斉送信の対象にする。
 * 「問題がない」は承認ダッシュボード（② 確認・承認）が項目単位で表示している
 * のと同じ判定 — 共有の coverage 予測 (layers/coverage) と適格性判定
 * (crosscutting/eligibility) — をそのまま使う。画面で緑になっているものだけが
 * 送信対象になる、という一対一の関係を保つため、判定ロジックはここで重複させず
 * 必ず既存モジュールに委譲する。
 *
 * ここを通らなかった企業は送信されず、理由付きで「保留」に並ぶ（② で手直し →
 * 再プレビューすれば次のスキャンで自動的に送信対象へ戻る）。
 */

/** 送信対象になりうる状態。これ以外（未解析・却下・送信済み等）は最初から対象外。 */
export const SENDABLE_STATUSES: CompanyStatus[] = ['PENDING_APPROVAL', 'APPROVED', 'SUBMITTING'];
const SENDABLE = new Set<CompanyStatus>(SENDABLE_STATUSES);

export type SendIssueCode =
  | 'bad_status'
  | 'suppressed'
  | 'no_form'
  | 'no_schema'
  | 'no_plan'
  | 'ineligible'
  | 'missing_required'
  | 'suspect_field'
  | 'required_unfilled'
  | 'content_check'
  /* --- warnings (送信は止めない) --- */
  | 'captcha'
  | 'auto_choice';

export interface SendIssue {
  code: SendIssueCode;
  label: string;
  detail?: string;
}

export interface SendReadiness {
  companyId: number;
  name: string;
  domain: string;
  formUrl: string | null;
  status: CompanyStatus;
  statusJa: string;
  gate: string;
  icpScore: number | null;
  /** 全項目クリア＝一斉送信の対象。 */
  ready: boolean;
  /** ready だが人の承認をまだ受けていない（送信時に自動承認される）。 */
  needsApproval: boolean;
  /** 送信をブロックする問題。空なら ready。 */
  issues: SendIssue[];
  /** ブロックはしないが把握しておくべき点（CAPTCHA / 自動選択項目など）。 */
  warnings: SendIssue[];
  coverage: Coverage | null;
  approvedBy: string | null;
  screenshot: string | null;
}

const ELIGIBILITY_JA: Record<IneligibleReason, string> = {
  captcha: 'CAPTCHA必須',
  no_sales_policy: '営業お断り',
  off_topic_form: '用途違い（通報・苦情等）',
  consumer_form: '消費者向け/非B2B',
  unfillable_required: '入力できない必須あり',
  message_too_long: '本文が入力上限を超過',
  not_contactable: '本文/会社名の入力先なし',
};

/** 問題のあった項目名を数件だけ添える（一覧で理由が一目で分かるように）。 */
function sampleLabels(fields: FieldReview[], status: FieldReview['status'], max = 3): string {
  const hit = fields.filter((f) => f.status === status).map((f) => f.label || '(ラベルなし)');
  const head = hit.slice(0, max).join(' / ');
  return hit.length > max ? `${head} ほか${hit.length - max}件` : head;
}

/**
 * 1社の送信可否を判定する。DB を読むだけで、状態は一切変更しない
 * （画面表示にも一斉送信の直前チェックにも同じ関数を使うため）。
 */
export function assessSendReadiness(company: CompanyRow): SendReadiness {
  const issues: SendIssue[] = [];
  const warnings: SendIssue[] = [];
  const schema = fieldMaps.latest(company.id);
  const sub = submissions.latestForCompany(company.id);
  let coverage: Coverage | null = null;

  if (!SENDABLE.has(company.status)) {
    issues.push({
      code: 'bad_status',
      label: `送信できる状態ではありません（${STATUS_JA[company.status] ?? company.status}）`,
    });
  }

  // 抑制リスト（送信済み / オプトアウト / 競合 / 営業お断り）— §9。
  const compliance = preSendCheck(company.domain);
  if (!compliance.allowed) {
    issues.push({ code: 'suppressed', label: '抑制リストに該当', detail: compliance.detail });
  }

  if (!company.form_url) issues.push({ code: 'no_form', label: 'フォーム未発見' });

  if (!schema) {
    issues.push({ code: 'no_schema', label: 'フォーム未解析' });
  } else {
    const cov = computeCoverage(company, schema);
    coverage = cov.coverage;
    const elig = classifyEligibility(schema, cov);
    if (!elig.eligible) {
      issues.push({
        code: 'ineligible',
        label: `非適格フォーム（${elig.reason ? ELIGIBILITY_JA[elig.reason] : '不明'}）`,
        detail: elig.detail,
      });
    }
    if (cov.coverage.missing > 0) {
      issues.push({
        code: 'missing_required',
        label: `必須が未入力 ${cov.coverage.missing} 件`,
        detail: sampleLabels(cov.fields, 'missing'),
      });
    }
    // 「誤り疑い」には入力上限超過（本文が途中で切れる）も含まれる。
    if (cov.coverage.suspect > 0) {
      issues.push({
        code: 'suspect_field',
        label: `誤り疑い ${cov.coverage.suspect} 件`,
        detail: sampleLabels(cov.fields, 'suspect'),
      });
    }
    // missing 以外の理由（値なしの任意扱い等）で必須が埋まらないケースの保険。
    if (cov.coverage.requiredFilled < cov.coverage.requiredTotal && cov.coverage.missing === 0) {
      issues.push({
        code: 'required_unfilled',
        label: `必須 ${cov.coverage.requiredFilled}/${cov.coverage.requiredTotal} しか埋まりません`,
      });
    }

    // 送信内容そのものの検証（氏名・電話番号・日程調整URL・文面）。
    // runExecute にも同じゲートがあるが、そちらは「送信の瞬間に止める」ための
    // もの。ここで先に落としておくと、②の一覧で理由が見えるうえ、一斉送信の
    // ワーカーが最初から候補として拾わない。
    try {
      const verdict = verifyContent(company, schema, renderContent(company, schema));
      for (const v of verdict.issues) {
        issues.push({ code: 'content_check', label: v.label, detail: v.detail });
      }
    } catch (e) {
      // テンプレート読み込み失敗など。内容を確認できない以上は送らせない。
      issues.push({
        code: 'content_check',
        label: '送信内容を検証できません',
        detail: (e as Error).message,
      });
    }

    if (schema.hasCaptcha && schema.hasCaptcha !== 'none') {
      warnings.push({ code: 'captcha', label: `CAPTCHA ${schema.hasCaptcha}（送信が弾かれる可能性）` });
    }
    const autoFields = cov.fields.filter((f) => f.status === 'auto').length;
    if (autoFields > 0) {
      warnings.push({
        code: 'auto_choice',
        label: `実行時に自動選択 ${autoFields} 件`,
        detail: sampleLabels(cov.fields, 'auto'),
      });
    }
  }

  // プレビュー（Plan）が無い＝人が確認できる送信内容が存在しない状態。
  if (!sub) issues.push({ code: 'no_plan', label: '送信プレビュー未作成' });

  return {
    companyId: company.id,
    name: company.name,
    domain: company.domain,
    formUrl: company.form_url,
    status: company.status,
    statusJa: STATUS_JA[company.status] ?? company.status,
    gate: schema?.gate ?? 'unknown',
    icpScore: company.icp_score ?? null,
    ready: issues.length === 0,
    needsApproval: company.status === 'PENDING_APPROVAL',
    issues,
    warnings,
    coverage,
    approvedBy: sub?.approved_by ?? null,
    screenshot: sub?.plan_screenshot_url ?? null,
  };
}

export interface SendabilitySnapshot {
  /** 全項目クリアで一斉送信できる企業。 */
  ready: SendReadiness[];
  /** 問題があって送信されない企業（理由付き）。 */
  blocked: SendReadiness[];
  readyCount: number;
  blockedCount: number;
  /** 判定した候補数（= scanned）。候補総数が limit を超えると打ち切られる。 */
  scanned: number;
  candidateTotal: number;
  truncated: boolean;
}

/**
 * 送信候補（承認待ち／承認済み／送信中）を上位 `limit` 件だけ判定して返す。
 *
 * 3万社の判定はフォーム解析結果の展開を伴うので、ダッシュボードのポーリングで
 * 全件を回すわけにはいかない。ICP スコア順の上位だけを見せ、残りは
 * `truncated` で示す（一斉送信ワーカー側は候補全体をページングして走査する）。
 */
export function sendabilitySnapshot(limit = 200): SendabilitySnapshot {
  const candidateTotal = companies.countByStatuses(SENDABLE_STATUSES);
  const rows = companies.byStatuses(SENDABLE_STATUSES, limit);
  const ready: SendReadiness[] = [];
  const blocked: SendReadiness[] = [];
  for (const c of rows) {
    const r = assessSendReadiness(c);
    (r.ready ? ready : blocked).push(r);
  }
  return {
    ready,
    blocked,
    readyCount: ready.length,
    blockedCount: blocked.length,
    scanned: rows.length,
    candidateTotal,
    truncated: candidateTotal > rows.length,
  };
}
