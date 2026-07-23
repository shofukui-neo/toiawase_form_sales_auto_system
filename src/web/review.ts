import type { CompanyRow, FieldRole, FormSchema } from '../types.js';
import { SPLIT_TO_BASE } from '../types.js';
import { computeCoverage, type FieldReview, type Coverage } from '../layers/coverage.js';
import { classifyEligibility, type Eligibility } from '../crosscutting/eligibility.js';
import { contentOverrides } from '../db/repositories.js';

export type { FieldReview, Coverage } from '../layers/coverage.js';

/** A manually-editable send value surfaced in the dashboard edit panel. */
export interface EditableField {
  role: FieldRole;
  label: string;
  value: string;
  multiline: boolean;
}

/** Roles the dashboard lets a human edit, in display order. */
const EDITABLE_ROLES: { role: FieldRole; label: string; multiline?: boolean }[] = [
  { role: 'company', label: '会社名' },
  { role: 'name', label: '担当者名（氏名）' },
  { role: 'kana', label: 'フリガナ' },
  { role: 'email', label: 'メールアドレス' },
  { role: 'phone', label: '電話番号' },
  { role: 'postal', label: '郵便番号' },
  { role: 'address', label: '住所' },
  { role: 'department', label: '部署・役職' },
  { role: 'subject', label: '件名' },
  { role: 'message', label: '本文', multiline: true },
];

/** Always shown even when the form doesn't map them; the rest appear only when used. */
const ALWAYS_EDITABLE = new Set<FieldRole>(['company', 'name', 'email', 'phone', 'subject', 'message']);

function buildEditable(
  schema: FormSchema,
  values: Partial<Record<FieldRole, string>>,
  subject: string,
  body: string,
): EditableField[] {
  const usedBase = new Set<FieldRole>();
  for (const m of schema.mappings) usedBase.add(SPLIT_TO_BASE[m.role] ?? m.role);
  return EDITABLE_ROLES.filter((e) => ALWAYS_EDITABLE.has(e.role) || usedBase.has(e.role)).map((e) => {
    const value =
      e.role === 'subject' ? values.subject ?? subject
      : e.role === 'message' ? values.message ?? body
      : values[e.role] ?? '';
    return { role: e.role, label: e.label, value, multiline: !!e.multiline };
  });
}

/**
 * Approval-dashboard review model. Thin wrapper over the shared coverage
 * predictor (src/layers/coverage.ts) — the same logic the pipeline uses to
 * decide eligibility — plus the presentation fields (screenshot / meta) and the
 * eligibility verdict.
 */
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
  /** Whether this form belongs in the sales queue at all (else auto-excluded). */
  eligibility: Eligibility;
  /** Human-editable send values (post-override) for the dashboard edit panel. */
  editable: EditableField[];
  /** True when a manual override is stored for this company. */
  edited: boolean;
}

export function buildReview(
  company: CompanyRow,
  schema: FormSchema,
  submission: { id?: number; plan_screenshot_url?: string | null } | undefined,
): PendingReview {
  const cov = computeCoverage(company, schema);
  const { fields, coverage, subject, body, values } = cov;
  const eligibility = classifyEligibility(schema, cov);
  const editable = buildEditable(schema, values, subject, body);
  const edited = !!contentOverrides.get(company.id);
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
    eligibility,
    editable,
    edited,
  };
}
