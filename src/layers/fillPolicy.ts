import type { DetectedField, FieldRole } from '../types.js';

/**
 * Fill policy (承認済みポリシー): fill **required fields + core sender identity**
 * only. Optional boxes that are not part of our identity (積地・降地・ご希望日 等)
 * are left blank — filling them is unnecessary for a sales inquiry and is the main
 * source of mis-fills / false "誤り疑い". L4 (actual typing) and the review
 * predictor share this single decision so the preview never diverges from reality.
 */

/**
 * Roles that represent our (truthful) sender identity — always filled if present.
 *
 * 住所・郵便番号 are core: they are ネオキャリア本社の所在地, which is exactly the
 * information a 所在地 box is asking for, and a B2B inquiry that names a company
 * but no address reads as evasive. (They were once optional-only because no
 * address was configured at all — leaving them blank was the only truthful
 * option. `SENDER_POSTAL` / `SENDER_ADDRESS` now carry the real HQ, so we fill
 * them whether or not the form marks them required.)
 */
export const CORE_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>([
  'company',
  'name', 'name_sei', 'name_mei',
  'kana', 'kana_sei', 'kana_mei',
  'email', 'email_confirm',
  'phone', 'phone1', 'phone2', 'phone3',
  'postal', 'postal1', 'postal2',
  'address', 'address_pref', 'address_city', 'address_street',
  'message', 'subject',
  'agree',
]);

/** Non-core roles (部署 等) are filled ONLY when the form marks them required. */
export function isCoreRole(role: FieldRole): boolean {
  return CORE_ROLES.has(role);
}

/** Will L4 actually type into this field? Core identity always; others only if required. */
export function shouldFillField(field: DetectedField | undefined, role: FieldRole): boolean {
  if (isCoreRole(role)) return true;
  return !!field?.required;
}

/* ------------------------- value resolution (shared) ------------------------ */

/** Convert katakana to hiragana (フクイ -> ふくい); leaves 'ー', spaces, other chars. */
export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Some forms label the reading 「ふりがな」and expect hiragana, not katakana. */
function wantsHiragana(field: DetectedField | undefined): boolean {
  if (!field) return false;
  const hint = `${field.labelText || ''} ${field.name || ''} ${field.id || ''}`;
  if (/フリガナ|カナ/.test(hint)) return false; // katakana explicitly requested
  return /ふりがな|ひらがな/.test(hint) || /[ぁ-ゖ]/.test(field.placeholder || '');
}

const KANA_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>(['kana', 'kana_sei', 'kana_mei']);

/**
 * The exact string L4 will type into a control — the single place where a value
 * is adapted to the field it lands in.
 *
 * Both Execute and the approval preview call this, so the reviewer approves
 * byte-for-byte what gets submitted. (Before, the ふりがな→hiragana conversion
 * lived only in L4 and the dashboard showed katakana for a field that would
 * receive hiragana.) Returns undefined when nothing should be typed.
 */
export function resolveFieldValue(
  field: DetectedField | undefined,
  role: FieldRole,
  values: Partial<Record<FieldRole, string>>,
): string | undefined {
  let value = values[role];
  if (!value) return undefined;

  if (KANA_ROLES.has(role) && wantsHiragana(field)) value = toHiragana(value);

  return value;
}
