import type { OutcomeKind } from '../db/repositories.js';

/**
 * 受信メールを「どの企業からの、どんな反応か」に対応づける。
 *
 * **なぜ自動返信の切り分けが最重要か。** 日本企業の問い合わせフォームは
 * ほぼ必ず自動応答（「お問い合わせありがとうございます。担当者より…」）を
 * 返す。これを返信として数えると返信率は 100% 近くになり、指標として
 * 何も語らなくなる。アポ率を測りたいのだから、人間が書いた返信だけを
 * 数えなければならない。判定に迷うものは reply にせず、後で人が見られる形で
 * 残すほうがよい（水増しした返信率は、水増しした成功件数と同じ害がある）。
 */

export interface InboundMail {
  from: string;
  subject: string;
  body: string;
  /** ヘッダ（あれば）。自動返信の判定はヘッダのほうが確実。 */
  headers?: Record<string, string>;
  receivedAt?: string;
}

export type Classification = OutcomeKind | 'auto_reply' | 'unknown';

export interface Classified {
  kind: Classification;
  reason: string;
}

/* ---------------------------- 自動返信の判定 ---------------------------- */

/** RFC で自動応答を名乗るヘッダ。人手の返信には付かない。 */
function autoByHeader(h: Record<string, string>): string | null {
  const get = (k: string) => h[k] ?? h[k.toLowerCase()] ?? '';
  if (/auto-(replied|generated|notified)/i.test(get('Auto-Submitted'))) return 'Auto-Submitted';
  if (get('X-Autoreply') || get('X-Autorespond')) return 'X-Autoreply';
  if (/^(bulk|auto_reply|junk|list)$/i.test(get('Precedence').trim())) return 'Precedence';
  if (get('List-Unsubscribe') && !get('In-Reply-To')) return 'List-Unsubscribe';
  return null;
}

const AUTO_SUBJECT = [
  '自動返信',
  '自動送信',
  '自動応答',
  'automatic reply',
  'auto reply',
  'autoreply',
];

/**
 * 本文が自動応答であることを示す言い回し。
 * 「お問い合わせありがとうございます」だけでは足りない — 人が書いた返信の
 * 書き出しにも普通に出るため、自動送信であると述べている文と併せて見る。
 */
const AUTO_BODY = [
  'このメールは自動的に送信',
  'このメールは自動送信',
  '自動的に返信',
  'システムより自動',
  '本メールは送信専用',
  '返信いただいてもお答えできません',
  'このメールに心当たりのない',
  'do not reply',
  'no-reply',
];

/* ------------------------------ 配達エラー ------------------------------ */

const BOUNCE_FROM = /mailer-daemon|postmaster|no-?reply@.*(mail|smtp)/i;
const BOUNCE_SUBJECT = [
  'undelivered',
  'delivery status notification',
  'returned mail',
  'failure notice',
  'mail delivery failed',
  '送信できませんでした',
  '配信できませんでした',
  'アドレスが見つかりません',
];

/* -------------------------------- お断り -------------------------------- */

const REFUSAL = [
  '営業目的',
  '営業のご連絡',
  '営業活動',
  'お断りいたします',
  'お断りします',
  'ご遠慮ください',
  'ご遠慮いただ',
  '今後のご連絡は不要',
  '今後の連絡は不要',
  '配信停止',
  '見送らせていただ',
  '不要でございます',
  '必要ございません',
  '興味がございません',
  '該当いたしません',
];

/* --------------------------------- アポ --------------------------------- */

/** 日程が具体的に動いていることを示す語。単独の「日程」では弱い。 */
const APPOINTMENT = [
  'ご都合',
  '日程調整',
  '日時',
  '打ち合わせ',
  'お打合せ',
  '面談',
  'ご説明を',
  'お時間をいただ',
  'zoom',
  'teams',
  'google meet',
  'オンラインで',
  '予約が完了',
  '予約を受け付',
  'booking.receptionist.jp',
];

/** 月日の表記（「9月10日」「9/10」）。日程が動いた強い証拠になる。 */
const DATE_RE = /(\d{1,2}\s*[月\/]\s*\d{1,2}\s*[日]?)/;

const has = (text: string, words: string[]) => words.find((w) => text.includes(w));

/**
 * 受信メール 1 通を分類する。
 * 判定順は 配達エラー → 自動返信 → お断り → アポ → 返信。
 * 自動返信をお断りより先に見るのは、自動応答の定型文に「営業目的の
 * お問い合わせはご遠慮ください」が含まれることがあるため。
 */
export function classifyMail(mail: InboundMail): Classified {
  const subject = (mail.subject || '').toLowerCase();
  const rawSubject = mail.subject || '';
  const body = mail.body || '';
  const all = `${rawSubject}\n${body}`;
  const allLower = all.toLowerCase();
  const headers = mail.headers ?? {};

  // 1. 配達エラー。届いていないので、返信率の分母から外す材料になる。
  if (BOUNCE_FROM.test(mail.from) || has(subject, BOUNCE_SUBJECT)) {
    return { kind: 'bounce', reason: `配達エラー: ${mail.from}` };
  }

  // 2. 自動返信。ヘッダが最も確実で、次に件名、最後に本文の言い回し。
  const hdr = autoByHeader(headers);
  if (hdr) return { kind: 'auto_reply', reason: `自動返信ヘッダ (${hdr})` };
  const autoSubj = has(subject, AUTO_SUBJECT);
  if (autoSubj) return { kind: 'auto_reply', reason: `件名に「${autoSubj}」` };
  const autoBody = has(allLower, AUTO_BODY);
  if (autoBody) return { kind: 'auto_reply', reason: `本文に「${autoBody}」` };

  // 3. お断り・配信停止。人が書いているので返信ではあるが、成果ではない。
  const refusal = has(all, REFUSAL);
  if (refusal) {
    const kind: OutcomeKind = all.includes('配信停止') ? 'optout' : 'refusal';
    return { kind, reason: `お断りの表現「${refusal}」` };
  }

  // 4. アポ。日程が具体的に動いていることを求める。「ご検討します」を
  //    アポに数えると、この指標で改善を判断できなくなる。
  const appt = has(allLower, APPOINTMENT);
  if (appt && (DATE_RE.test(all) || /予約|日程調整|booking\.receptionist/i.test(all))) {
    return { kind: 'appointment', reason: `日程の言及「${appt}」＋日時/予約` };
  }

  // 5. それ以外の人手の返信。
  if (body.trim().length > 0) return { kind: 'reply', reason: '人手の返信と判断' };
  return { kind: 'unknown', reason: '本文が空で判断できない' };
}

/* ------------------------------ 企業の照合 ------------------------------ */

export interface CompanyKey {
  id: number;
  name: string;
  domain: string;
}

/** ドメインから www / 一般的なサブドメインを落として比較用に揃える。 */
export function normalizeDomain(input: string): string {
  return (input || '')
    .toLowerCase()
    .trim()
    .replace(/^.*@/, '')
    .replace(/^www\./, '')
    .replace(/[>,;\s]+$/, '');
}

/** 株式会社などの法人格・記号を落とした社名。表記ゆれの吸収に使う。 */
export function normalizeName(name: string): string {
  return (name || '')
    .replace(/株式会社|有限会社|合同会社|一般社団法人|公益財団法人|\(株\)|（株）/g, '')
    .replace(/[\s　・，,.\-–—]/g, '')
    .toLowerCase();
}

export interface Match {
  company: CompanyKey;
  how: 'domain' | 'domain-suffix' | 'name';
  confidence: number;
}

/**
 * 送信元アドレスと本文から企業を特定する。
 *
 * ドメイン一致を最優先する。社名一致だけで確定させると、「トヨタ」を含む
 * 別会社に反応を付けてしまい、その企業のアポ率が実態と食い違う。名前で
 * 当てるのは、ドメインで当たらず、かつ一意に決まるときだけにする。
 */
export function matchCompany(mail: InboundMail, companies: CompanyKey[]): Match | null {
  const from = normalizeDomain(mail.from);
  if (from) {
    const exact = companies.find((c) => normalizeDomain(c.domain) === from);
    if (exact) return { company: exact, how: 'domain', confidence: 1 };
    // 子会社・部署が別サブドメインで返してくることがある (recruit.example.co.jp)。
    const suffix = companies.filter((c) => {
      const d = normalizeDomain(c.domain);
      return d && (from.endsWith(`.${d}`) || d.endsWith(`.${from}`));
    });
    if (suffix.length === 1) return { company: suffix[0], how: 'domain-suffix', confidence: 0.9 };
  }

  const hay = normalizeName(`${mail.subject}\n${mail.body}\n${mail.from}`);
  const byName = companies.filter((c) => {
    const n = normalizeName(c.name);
    // 2 文字以下の社名は誤爆しかしないので名前照合の対象にしない。
    return n.length >= 3 && hay.includes(n);
  });
  if (byName.length === 1) return { company: byName[0], how: 'name', confidence: 0.6 };
  return null;
}
