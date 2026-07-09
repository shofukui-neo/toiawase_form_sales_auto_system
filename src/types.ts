/**
 * Shared domain types. Mirrors the data model in spec §6 and the state machine §7.
 */

/** companies.status — state machine (§7). */
export type CompanyStatus =
  | 'NEW'
  | 'DISCOVERING'
  | 'FORM_FOUND'
  | 'FORM_NOT_FOUND' // terminal (excluded)
  | 'PARSING'
  | 'PARSED'
  | 'PARSE_FAILED' // terminal / needs investigation
  | 'PLAN_READY'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUBMITTING'
  | 'SUBMITTED_SUCCESS' // terminal
  | 'SUBMITTED_FAILED'
  | 'CAPTCHA_BLOCKED' // -> manual queue
  | 'NEEDS_REVIEW'
  | 'REPLIED' // P3
  | 'SUPPRESSED'; // terminal

/** Canonical field roles L2 maps form inputs onto (spec §4-L2 ①). */
export type FieldRole =
  | 'company' // 会社名
  | 'name' // 氏名（姓名が1欄）
  | 'name_sei' // 姓（氏名分割）
  | 'name_mei' // 名（氏名分割）
  | 'kana' // フリガナ（1欄）
  | 'kana_sei' // フリガナ 姓
  | 'kana_mei' // フリガナ 名
  | 'email' // メール
  | 'email_confirm' // メール（確認再入力）
  | 'phone' // 電話（1欄）
  | 'phone1' // 電話 市外局番（分割1）
  | 'phone2' // 電話 市内局番（分割2）
  | 'phone3' // 電話 加入者番号（分割3）
  | 'postal' // 郵便番号（1欄）
  | 'postal1' // 郵便番号（分割1・上3桁）
  | 'postal2' // 郵便番号（分割2・下4桁）
  | 'department' // 部署/役職
  | 'subject' // 件名
  | 'message' // 本文
  | 'agree' // 同意 (checkbox)
  | 'choice' // 必須の select / radio（種別など）を自動選択 (課題C)
  | 'unknown';

/**
 * Sub-roles that are fragments of a single logical field split across multiple
 * inputs (spec §4-L2, 課題A). Each maps to its "base" role for gate/coverage.
 */
export const SPLIT_TO_BASE: Partial<Record<FieldRole, FieldRole>> = {
  name_sei: 'name',
  name_mei: 'name',
  kana_sei: 'kana',
  kana_mei: 'kana',
  phone1: 'phone',
  phone2: 'phone',
  phone3: 'phone',
  postal1: 'postal',
  postal2: 'postal',
  email_confirm: 'email',
};

export type CaptchaKind = 'none' | 'v2' | 'v3';

/** Confidence gate (spec §5). */
export type Gate = 'high' | 'mid' | 'low' | 'block';

export type SuppressionReason =
  | 'already_sent'
  | 'opt_out'
  | 'no_sales_policy'
  | 'competitor';

/** A single form control detected on the page. */
export interface DetectedField {
  /** Stable CSS selector used to locate the control in the Execute phase. */
  selector: string;
  tag: 'input' | 'textarea' | 'select';
  type: string | null; // input type / null for textarea
  name: string | null;
  id: string | null;
  labelText: string | null; // associated <label>, aria-label, or nearby text
  placeholder: string | null;
  required: boolean;
  /** True when the field is visually hidden — a honeypot (spec §4-L2 ④). Never fill. */
  honeypot: boolean;
  /** maxlength attribute (null if unset). Strong split-field signal (§4-L2 課題A). */
  maxLength: number | null;
  /** autocomplete token, e.g. "tel-area-code" / "postal-code" (null if unset). */
  autocomplete: string | null;
  options?: string[]; // for <select>
}

/** L2 output: mapping of a role to the selector chosen to satisfy it. */
export interface FieldMapping {
  role: FieldRole;
  selector: string;
  /** 0..1 confidence this control really plays this role. */
  confidence: number;
  /** 'rule' | 'structure' | 'llm' — provenance for auditing. */
  source: 'rule' | 'structure' | 'llm';
  /**
   * Pre-resolved value chosen at parse time (role='choice' select/radio, where
   * the value is a form-specific option label, not a sender-identity string).
   * L4 uses this instead of the L3 rendered values map.
   */
  value?: string;
}

/** Full parse result for a form (persisted to field_maps). */
export interface FormSchema {
  formUrl: string;
  formSelector: string; // selector for the <form> element
  fields: DetectedField[];
  mappings: FieldMapping[];
  hasConfirmScreen: boolean;
  hasCaptcha: CaptchaKind;
  hasHoneypot: boolean;
  /** "営業お断り" etc. detected -> compliance suppression (§9). */
  noSalesPolicy: boolean;
  /**
   * True when a required select/radio was auto-filled by an uncertain fallback,
   * or a required radio group could not be confidently chosen (課題C). Caps the
   * gate below 'high' so a human reviews the choice before any auto-send.
   */
  ambiguousChoice: boolean;
  mappingConfidence: number; // aggregate 0..1
  gate: Gate;
}

/** Rendered outbound content (L3). */
export interface RenderedContent {
  subject: string;
  body: string;
  /** Value per role that L4 will type into the mapped selector. */
  values: Partial<Record<FieldRole, string>>;
}

export type SubmissionStatus =
  | 'plan_ready'
  | 'submitted_success'
  | 'failed'
  | 'captcha'
  | 'needs_review';

export interface CompanyRow {
  id: number;
  name: string;
  domain: string;
  icp_score: number | null;
  source: string | null;
  status: CompanyStatus;
  form_url: string | null;
  form_confidence: number | null;
  created_at: string;
  updated_at: string;
}
