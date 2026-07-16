import type { CompanyRow, FormSchema } from '../types.js';
import { computeCoverage, type FieldReview, type Coverage } from '../layers/coverage.js';
import { classifyEligibility, type Eligibility } from '../crosscutting/eligibility.js';

export type { FieldReview, Coverage } from '../layers/coverage.js';

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
}

export function buildReview(
  company: CompanyRow,
  schema: FormSchema,
  submission: { id?: number; plan_screenshot_url?: string | null } | undefined,
): PendingReview {
  const cov = computeCoverage(company, schema);
  const { fields, coverage, subject, body } = cov;
  const eligibility = classifyEligibility(schema, cov);
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
  };
}
