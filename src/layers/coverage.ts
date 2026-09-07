import type { CompanyRow, FormSchema, FieldRole, DetectedField } from '../types.js';
import { SPLIT_TO_BASE } from '../types.js';
import { renderContent } from './l3_content.js';
import { shouldFillField, resolveFieldValue } from './fillPolicy.js';
import { logger } from '../utils/logger.js';

const log = logger('coverage');

/**
 * Shared field-by-field prediction of what L4 will type into each detected
 * control, and the resulting coverage summary. Used by BOTH the approval
 * dashboard (web/review) and the pipeline's eligibility gate, so "誤り疑い" /
 * "未入力の必須" are computed identically everywhere.
 */

export type FieldStatus =
  | 'ok' // mapped and a sensible value will be filled
  | 'suspect' // mapped, but the value looks wrong for this field
  | 'missing' // required, but nothing will be filled
  | 'auto' // required choice / split box filled at runtime (verify the pick)
  | 'optional' // not required (or optional非コア) — intentionally left blank
  | 'honeypot'; // hidden trap — deliberately never filled

export interface FieldReview {
  label: string;
  required: boolean;
  tag: string;
  type: string | null;
  role: FieldRole | null;
  value: string;
  status: FieldStatus;
  note: string;
  confidence: number | null;
}

export interface Coverage {
  requiredTotal: number;
  requiredFilled: number;
  missing: number;
  suspect: number;
  honeypots: number;
  /** Fields whose value exceeds the control's maxlength — silently truncated. */
  overflow: number;
  /** 本文以外の欄で入力上限を超えた数。除外の理由にはしない。 */
  otherOverflow: number;
}

export interface CoverageResult {
  fields: FieldReview[];
  coverage: Coverage;
  subject: string;
  body: string;
  /** Resolved per-role values L4 will type (post-override) — feeds the edit panel. */
  values: Partial<Record<FieldRole, string>>;
}

/**
 * Keywords expected for each (base) role, matched against the field's whole
 * haystack (label + name + id + autocomplete + placeholder) — not just the
 * label — so a 〒 box named "zip" under a shared "住所" label, or a 姓 box
 * id="name_1", is recognised. Split sub-roles fold to their base first.
 */
const ROLE_LABEL_HINTS: Partial<Record<FieldRole, RegExp>> = {
  company: /会社|企業|法人|団体|貴社|御社|組織|屋号|勤務先|事業所|store|company|corp|organization|office|kaisha/i,
  name: /名前|氏名|お名前|ご芳名|担当|ご担当|なまえ|氏|姓|名|sei|mei|name|lastname|firstname|family|given/i,
  kana: /フリガナ|ふりがな|カナ|かな|セイ|メイ|せい|めい|よみ|読み|kana|furigana|katakana|ruby|yomi/i,
  email: /メール|mail|e-?mail|アドレス|_mail|mailaddr/i,
  phone: /電話|TEL|tel|phone|携帯|連絡先|denwa|ﾃﾞﾝﾜ/i,
  postal: /郵便|〒|zip|postal|postcode|ゆうびん|yubin/i,
  address: /住所|所在地|address|addr|都道府県|市区町村|番地|ビル|建物|マンション|丁目|pref|city|street/i,
  department: /部署|部門|役職|所属|department|division|position/i,
  subject: /件名|題名|タイトル|用件|subject|title/i,
  message: /内容|本文|お問い?合わせ|問合|ご相談|相談|メッセージ|備考|詳細|質問|ご要望|message|comment|body|inquiry|question|quest|honbun/i,
};

function baseRole(role: FieldRole): FieldRole {
  return SPLIT_TO_BASE[role] ?? role;
}
function labelOf(f: DetectedField): string {
  return (f.labelText || f.placeholder || f.name || f.id || '').replace(/\s+/g, ' ').trim();
}
function fieldHay(f: DetectedField): string {
  return [f.labelText, f.name, f.id, f.placeholder, f.autocomplete].filter(Boolean).join(' ');
}

/** Does the field genuinely look like the role mapped onto it? Type signals win. */
function fieldMatchesRole(field: DetectedField, role: FieldRole): boolean {
  const base = baseRole(role);
  const t = (field.type || '').toLowerCase();
  if (base === 'email' && t === 'email') return true;
  if (base === 'phone' && t === 'tel') return true;
  const hint = ROLE_LABEL_HINTS[base];
  if (!hint) return true; // choice/agree/unknown — never flagged
  return hint.test(fieldHay(field));
}

function short(v: string, n = 90): string {
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function roleJp(role: FieldRole): string {
  const map: Partial<Record<FieldRole, string>> = {
    company: '会社名', name: '氏名', name_sei: '姓', name_mei: '名', kana: 'フリガナ',
    kana_sei: 'セイ', kana_mei: 'メイ',
    email: 'メール', email_confirm: 'メール(確認)', phone: '電話番号', postal: '郵便番号',
    address: '住所', address_pref: '都道府県', address_city: '市区町村',
    address_street: '番地・建物名', department: '部署', subject: '件名', message: '本文',
  };
  return map[role] ?? role;
}

export function computeCoverage(company: CompanyRow, schema: FormSchema): CoverageResult {
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

  // Labels mapped somewhere: an unmapped sibling sharing a mapped label is a
  // split/duplicate box L4 fills at runtime, not a true gap.
  const mappedLabels = new Set<string>();
  for (const m of schema.mappings) {
    const f = schema.fields.find((x) => x.selector === m.selector);
    if (f) mappedLabels.add(labelOf(f));
  }

  let overflow = 0;
  // 本文以外の欄の超過。送信を止める理由にはしないが、人が見て気づけるよう残す。
  let otherOverflow = 0;
  const fields: FieldReview[] = schema.fields.map((f) => {
    const label = labelOf(f);
    const m = schema.mappings.find((mm) => mm.selector === f.selector);
    const role = (m?.role ?? null) as FieldRole | null;
    const conf = m?.confidence ?? null;
    const base = { label, required: f.required, tag: f.tag, type: f.type, role, confidence: conf };

    if (f.honeypot) return { ...base, value: '（罠：入力しない）', status: 'honeypot', note: 'ハニーポット' };
    if (role === 'agree') return { ...base, value: '☑ 同意する', status: 'ok', note: '' };
    if (role === 'choice') {
      return { ...base, value: m?.value ?? '（実行時に自動選択）', status: 'auto', note: '自動選択（要確認）' };
    }

    // Resolve through the same helper L4 uses, so the preview shows the exact
    // string that will be typed (ふりがな→ひらがな変換, 携帯欄→携帯番号 を含む).
    const resolved = role ? resolveFieldValue(f, role, values) : undefined;
    if (role && resolved) {
      if (!shouldFillField(f, role)) {
        return { ...base, value: '—（任意・入力しない）', status: 'optional', note: '' };
      }
      const value = short(resolved);
      if (!fieldMatchesRole(f, role)) {
        return { ...base, value, status: 'suspect', note: `「${label}」に ${roleJp(role)} の値が入る可能性` };
      }
      // A maxlength shorter than the value means the browser silently truncates —
      // a half-sentence pitch reaching a real recipient. Flag it for a human.
      if (f.maxLength && resolved.length > f.maxLength) {
        // 上限を超えるのがどの欄かで意味がまるで違う。本文が切れれば署名が
        // 落ちて §9 に反するが、任意の付帯欄が切れても送信の価値は変わらない。
        // 以前はどの欄の超過も一律 overflow に数え、除外理由まで
        // 「本文が長すぎる」にしていたため、本文欄に上限すら無い企業が
        // その理由で捨てられていた（158 社中 102 社）。
        if (role === 'message') overflow++;
        else otherOverflow++;
        return {
          ...base,
          value,
          status: 'suspect',
          note: `入力上限 ${f.maxLength} 文字を超過（${resolved.length} 文字）— 途中で切れます`,
        };
      }
      return { ...base, value, status: 'ok', note: '' };
    }

    if (role && !resolved) {
      const status: FieldStatus = f.required ? 'missing' : 'optional';
      return { ...base, value: '（値なし）', status, note: f.required ? '必須だが値が未設定' : '' };
    }

    // Unmapped.
    const isChoiceLike = f.tag === 'select' || f.type === 'radio' || f.type === 'checkbox';
    if (!f.required) return { ...base, role: null, value: '—', status: 'optional', note: '' };
    if (isChoiceLike) {
      return { ...base, role: null, value: '（実行時に自動選択）', status: 'auto', note: '未マッピングの必須選択・自動選択される' };
    }
    if (mappedLabels.has(label)) {
      return { ...base, role: null, value: '（分割入力・自動）', status: 'auto', note: '同名欄の分割入力' };
    }
    return { ...base, role: null, value: '（未入力）', status: 'missing', note: '必須だが未マッピング＝空欄のまま' };
  });

  const nonTrap = fields.filter((f) => f.status !== 'honeypot');
  const requiredFields = nonTrap.filter((f) => f.required);
  const coverage: Coverage = {
    requiredTotal: requiredFields.length,
    requiredFilled: requiredFields.filter((f) => f.status === 'ok' || f.status === 'auto').length,
    missing: requiredFields.filter((f) => f.status === 'missing').length,
    suspect: nonTrap.filter((f) => f.status === 'suspect').length,
    honeypots: fields.length - nonTrap.length,
    overflow,
    otherOverflow,
  };

  return { fields, coverage, subject, body, values };
}
