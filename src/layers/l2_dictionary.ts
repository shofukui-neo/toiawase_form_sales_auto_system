import type { FieldRole } from '../types.js';

/**
 * L2 rule-based dictionary (spec §4-L2 ①). Each role has keyword patterns
 * matched against label / name / id / placeholder. Order matters: more specific
 * roles (kana, email) should win over generic ones (name), so we score matches.
 */
export interface RoleRule {
  role: FieldRole;
  /** Keywords (substring, case-insensitive). */
  keywords: string[];
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
    role: 'email',
    keywords: ['メール', 'e-mail', 'email', 'mail', 'メールアドレス', 'アドレス'],
    types: ['email'],
    weight: 0.92,
  },
  {
    role: 'phone',
    keywords: ['電話', 'tel', '電話番号', 'phone', '携帯', 'ＴＥＬ', 'ﾃﾞﾝﾜ'],
    types: ['tel'],
    weight: 0.9,
  },
  {
    role: 'company',
    keywords: ['会社名', '貴社名', '企業名', '法人名', '御社名', '団体名', 'company', '会社', '社名', '組織名'],
    weight: 0.9,
  },
  {
    role: 'department',
    keywords: ['部署', '部門', '役職', 'department', 'position', '所属', 'ご担当部署'],
    weight: 0.8,
  },
  {
    role: 'name',
    keywords: ['氏名', 'お名前', 'ご担当者', 'ご氏名', '担当者', 'name', 'なまえ', 'name', '御名前'],
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
    ],
    weight: 0.85,
  },
  {
    role: 'agree',
    keywords: ['同意', 'プライバシー', '個人情報', 'agree', '承諾', 'privacy', '規約'],
    types: ['checkbox'],
    weight: 0.8,
  },
];
