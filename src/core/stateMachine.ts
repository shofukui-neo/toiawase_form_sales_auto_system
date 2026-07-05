import type { CompanyStatus } from '../types.js';
import { companies, audit } from '../db/repositories.js';
import { logger } from '../utils/logger.js';

const log = logger('state');

/** Allowed transitions (spec §7). Guards illegal jumps and records every move. */
const TRANSITIONS: Record<CompanyStatus, CompanyStatus[]> = {
  NEW: ['DISCOVERING', 'SUPPRESSED'],
  DISCOVERING: ['FORM_FOUND', 'FORM_NOT_FOUND', 'SUPPRESSED'],
  FORM_FOUND: ['PARSING', 'SUPPRESSED'],
  FORM_NOT_FOUND: [], // terminal
  PARSING: ['PARSED', 'PARSE_FAILED', 'SUPPRESSED'],
  PARSED: ['PLAN_READY', 'SUPPRESSED'],
  PARSE_FAILED: ['PARSING'], // may re-investigate
  PLAN_READY: ['PENDING_APPROVAL', 'SUBMITTING', 'SUPPRESSED'], // SUBMITTING = full-auto direct
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'SUPPRESSED'],
  APPROVED: ['SUBMITTING', 'SUPPRESSED'],
  REJECTED: ['PLAN_READY'], // re-plan after fixes
  SUBMITTING: ['SUBMITTED_SUCCESS', 'SUBMITTED_FAILED', 'CAPTCHA_BLOCKED', 'NEEDS_REVIEW'],
  SUBMITTED_SUCCESS: ['REPLIED'],
  SUBMITTED_FAILED: ['SUBMITTING', 'NEEDS_REVIEW'],
  CAPTCHA_BLOCKED: ['NEEDS_REVIEW'], // manual send queue
  NEEDS_REVIEW: ['PLAN_READY', 'SUBMITTING', 'SUPPRESSED'],
  REPLIED: [],
  SUPPRESSED: [],
};

export function canTransition(from: CompanyStatus, to: CompanyStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Move a company to a new status. `force` bypasses the transition guard
 * (used for suppression hits which can fire from any state).
 */
export function transition(
  companyId: number,
  to: CompanyStatus,
  opts: { actor?: string; detail?: string | object; force?: boolean } = {},
): void {
  const company = companies.byId(companyId);
  if (!company) throw new Error(`transition: company ${companyId} not found`);
  const from = company.status;
  if (from === to) return;
  if (!opts.force && !canTransition(from, to)) {
    throw new Error(`Illegal transition ${from} -> ${to} for company ${companyId}`);
  }
  companies.setStatus(companyId, to);
  audit.log({
    companyId,
    layer: 'state',
    action: `transition:${from}->${to}`,
    actor: opts.actor ?? 'system',
    detail: opts.detail,
  });
  log.debug(`company ${companyId}: ${from} -> ${to}`);
}
