import type { FormSchema, Gate, FieldRole } from '../types.js';

/**
 * Confidence gate model (spec §5).
 *
 * Composite confidence = form-discovery conf (carried on schema via caller)
 *   × mapping conf (required roles filled with high certainty)
 *   × anti-bot risk (CAPTCHA / honeypot / policy).
 *
 * The gate decides the half-auto/full-auto handling of each send:
 *   G-block : hard blocker (CAPTCHA / honeypot risk / no-sales policy) -> manual queue
 *   G-high  : all required roles mapped with high certainty, no CAPTCHA, canonical form
 *   G-mid   : some ambiguity
 *   G-low   : low mapping confidence / irregular form
 */

/** Roles a legitimate contact form must have for us to safely auto-submit. */
const REQUIRED_ROLES: FieldRole[] = ['company', 'name', 'email', 'message'];

export interface GateInput {
  formConfidence: number; // L1 discovery confidence 0..1
  schema: FormSchema;
}

export interface GateResult {
  gate: Gate;
  mappingConfidence: number; // aggregate 0..1
  reasons: string[];
}

export function computeGate(input: GateInput): GateResult {
  const { schema, formConfidence } = input;
  const reasons: string[] = [];

  // Aggregate mapping confidence over the roles we actually rely on.
  const byRole = new Map<FieldRole, number>();
  for (const m of schema.mappings) {
    // keep the highest-confidence mapping per role
    byRole.set(m.role, Math.max(byRole.get(m.role) ?? 0, m.confidence));
  }

  // Fold split sub-roles into their base role so required-role checks see a
  // satisfied name/phone/kana/postal when the form splits them (課題A). A split
  // role only counts when BOTH halves are mapped.
  const pair = (a: FieldRole, b: FieldRole): number | undefined => {
    const ca = byRole.get(a);
    const cb = byRole.get(b);
    return ca !== undefined && cb !== undefined ? Math.min(ca, cb) : undefined;
  };
  const foldBase = (base: FieldRole, conf: number | undefined) => {
    if (conf !== undefined && !byRole.has(base)) byRole.set(base, conf);
  };
  foldBase('name', pair('name_sei', 'name_mei'));
  foldBase('kana', pair('kana_sei', 'kana_mei'));
  foldBase('postal', pair('postal1', 'postal2'));
  foldBase('phone', pair('phone1', 'phone2')); // 2- or 3-part share phone1/phone2

  const requiredConfs = REQUIRED_ROLES.map((r) => byRole.get(r) ?? 0);
  const missingRequired = REQUIRED_ROLES.filter((r) => (byRole.get(r) ?? 0) === 0);
  const minRequiredConf = Math.min(...requiredConfs);
  const avgRequiredConf =
    requiredConfs.reduce((a, b) => a + b, 0) / REQUIRED_ROLES.length;

  const mappingConfidence = Number((avgRequiredConf * formConfidence).toFixed(3));

  // ---- Hard blockers -> G-block ----
  // NOTE: honeypot *presence* is NOT a blocker — L2 detects and never fills it
  // (§4-L2 ④), so a legitimate form's honeypot is neutralized, not risky. Only
  // things we cannot safely get past (CAPTCHA) or must not send to (no-sales
  // policy) force the manual queue.
  const blockers: string[] = [];
  if (schema.hasCaptcha !== 'none') blockers.push(`captcha:${schema.hasCaptcha}`);
  if (schema.noSalesPolicy) blockers.push('no-sales-policy');
  if (schema.hasHoneypot) reasons.push('honeypot-present-neutralized');
  if (blockers.length > 0) {
    return { gate: 'block', mappingConfidence, reasons: [...blockers, ...reasons] };
  }

  // ---- Missing a required role we can't fabricate -> low ----
  if (missingRequired.length > 0) {
    reasons.push(`missing-required:${missingRequired.join(',')}`);
    return { gate: 'low', mappingConfidence, reasons };
  }

  // ---- Tiered on confidence ----
  if (minRequiredConf >= 0.85 && formConfidence >= 0.8) {
    // A required select/radio filled by an uncertain fallback (or a required
    // radio left unchosen) must be seen by a human before any auto-send (課題C).
    if (schema.ambiguousChoice) {
      reasons.push('ambiguous-choice-needs-review');
      return { gate: 'mid', mappingConfidence, reasons };
    }
    reasons.push('all-required-high-confidence');
    return { gate: 'high', mappingConfidence, reasons };
  }
  if (minRequiredConf >= 0.6) {
    reasons.push('some-ambiguity');
    return { gate: 'mid', mappingConfidence, reasons };
  }
  reasons.push('low-mapping-confidence');
  return { gate: 'low', mappingConfidence, reasons };
}
