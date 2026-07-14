import type { FormSchema, DetectedField } from '../types.js';
import type { CoverageResult } from '../layers/coverage.js';

/**
 * Form eligibility gate (承認済みポリシー: 非適格フォームは自動除外).
 *
 * A form is only worth queuing for approval when it is a genuine B2B sales
 * contact form we can fill **truthfully**. We exclude, without ever fabricating
 * data, anything that:
 *   - requires solving a CAPTCHA (can't get past it),
 *   - declares a no-sales policy (§9 compliance),
 *   - is a consumer / non-B2B inquiry form (介護相談・施設見学・来場予約 等),
 *   - or still has a required field we cannot truthfully fill after mapping.
 *
 * Excluded forms are moved out of the approval queue (see pipeline / sweep), so
 * the reviewer only ever sees sendable, correctly-filled plans.
 */

export type IneligibleReason =
  | 'captcha'
  | 'no_sales_policy'
  | 'consumer_form'
  | 'unfillable_required'
  | 'not_contactable';

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  detail?: string;
}

/**
 * Consumer / non-B2B signals. These appear on care-recipient, facility-visit,
 * and personal-service forms — never on a B2B logistics/manufacturing/SaaS
 * sales contact form. A single required-or-visible hit marks the form consumer.
 */
const CONSUMER_RE =
  /要介護|要支援|介護度|介護認定|ケアプラン|ご利用者|利用者様|被保険者|相談者|続柄|ご家族|保護者|生年月日|性別|見学|来場|来店|体験|入居|入園|入学|診察|受診|予約日|希望日|お子様|園児|里帰り/;

function labelHay(f: DetectedField): string {
  return [f.labelText, f.placeholder, f.name, f.id].filter(Boolean).join(' ');
}

/**
 * Classify a parsed form for sendability. `cov` is the shared coverage result
 * (same prediction the dashboard shows), so "un-fillable" / "contactable" are
 * decided from exactly what L4 will type.
 */
export function classifyEligibility(schema: FormSchema, cov: CoverageResult): Eligibility {
  if (schema.hasCaptcha && schema.hasCaptcha !== 'none') {
    return { eligible: false, reason: 'captcha', detail: schema.hasCaptcha };
  }
  if (schema.noSalesPolicy) {
    return { eligible: false, reason: 'no_sales_policy' };
  }

  // Consumer / non-B2B: scan every non-honeypot field's text for care/visit signals.
  const consumerHit = schema.fields
    .filter((f) => !f.honeypot)
    .map(labelHay)
    .find((h) => CONSUMER_RE.test(h));
  if (consumerHit) {
    return { eligible: false, reason: 'consumer_form', detail: consumerHit.replace(/\s+/g, ' ').slice(0, 40) };
  }

  // A required field we cannot truthfully fill remains after mapping+auto-choice.
  if (cov.coverage.missing > 0) {
    return { eligible: false, reason: 'unfillable_required', detail: `${cov.coverage.missing} 件` };
  }

  // Nowhere to put the sales pitch: neither a message body nor a company field
  // will be filled — the form can't carry a meaningful B2B inquiry.
  const willFill = (role: string) => cov.fields.some((f) => f.role === role && (f.status === 'ok' || f.status === 'auto'));
  if (!willFill('message') && !willFill('company')) {
    return { eligible: false, reason: 'not_contactable', detail: '本文/会社名の入力先なし' };
  }

  return { eligible: true };
}
