import type { CompanyRow } from '../types.js';
import { companies, fieldMaps, submissions, suppression, audit } from '../db/repositories.js';
import { transition } from '../core/stateMachine.js';
import { discoverForm } from '../layers/l1_discovery.js';
import { parseForm } from '../layers/l2_parsing.js';
import { renderContent } from '../layers/l3_content.js';
import { computeCoverage } from '../layers/coverage.js';
import { classifyEligibility } from '../crosscutting/eligibility.js';
import { planSubmission, executeSubmission } from '../layers/l4_submit.js';
import { preSendCheck, markSent } from '../crosscutting/compliance.js';
import { canSendNow, recordSend } from '../crosscutting/pacing.js';
import { logger } from '../utils/logger.js';

const log = logger('pipeline');

/** Is this domain suppressed? If so, move the company to SUPPRESSED and skip. */
function suppressedGuard(company: CompanyRow): boolean {
  const hit = suppression.has(company.domain);
  if (!hit) return false;
  if (company.status !== 'SUPPRESSED') {
    transition(company.id, 'SUPPRESSED', { force: true, detail: `suppressed:${hit.reason}` });
  }
  return true;
}

/**
 * Stage A: discover the form (L1) then parse it (L2). Ends at PARSED or a
 * terminal FORM_NOT_FOUND / PARSE_FAILED, or SUPPRESSED (no-sales policy).
 */
export async function discoverAndParse(companyId: number): Promise<void> {
  let company = companies.byId(companyId)!;
  if (suppressedGuard(company)) return;

  // ---- L1 discovery ----
  if (['NEW'].includes(company.status)) {
    transition(company.id, 'DISCOVERING');
    const disc = await discoverForm(company.domain);
    if (!disc.formUrl) {
      transition(company.id, 'FORM_NOT_FOUND', { detail: 'no confirmed form' });
      audit.log({ companyId: company.id, layer: 'L1', action: 'form_not_found' });
      return;
    }
    companies.setForm(company.id, disc.formUrl, disc.confidence);
    transition(company.id, 'FORM_FOUND', { detail: `${disc.method} conf=${disc.confidence}` });
    company = companies.byId(companyId)!;
  }

  // ---- L2 parse ----
  if (company.status === 'FORM_FOUND') {
    transition(company.id, 'PARSING');
    try {
      const schema = await parseForm({
        formUrl: company.form_url!,
        formConfidence: company.form_confidence ?? 0.5,
      });

      // Compliance: no-sales policy -> suppress (spec §9).
      if (schema.noSalesPolicy) {
        suppression.add(company.domain, 'no_sales_policy');
        transition(company.id, 'SUPPRESSED', { force: true, detail: 'no_sales_policy' });
        audit.log({ companyId: company.id, layer: 'L2', action: 'suppress:no_sales_policy' });
        return;
      }

      fieldMaps.save(company.id, schema);
      transition(company.id, 'PARSED', {
        detail: `gate=${schema.gate} conf=${schema.mappingConfidence}`,
      });
    } catch (e) {
      transition(company.id, 'PARSE_FAILED', { detail: (e as Error).message });
      audit.log({ companyId: company.id, layer: 'L2', action: 'parse_failed', detail: (e as Error).message });
    }
  }
}

export interface BuildPlanOptions {
  /** When true, gate=high companies skip approval and go straight to SUBMITTING. */
  autoHighGate?: boolean;
  templateName?: string;
}

/**
 * Stage B: render content (L3) + dry-run plan (L4 Plan). Produces a submission
 * row in `plan_ready` and moves the company to PENDING_APPROVAL (half-auto) or
 * SUBMITTING (full-auto for high-gate, spec §5).
 */
export async function buildPlan(companyId: number, opts: BuildPlanOptions = {}): Promise<void> {
  const company = companies.byId(companyId)!;
  if (suppressedGuard(company)) return;
  if (company.status !== 'PARSED') {
    log.warn(`buildPlan skipped company=${companyId} status=${company.status} (need PARSED)`);
    return;
  }
  const schema = fieldMaps.latest(company.id);
  if (!schema) {
    log.warn(`buildPlan: no schema for company=${companyId}`);
    return;
  }

  // Eligibility gate (承認済みポリシー): non-B2B / CAPTCHA / un-fillable-required
  // forms are auto-excluded so the approval queue only holds sendable plans.
  const cov = computeCoverage(company, schema);
  const elig = classifyEligibility(schema, cov);
  if (!elig.eligible) {
    suppression.add(company.domain, 'ineligible_form');
    transition(company.id, 'SUPPRESSED', { force: true, detail: `ineligible:${elig.reason}${elig.detail ? `:${elig.detail}` : ''}` });
    audit.log({ companyId: company.id, layer: 'L4', action: `exclude:${elig.reason}`, detail: elig.detail });
    log.info(`excluded company=${companyId} reason=${elig.reason} ${elig.detail ?? ''}`);
    return;
  }

  transition(company.id, 'PLAN_READY');
  const content = renderContent(company, schema, { templateName: opts.templateName });
  const plan = await planSubmission(company, schema, content);

  submissions.createPlan({
    companyId: company.id,
    contentRendered: content.body,
    planScreenshotUrl: plan.screenshotPath,
  });
  audit.log({
    companyId: company.id,
    layer: 'L4',
    action: 'plan_ready',
    detail: { gate: schema.gate, strategy: plan.strategy, confirm: plan.reachedConfirmScreen },
  });

  // Gate routing (§5): high-gate + auto => direct to SUBMITTING; else approval.
  if (opts.autoHighGate && schema.gate === 'high') {
    transition(company.id, 'SUBMITTING', { actor: 'auto', detail: 'auto high-gate' });
  } else {
    transition(company.id, 'PENDING_APPROVAL');
  }
}

/**
 * Stage C: Execute a final submission (L4 Execute + L5 judge). Requires the
 * company to be APPROVED (half-auto) or SUBMITTING (full-auto). Enforces the
 * pre-send compliance and pacing gates.
 */
export async function runExecute(companyId: number): Promise<void> {
  const company = companies.byId(companyId)!;
  if (suppressedGuard(company)) return;
  if (!['APPROVED', 'SUBMITTING'].includes(company.status)) {
    log.warn(`runExecute skipped company=${companyId} status=${company.status}`);
    return;
  }

  // Pre-send compliance (already_sent / opt_out / competitor / policy) — §9.
  const compliance = preSendCheck(company.domain);
  if (!compliance.allowed) {
    transition(company.id, 'SUPPRESSED', { force: true, detail: compliance.detail });
    return;
  }
  // Pacing (daily cap + send window) — §4-L4 / §9.
  const pace = canSendNow();
  if (!pace.allowed) {
    log.warn(`pacing blocked company=${companyId}: ${pace.reason}`);
    audit.log({ companyId: company.id, layer: 'L4', action: 'pacing_blocked', detail: pace.reason });
    return; // stays APPROVED/SUBMITTING; retried on next run inside the window
  }

  const schema = fieldMaps.latest(company.id)!;
  const content = renderContent(company, schema);
  if (company.status === 'APPROVED') transition(company.id, 'SUBMITTING');

  const sub = submissions.latestForCompany(company.id);
  try {
    const { judgment } = await executeSubmission(company, schema, content);
    submissions.setResult(sub.id, judgment.status, judgment.detail);
    recordSend(company.id);

    switch (judgment.status) {
      case 'submitted_success':
        markSent(company.domain); // never contact twice (§9)
        transition(company.id, 'SUBMITTED_SUCCESS', { detail: judgment.detail });
        break;
      case 'failed':
        transition(company.id, 'SUBMITTED_FAILED', { detail: judgment.detail });
        break;
      case 'captcha':
        transition(company.id, 'CAPTCHA_BLOCKED', { detail: judgment.detail });
        break;
      default:
        transition(company.id, 'NEEDS_REVIEW', { detail: judgment.detail });
    }
  } catch (e) {
    submissions.setResult(sub.id, 'needs_review', (e as Error).message);
    transition(company.id, 'NEEDS_REVIEW', { detail: (e as Error).message });
  }
}
