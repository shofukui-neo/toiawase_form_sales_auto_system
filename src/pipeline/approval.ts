import { companies, submissions, suppression, fieldMaps } from '../db/repositories.js';
import { transition } from '../core/stateMachine.js';
import type { SuppressionReason } from '../types.js';

/**
 * Approval gate (spec §4-L4, §5). In half-auto mode a human reviews each Plan.
 * This is the minimal CLI-backed approval surface; a GAS WebApp / React
 * dashboard (§13-2) would sit on top of these same operations.
 */

export interface PendingItem {
  companyId: number;
  name: string;
  domain: string;
  formUrl: string | null;
  gate: string;
  mappingConfidence: number;
  screenshot: string | null;
  renderedBody: string | null;
  submissionId: number | null;
}

export function listPending(limit = 100): PendingItem[] {
  return companies.byStatus('PENDING_APPROVAL', limit).map((c) => {
    const sub = submissions.latestForCompany(c.id);
    const schema = fieldMaps.latest(c.id);
    return {
      companyId: c.id,
      name: c.name,
      domain: c.domain,
      formUrl: c.form_url,
      gate: schema?.gate ?? 'unknown',
      mappingConfidence: schema?.mappingConfidence ?? 0,
      screenshot: sub?.plan_screenshot_url ?? null,
      renderedBody: sub?.content_rendered ?? null,
      submissionId: sub?.id ?? null,
    };
  });
}

export interface ApprovedItem {
  companyId: number;
  name: string;
  domain: string;
  gate: string;
  approvedBy: string | null;
}

/** Companies approved and waiting to be sent (or mid-send). */
export function listApproved(limit = 100): ApprovedItem[] {
  return [...companies.byStatus('APPROVED', limit), ...companies.byStatus('SUBMITTING', limit)].map((c) => {
    const sub = submissions.latestForCompany(c.id);
    const schema = fieldMaps.latest(c.id);
    return {
      companyId: c.id,
      name: c.name,
      domain: c.domain,
      gate: schema?.gate ?? 'unknown',
      approvedBy: sub?.approved_by ?? null,
    };
  });
}

export function approve(companyId: number, approver: string): void {
  const company = companies.byId(companyId);
  if (!company) throw new Error(`company ${companyId} not found`);
  if (company.status !== 'PENDING_APPROVAL') {
    throw new Error(`company ${companyId} is ${company.status}, not PENDING_APPROVAL`);
  }
  const sub = submissions.latestForCompany(companyId);
  if (sub) submissions.approve(sub.id, approver);
  transition(companyId, 'APPROVED', { actor: approver, detail: 'human approved plan' });
}

export function reject(companyId: number, approver: string, note = ''): void {
  const company = companies.byId(companyId);
  if (!company) throw new Error(`company ${companyId} not found`);
  transition(companyId, 'REJECTED', { actor: approver, detail: note || 'human rejected plan' });
}

export function suppressCompany(companyId: number, reason: SuppressionReason, approver: string): void {
  const company = companies.byId(companyId);
  if (!company) throw new Error(`company ${companyId} not found`);
  suppression.add(company.domain, reason);
  transition(companyId, 'SUPPRESSED', { force: true, actor: approver, detail: `manual:${reason}` });
}
