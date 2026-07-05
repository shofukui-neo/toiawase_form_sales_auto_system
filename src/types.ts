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
  | 'name' // 氏名
  | 'kana' // フリガナ
  | 'email' // メール
  | 'phone' // 電話
  | 'department' // 部署/役職
  | 'subject' // 件名
  | 'message' // 本文
  | 'agree' // 同意 (checkbox)
  | 'unknown';

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
