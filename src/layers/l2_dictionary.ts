import type { DetectedField, FieldRole } from '../types.js';

/**
 * L2 rule-based dictionary (spec §4-L2 ①). Each role has keyword patterns
 * matched against label / name / id / placeholder. Order matters: more specific
 * roles (kana, email) should win over generic ones (name), so we score matches.
 */

/**
 * Fields belonging to a form that is not a sales-inquiry form at all — spam
 * reports, complaints, cancellations, fraud reports.
 *
 * These forms carry a 【入力者情報】 block that looks exactly like a normal
 * contact form (会社名 / お名前 / 電話番号 / メールアドレス / お問い合わせ内容),
 * so the generic mapper happily fills it and then jams the sales subject into
 * 「迷惑メールの件名」 and the pitch into 「迷惑メールの本文」 — a report *of
 * ourselves* as a spammer, filed with the recipient. Never map these fields, and
 * treat their presence as grounds to drop the whole form (see eligibility.ts).
 */
export const OFF_TOPIC_FIELD_RE =
  /迷惑メール|迷惑行為|スパム|spam|なりすまし|フィッシング|phishing|配信停止|配信元|通報|苦情|クレーム|リコール|返品|解約|退会|不正利用|不正アクセス/i;

/** Indices of fields that must never receive a value (off-topic form sections). */
export function offTopicFieldIndices(fields: DetectedField[]): Set<number> {
  const out = new Set<number>();
  fields.forEach((f, idx) => {
    const hay = [f.labelText, f.placeholder, f.name, f.id].filter(Boolean).join(' ');
    if (OFF_TOPIC_FIELD_RE.test(hay)) out.add(idx);
  });
  return out;
}
export interface RoleRule {
  role: FieldRole;
  /** Keywords (substring, case-insensitive). */
  keywords: string[];
  /**
   * Disqualifying keywords. A rule with a broad keyword (`office` for 会社名) would
   * otherwise out-score a more specific rule on a compound field like
   * `office_address` / `office_tel`, because assignment is per-field
   * highest-confidence and 会社名 carries a higher weight than 住所.
   */
  exclude?: string[];
  /** Optional input types that strongly imply this role. */
  types?: string[];
  /** Base confidence when a keyword matches. */
  weight: number;
}

export const ROLE_RULES: RoleRule[] = [
  {
    role: 'kana',
    keywords: ['フリガナ', 'ふりがな', 'カナ', 'かな', 'kana', 'furigana', 'せい', 'めい'],
    weight: 0.9,
  },
  {
    // Must out-score `email` so the greedy assigner claims the confirm field for
    // email_confirm (both rules match "メールアドレス確認用"; higher weight wins).
    role: 'email_confirm',
    keywords: [
      '確認用', 'メール確認', '（確認', '確認）', '再入力', '再度', 'もう一度',
      '確認のため', 'ミス防止', '2回', '２回', '控え', 'confirm', 'retype', 're-enter',
    ],
    weight: 0.95,
  },
  {
    role: 'email',
    keywords: ['メール', 'e-mail', 'email', 'mail', 'メールアドレス', 'アドレス'],
    types: ['email'],
    weight: 0.92,
  },
  {
    role: 'postal',
    keywords: ['郵便番号', '郵便', '〒', 'zip', 'zipcode', 'postal', 'postcode', 'post', 'ゆうびん', 'yubin'],
    weight: 0.85,
  },
  {
    role: 'address',
    keywords: ['住所', 'ご住所', '所在地', 'address', '市区町村以降', '町名番地', '番地以降', '以降の住所'],
    weight: 0.8,
  },
  {
    role: 'phone',
    keywords: ['電話', 'tel', '電話番号', 'phone', '携帯', 'ＴＥＬ', 'ﾃﾞﾝﾜ'],
    types: ['tel'],
    weight: 0.9,
  },
  {
    role: 'postal',
    keywords: ['郵便番号', '郵便', '〒', 'zip', 'postal', 'postcode', 'ゆうびん', 'zipcode'],
    weight: 0.85,
  },
  {
    role: 'company',
    keywords: [
      '会社名',
      '貴社名',
      '企業名',
      '法人名',
      '御社名',
      '団体名',
      'company',
      '会社',
      '社名',
      '組織名',
      'お客様名',
      '企業・団体名',
      // 企業・団体名 boxes whose only signal is the attribute name (yokowo's
      // form_office carries no label at all, so the whole 会社名 row went blank).
      'office',
      '事業所',
      '勤務先',
      'corp',
      'kaisha',
    ],
    exclude: [
      '住所', '所在地', 'address', 'addr', '電話', 'tel', 'phone', 'fax',
      'メール', 'mail', '郵便', 'zip', 'postal', '担当', '氏名', 'ふりがな', 'フリガナ',
    ],
    weight: 0.9,
  },
  {
    role: 'department',
    keywords: ['部署', '部門', '役職', 'department', 'position', '所属', 'ご担当部署'],
    weight: 0.8,
  },
  {
    role: 'name',
    keywords: [
      '氏名',
      'お名前',
      'ご担当者',
      'ご氏名',
      '担当者',
      '担当者名',
      'ご担当者名',
      'name',
      'なまえ',
      '御名前',
    ],
    weight: 0.8,
  },
  {
    role: 'subject',
    keywords: ['件名', 'タイトル', 'subject', '題名', 'ご用件'],
    weight: 0.85,
  },
  {
    role: 'message',
    keywords: [
      'お問い合わせ内容',
      'お問合せ内容',
      'お問い合せ内容',
      'お問い合わせ',
      'お問合せ',
      '問い合わせ',
      '問い合わせ内容',
      'ご相談',
      '内容',
      '本文',
      'message',
      'ご質問',
      '詳細',
      'メッセージ',
      'ご要望',
      'コメント',
      'comment',
      'body',
      '相談内容',
    ],
    weight: 0.85,
  },
  {
    // NOTE: no `types: ['checkbox']` here on purpose. A bare type match made every
    // checkbox an "agree" — on a form whose お問い合わせ内容 is a 5-box category
    // group (OEMについて / 部品事業について / …) all five got ticked at once, which
    // is both wrong and unmistakably bot-like. Consent must be named, not guessed.
    role: 'agree',
    keywords: [
      '同意', '承諾', '承認', 'プライバシー', '個人情報', '規約', '取り扱いについて',
      'agree', 'privacy', 'policy', 'consent', 'acceptance', 'accept', 'kiyaku', 'doui',
    ],
    weight: 0.8,
  },
];
