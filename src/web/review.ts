import type { CompanyRow, FormSchema, FieldRole, DetectedField } from '../types.js';
import { renderContent } from '../layers/l3_content.js';
import { logger } from '../utils/logger.js';

const log = logger('review');

/**
 * Field-by-field review model for the approval dashboard. The reviewer's core
 * question is: "for the fields this form actually asks for, is the right value
 * going into each blank?" So for every detected control we resolve the value
 * L4 will type (reconstructed deterministically via L3) and classify it, with
 * a light label↔role sanity check that flags likely mis-mappings.
 */

export type FieldStatus =
  | 'ok' // mapped and a sensible value will be filled
  | 'suspect' // mapped, but the value looks wrong for this field's label
  | 'missing' // required, but nothing will be filled
  | 'auto' // required choice / split box filled at runtime (verify the pick)
  | 'optional' // not required, intentionally left blank
  | 'honeypot'; // hidden trap — deliberately never filled

export interface FieldReview {
  label: string;
  required: boolean;
  tag: string;
  type: string | null;
  role: FieldRole | null;
  value: string; // what will be typed (display form)
  status: FieldStatus;
  note: string; // short human explanation, esp. for suspect/auto/missing
  confidence: number | null;
}

export interface Coverage {
  requiredTotal: number;
  requiredFilled: number; // ok + auto among required
  missing: number; // required with nothing to fill
  suspect: number; // likely mis-mapping (any field)
  honeypots: number;
}

export interface PendingReview {
  companyId: number;
  name: string;
  domain: string;
  formUrl: string | null;
  gate: string;
  mappingConfidence: number;
  hasConfirmScreen: boolean;
  hasCaptcha: string;
  screenshot: string | null;
  subject: string;
  body: string;
  submissionId: number | null;
  fields: FieldReview[];
  coverage: Coverage;
}

/** Keywords we expect in a field's label for each role. Used to spot mis-maps. */
const ROLE_LABEL_HINTS: Partial<Record<FieldRole, RegExp>> = {
  company: /会社|企業|法人|団体|貴社|御社|組織|屋号|勤務先|store|company|organization/i,
  name: /名前|氏名|お名前|担当|ご担当|name/i,
  name_sei: /姓|苗字|名字|せい|sei|last|family/i,
  name_mei: /名|めい|mei|first|given/i,
  kana: /フリガナ|ふりがな|カナ|かな|セイ|メイ|よみ|読み|kana|furigana/i,
  kana_sei: /セイ|せい|フリガナ|ふりがな/i,
  kana_mei: /メイ|めい|フリガナ|ふりがな/i,
  email: /メール|mail|e-?mail|アドレス/i,
  email_confirm: /メール|mail|アドレス|確認|再入力|confirm/i,
  phone: /電話|TEL|tel|phone|携帯|連絡先/i,
  postal: /郵便|〒|zip|postal|ゆうびん/i,
  address: /住所|所在地|address|都道府県|市区町村|番地|ビル|建物|丁目/i,
  department: /部署|部門|役職|所属|department|division/i,
  subject: /件名|題名|タイトル|用件|subject|title/i,
  message: /内容|本文|お問い?合わせ|ご相談|相談|メッセージ|備考|詳細|質問|ご要望|message|comment|body|inquiry/i,
};

/** Roles that may legitimately be split across sibling boxes with a shared label. */
const SPLIT_BASE = /^(phone|postal|name|kana)/;

function labelOf(f: DetectedField): string {
  return (f.labelText || f.placeholder || f.name || f.id || '').replace(/\s+/g, ' ').trim();
}

/** Does the field's label look consistent with the role we mapped onto it? */
function labelMatchesRole(label: string, role: FieldRole): boolean {
  const hint = ROLE_LABEL_HINTS[role];
  if (!hint) return true; // roles without a hint (choice/agree/unknown) never flagged
  return hint.test(label);
}

/** Truncate a value for table display (full text is available on the message body panel). */
function short(v: string, n = 90): string {
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function buildReview(
  company: CompanyRow,
  schema: FormSchema,
  submission: { id?: number; plan_screenshot_url?: string | null } | undefined,
): PendingReview {
  let values: Partial<Record<FieldRole, string>> = {};
  let subject = '';
  let body = '';
  try {
    const content = renderContent(company, schema);
    values = content.values;
    subject = content.subject;
    body = content.body;
  } catch (e) {
    log.warn(`renderContent failed for #${company.id}: ${(e as Error).message}`);
  }

  // Labels that ARE mapped somewhere — lets us treat an unmapped sibling sharing
  // that label as a split/duplicate that L4 fills at runtime, not a true gap.
  const mappedLabels = new Set<string>();
  for (const m of schema.mappings) {
    const f = schema.fields.find((x) => x.selector === m.selector);
    if (f) mappedLabels.add(labelOf(f));
  }

  const fields: FieldReview[] = schema.fields.map((f) => {
    const label = labelOf(f);
    const m = schema.mappings.find((mm) => mm.selector === f.selector);
    const role = (m?.role ?? null) as FieldRole | null;
    const conf = m?.confidence ?? null;

    // Honeypot: intentionally skipped.
    if (f.honeypot) {
      return { label, required: f.required, tag: f.tag, type: f.type, role, value: '（罠：入力しない）', status: 'honeypot', note: 'ハニーポット', confidence: conf };
    }

    // Consent checkbox.
    if (role === 'agree') {
      return { label, required: f.required, tag: f.tag, type: f.type, role, value: '☑ 同意する', status: 'ok', note: '', confidence: conf };
    }

    // Auto-selected required choice (select / radio) resolved at parse time.
    if (role === 'choice') {
      const v = m?.value ?? '（実行時に自動選択）';
      return { label, required: f.required, tag: f.tag, type: f.type, role, value: v, status: 'auto', note: '自動選択（要確認）', confidence: conf };
    }

    // Mapped identity/text role with a rendered value.
    if (role && values[role]) {
      const value = short(values[role]!);
      if (!labelMatchesRole(label, role)) {
        return { label, required: f.required, tag: f.tag, type: f.type, role, value, status: 'suspect', note: `「${label}」に ${roleJp(role)} の値が入る可能性`, confidence: conf };
      }
      return { label, required: f.required, tag: f.tag, type: f.type, role, value, status: 'ok', note: '', confidence: conf };
    }

    // Mapped but no value available.
    if (role && !values[role]) {
      const status: FieldStatus = f.required ? 'missing' : 'optional';
      return { label, required: f.required, tag: f.tag, type: f.type, role, value: '（値なし）', status, note: f.required ? '必須だが値が未設定' : '', confidence: conf };
    }

    // Unmapped. Distinguish split/duplicate siblings from genuine gaps.
    const isChoiceLike = f.tag === 'select' || f.type === 'radio' || f.type === 'checkbox';
    if (!f.required) {
      return { label, required: false, tag: f.tag, type: f.type, role: null, value: '—', status: 'optional', note: '', confidence: null };
    }
    if (isChoiceLike) {
      return { label, required: true, tag: f.tag, type: f.type, role: null, value: '（実行時に自動選択）', status: 'auto', note: '未マッピングの必須選択・自動選択される', confidence: null };
    }
    // Required text input sharing a label with a mapped field => split box, filled at runtime.
    if (mappedLabels.has(label)) {
      return { label, required: true, tag: f.tag, type: f.type, role: null, value: '（分割入力・自動）', status: 'auto', note: '同名欄の分割入力', confidence: null };
    }
    return { label, required: true, tag: f.tag, type: f.type, role: null, value: '（未入力）', status: 'missing', note: '必須だが未マッピング＝空欄のまま', confidence: null };
  });

  const nonTrap = fields.filter((f) => f.status !== 'honeypot');
  const requiredFields = nonTrap.filter((f) => f.required);
  const coverage: Coverage = {
    requiredTotal: requiredFields.length,
    requiredFilled: requiredFields.filter((f) => f.status === 'ok' || f.status === 'auto').length,
    missing: requiredFields.filter((f) => f.status === 'missing').length,
    suspect: nonTrap.filter((f) => f.status === 'suspect').length,
    honeypots: fields.length - nonTrap.length,
  };

  return {
    companyId: company.id,
    name: company.name,
    domain: company.domain,
    formUrl: company.form_url,
    gate: schema.gate,
    mappingConfidence: schema.mappingConfidence,
    hasConfirmScreen: schema.hasConfirmScreen,
    hasCaptcha: schema.hasCaptcha,
    screenshot: submission?.plan_screenshot_url ?? null,
    subject,
    body,
    submissionId: submission?.id ?? null,
    fields,
    coverage,
  };
}

/** Human role name for notes. */
function roleJp(role: FieldRole): string {
  const map: Partial<Record<FieldRole, string>> = {
    company: '会社名', name: '氏名', name_sei: '姓', name_mei: '名', kana: 'フリガナ',
    email: 'メール', email_confirm: 'メール(確認)', phone: '電話番号', postal: '郵便番号',
    address: '住所', department: '部署', subject: '件名', message: '本文',
  };
  return map[role] ?? role;
}
