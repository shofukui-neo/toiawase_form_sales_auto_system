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

  // 件名だけは入力上限に合わせて詰める。
  //
  // 件名欄に maxlength=30 を掛けているフォームは珍しくないが、既定の件名は
  // 40 字を超える。以前はこれを「本文が長すぎる」として企業ごと除外して
  // いた（message_too_long 158 社のうち 102 社は本文欄に上限すら無かった）。
  // 件名はこちらが用意した見出しなので、短くしても相手に渡す情報は減らない。
  // 逆に氏名・会社名・メール等は切り詰めると嘘の値を送ることになるので、
  // ここでは絶対に触らない（超過するなら送らないほうが正しい）。
  if (role === 'subject' && field?.maxLength && value.length > field.maxLength) {
    value = shortenSubject(value, field.maxLength);
  }

  return value;
}

/**
 * 件名を上限内に収める。括弧書きの補足（社名など）を先に落とし、それでも
 * 収まらなければ区切り文字の手前で切る。意味の切れ目で終わらせたいので、
 * 単純な切り捨ては最後の手段にする。
 */
export function shortenSubject(subject: string, limit: number): string {
  if (subject.length <= limit) return subject;

  // 1. 末尾の（…）を落とす
  const noParen = subject.replace(/[（(][^（()）]*[)）]\s*$/, '').trim();
  if (noParen && noParen.length <= limit) return noParen;

  // 2. ／ や 〜 などの区切りで前半だけ残す
  for (const sep of ['／', '/', '｜', '|', '〜', '~', '－', '-']) {
    const head = noParen.split(sep)[0].trim();
    if (head && head.length <= limit && head.length >= Math.min(8, limit)) return head;
  }

  // 3. それでも長ければ切る。「…」は入れない（相手の画面で意図が伝わらない）。
  return noParen.slice(0, limit).trim();
}
