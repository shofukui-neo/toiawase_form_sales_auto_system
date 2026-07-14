import type { DetectedField, FieldRole } from '../types.js';

/**
 * Fill policy (承認済みポリシー): fill **required fields + core sender identity**
 * only. Optional non-identity boxes (部署 / 郵便検索の補助欄 / 積地・降地 等) are
 * left blank — filling them is unnecessary for a sales inquiry and is the main
 * source of mis-fills / false "誤り疑い". L4 (actual typing) and the review
 * predictor share this single decision so the preview never diverges from reality.
 */

/** Roles that represent our (truthful) sender identity — always filled if present. */
export const CORE_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>([
  'company',
  'name', 'name_sei', 'name_mei',
  'kana', 'kana_sei', 'kana_mei',
  'email', 'email_confirm',
  'phone', 'phone1', 'phone2', 'phone3',
  'message', 'subject',
  'agree',
]);

/** Non-core roles (postal / address / department) are filled ONLY when required. */
export function isCoreRole(role: FieldRole): boolean {
  return CORE_ROLES.has(role);
}

/** Will L4 actually type into this field? Core identity always; others only if required. */
export function shouldFillField(field: DetectedField | undefined, role: FieldRole): boolean {
  if (isCoreRole(role)) return true;
  return !!field?.required;
}
