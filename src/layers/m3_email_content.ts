import { config } from '../config.js';
import type { CompanyRow } from '../types.js';
import { buildSignature, renderTemplate } from './l3_content.js';
import { personalize } from './l3_personalize.js';
import { newToken, clickUrl, unsubscribeUrl, clickTrackingEnabled } from '../crosscutting/tracking.js';

/**
 * M3 — メール本文の生成。
 *
 * フォーム用 (l3_content) と同じテンプレート engine を使いつつ、メール固有の
 * 2 点を足す:
 *
 *  1. **配信停止の導線**（特定電子メール法の表示義務）。本文末尾のリンクと
 *     List-Unsubscribe ヘッダの両方に出す。
 *  2. **クリック検知**。本文中の URL を計測 URL に差し替える。ただし差し替えは
 *     HTML パートだけで、テキストパートは実 URL のまま残す — 見た目が
 *     `https://track.example.com/t/c/xTq…` に化けると、B2B の初回接触では
 *     露骨に警戒される（迷惑メール判定にも効く）。HTML を表示するクライアントが
 *     大多数なので、計測はそちらで取り、テキスト派の信頼を捨てない。
 */

/** 本文から拾う URL。末尾の句読点・全角括弧を巻き込まないようにする。 */
const URL_RE = /https?:\/\/[^\s<>"'）】」、。]+/g;

export interface EmailLinkPlan {
  /** email_links に保存するトークン。 */
  token: string;
  url: string;
  label: string | null;
}

export interface RenderedEmail {
  subject: string;
  /** プレーンテキスト本文（実 URL のまま）。DB にはこれを保存する。 */
  text: string;
  /** HTML 本文（計測 URL に差し替え済み）。 */
  html: string;
  /** この送信を識別するトークン（配信停止リンクの識別子）。 */
  sendToken: string;
  /** 本文に埋めた計測リンク。呼び出し側が email_links に保存する。 */
  links: EmailLinkPlan[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** URL に対する短い説明（クリックの内訳を人が読めるようにする）。 */
function labelFor(url: string): string {
  if (config.sender.bookingUrl && url.startsWith(config.sender.bookingUrl)) return '日程調整';
  if (config.sender.url && url.startsWith(config.sender.url)) return '会社サイト';
  return 'その他';
}

/**
 * テキスト本文を HTML に変換しつつ、URL を計測リンクに差し替える。
 *
 * アンカーの表示文字列は **実 URL のまま** にする。飛び先が隠れていない状態を
 * 保つことで、受信者はリンクの正体を確認できる。
 */
function toHtml(text: string, links: EmailLinkPlan[], trackable: boolean): string {
  const byUrl = new Map(links.map((l) => [l.url, l]));
  const lines = text.split('\n').map((line) => {
    let out = '';
    let last = 0;
    for (const m of line.matchAll(URL_RE)) {
      const url = m[0];
      out += escapeHtml(line.slice(last, m.index));
      const plan = byUrl.get(url);
      const href = trackable && plan ? clickUrl(plan.token) : null;
      out += `<a href="${escapeHtml(href ?? url)}" style="color:#1558d6">${escapeHtml(url)}</a>`;
      last = (m.index ?? 0) + url.length;
    }
    out += escapeHtml(line.slice(last));
    return out;
  });

  return [
    '<div style="font-family:-apple-system,\'Hiragino Kaku Gothic ProN\',Meiryo,sans-serif;',
    'font-size:14px;line-height:1.9;color:#1a1a1a;white-space:normal">',
    lines.join('<br>'),
    '</div>',
  ].join('');
}

/**
 * 1 社分のメールを組み立てる。DB は触らない（トークンを発行して返すだけ）。
 *
 * @param templateName config/templates/<name>.md
 */
export function renderEmail(company: CompanyRow, templateName = 'mochica_email'): RenderedEmail {
  const s = config.sender;
  const p = personalize(company);
  const sendToken = newToken();

  const { subject, body } = renderTemplate(templateName, {
    company: company.name,
    senderCompany: s.company,
    senderProduct: s.product,
    senderPerson: s.person,
    senderDepartment: s.department,
    senderEmail: s.email,
    senderPhone: s.phone,
    senderOfficePhone: s.officePhone,
    reason: p.reason,
    industry: p.industry,
    bookingUrl: s.bookingUrl,
    signature: buildSignature(),
  });

  // 配信停止の案内（表示義務）。公開 URL が無い環境ではリンクを出せないので、
  // 返信による停止を案内する — 停止手段が本文に無い状態では送らない。
  const unsubUrl = unsubscribeUrl(sendToken);
  const optOut = unsubUrl
    ? [
        '',
        '───────────────',
        '※本メールは貴社サイトに掲載されているアドレス宛にお送りしています。',
        '　今後のご案内が不要な場合は、下記より配信を停止いたします。',
        `　${unsubUrl}`,
      ].join('\n')
    : [
        '',
        '───────────────',
        '※本メールは貴社サイトに掲載されているアドレス宛にお送りしています。',
        `　今後のご案内が不要な場合は、本メールへの返信（${s.email}）にてお知らせください。`,
        '　以後お送りいたしません。',
      ].join('\n');

  const text = `${body}\n${optOut}`;

  // 計測対象の URL を集める。配信停止リンク自体は計測しない
  // （「停止したい」の意思表示をクリック実績として数えるのは誤り）。
  const trackable = clickTrackingEnabled();
  const seen = new Set<string>();
  const links: EmailLinkPlan[] = [];
  if (trackable) {
    for (const m of body.matchAll(URL_RE)) {
      const url = m[0];
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ token: newToken(), url, label: labelFor(url) });
    }
  }

  return {
    subject,
    text,
    html: toHtml(text, links, trackable),
    sendToken,
    links,
  };
}

/** 計測 URL を差し込む前の、配信停止 URL（ヘッダ用）。 */
export function unsubscribeUrlFor(sendToken: string): string | null {
  return unsubscribeUrl(sendToken);
}
