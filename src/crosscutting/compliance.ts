import { suppression } from '../db/repositories.js';
import type { SuppressionReason } from '../types.js';

/**
 * Compliance = brand protection (spec §9). This module centralizes the
 * "should we even touch this form" gates that run before any send.
 */

/**
 * Text patterns that indicate the form owner does not want sales contact.
 * Detected in L2 from the page body / form notes -> hard suppression.
 * Default policy (spec §13-3, recommended): honor these and skip.
 */
const NO_SALES_PATTERNS: RegExp[] = [
  /営業(目的|の|は|お断り|ご遠慮|禁止|お断わり)/,
  /セールス(お断り|ご遠慮|禁止)/,
  /勧誘(お断り|ご遠慮|禁止)/,
  /営業.{0,6}(メール|電話|連絡).{0,6}(お断り|ご遠慮|禁止|不要)/,
  /(sales|solicitation)\s+(inquir|email|contact).{0,20}(not|no)/i,
  /no\s+(sales|solicitation)/i,
];

/** Returns the matched phrase if the text signals a no-sales policy, else null. */
export function detectNoSalesPolicy(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ');
  for (const re of NO_SALES_PATTERNS) {
    const m = normalized.match(re);
    if (m) return m[0];
  }
  return null;
}

export interface ComplianceDecision {
  allowed: boolean;
  reason?: SuppressionReason;
  detail?: string;
}

/**
 * Pre-send gate. Consults the suppression list. Multi-send prevention
 * (already_sent), opt-outs, competitor and no-sales-policy all live here.
 */
export function preSendCheck(domain: string): ComplianceDecision {
  const hit = suppression.has(domain);
  if (hit) {
    return { allowed: false, reason: hit.reason as SuppressionReason, detail: `suppressed:${hit.reason}` };
  }
  return { allowed: true };
}

/** Mark a domain as sent so it is never contacted twice (§9 multi-send prevention). */
export function markSent(domain: string): void {
  suppression.add(domain, 'already_sent');
}
