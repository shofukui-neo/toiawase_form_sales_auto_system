import * as cheerio from 'cheerio/slim';
import { normalizeDomain } from '../utils/url.js';

/**
 * M0（解析部）— HTML からメールアドレスを取り出す純粋関数群。
 *
 * ネットワークを触る側 (`l0_email.ts`) から切り離してある。誤検出がそのまま
 * 誤送信になるのはこちらの規則なので、単体で固定できるようにしておきたい
 * ——そして取得層 (undici) を読み込まずにテストできるようにするため。
 */

/**
 * HTML テキスト中のメールらしき文字列。
 * `@` の前後に許す文字を絞り、画像パス (`logo@2x.png`) やパッケージ指定
 * (`jquery@3.6.0.js`) を拾わないようにする。
 */
export const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

/** 送信してはいけない／企業の窓口ではないローカル部。 */
const REJECT_LOCAL =
  /^(?:noreply|no-reply|donotreply|do-not-reply|postmaster|abuse|mailer-daemon|bounce|root)$/i;
/** 解析タグ・CMS・CDN 由来の誤検出ドメイン。 */
const REJECT_DOMAIN =
  /(?:example|test|localhost|sentry\.io|wixpress|godaddy|squarespace|shopify|w3\.org|schema\.org|sentry-cdn|jquery|googleapis|gstatic|cloudflare)/i;
/** 画像・スクリプトの拡張子で終わるものは誤検出。 */
const REJECT_TLD = /\.(?:png|jpe?g|gif|svg|webp|css|js|json|xml|woff2?|ttf)$/i;

/** 「＠」「(at)」等でメールを難読化しているサイト向けの復元。 */
export function deobfuscate(text: string): string {
  return text
    .replace(/＠/g, '@')
    .replace(/\s*[[(（［]\s*(?:at|アット)\s*[\])）］]\s*/gi, '@')
    .replace(/\s*[[(（［]\s*(?:dot|ドット)\s*[\])）］]\s*/gi, '.');
}

export type EmailRoleKind = 'info' | 'contact' | 'inquiry' | 'sales' | 'recruit' | 'support' | 'other';

/** ローカル部から窓口の種別を判定する。宛先の優先順位に使う。 */
export function classifyLocalPart(local: string): EmailRoleKind {
  const l = local.toLowerCase();
  if (/^(?:info|information)\b/.test(l)) return 'info';
  if (/^(?:contact|otoiawase|toiawase|form)/.test(l)) return 'contact';
  if (/^(?:inquiry|inquiries|question)/.test(l)) return 'inquiry';
  if (/^(?:sales|eigyo|business|bd)/.test(l)) return 'sales';
  if (/^(?:recruit|saiyo|jinji|hr|career|jobs?)/.test(l)) return 'recruit';
  if (/^(?:support|help|desk|cs)/.test(l)) return 'support';
  return 'other';
}

/**
 * 宛先としての望ましさ。新卒採用の提案なので、採用窓口 > 総合窓口 > その他。
 * 個人名アドレスは（載っていても）優先度を落とす — 担当者個人に直接送るより
 * 公開窓口に送る方が、受け手にとっても社内で回しやすい。
 */
const ROLE_SCORE: Record<EmailRoleKind, number> = {
  recruit: 1.0, info: 0.9, contact: 0.85, inquiry: 0.8, sales: 0.5, support: 0.5, other: 0.4,
};

export interface FoundEmail {
  email: string;
  local: string;
  domain: string;
  roleKind: EmailRoleKind;
  confidence: number;
  /** 掲載されていたページ（根拠）。推測アドレスでは null。 */
  pageUrl: string | null;
  source: 'published' | 'guessed';
}

/**
 * 要素の境界を改行にして本文テキストを取り出す。
 *
 * cheerio の `.text()` は隣接要素を **区切り無しで連結する**。
 * `<p>info@a.co.jp</p><p>recruit@a.co.jp</p>` が
 * `info@a.co.jprecruit@a.co.jp` になり、正規表現が境界をまたいで
 * `a.co.jprecruit@a.co.jp` という実在しないアドレスを作る。ローカル部が
 * 壊れているだけでドメインは正しいので MX 確認も通ってしまい、そのまま
 * ハードバウンスになる（送信ドメインの評価が落ちる）。
 */
function textWithBoundaries(html: string): string {
  return (
    html
      // 中身がテキストとして意味を持たない要素は丸ごと落とす。
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '\n')
      // タグを改行に。要素の境界がそのまま区切りになる。
      .replace(/<[^>]*>/g, '\n')
      // 数値文字参照を戻す。`info&#64;example.jp` は実際に使われる難読化手法で、
      // ここで戻さないとアドレスとして見えない。
      .replace(/&#(\d{1,7});/g, (_m, d: string) => safeCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
  );
}

function safeCodePoint(cp: number): string {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
}

/**
 * 直前の文字が「アドレスの一部になりうる文字」なら、それは別のアドレスの
 * 途中から拾ってしまっている。区切りを入れても残る取りこぼしへの保険。
 */
function hasCleanStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[A-Za-z0-9@._%+-]/.test(text[index - 1]);
}

/** 送信対象になりうる形か（構文・除外規則）。 */
export function isAcceptableAddress(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  // RFC 5321 のローカル部上限。これを超えるのは連結事故の残骸。
  if (local.length === 0 || local.length > 64) return false;
  if (REJECT_LOCAL.test(local)) return false;
  if (REJECT_DOMAIN.test(domain) || REJECT_TLD.test(domain)) return false;
  // ローカル部に TLD らしき綴りが埋まっているのは、前のアドレスと繋がった証拠。
  if (/\.(?:jp|com|net|org|info|biz)(?![a-z])/i.test(local)) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain);
}

/** 企業自身のドメイン（サブドメイン含む）か。 */
function isOwnDomain(emailDomain: string, companyDomain: string): boolean {
  const a = normalizeDomain(emailDomain);
  const b = normalizeDomain(companyDomain);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * 1 ページ分の HTML からメールを抜き出す。
 *
 * @param companyDomain 企業のドメイン。別ドメイン（制作会社・ASP）のアドレスは
 *   拾えても宛先としては弱いので確度を大きく下げる。
 */
export function extractEmailsFromHtml(
  html: string,
  pageUrl: string,
  companyDomain: string,
): FoundEmail[] {
  const $ = cheerio.load(html);
  const hits = new Map<string, FoundEmail>();

  const add = (raw: string, boost: number) => {
    const email = deobfuscate(raw.trim())
      .toLowerCase()
      .replace(/^mailto:/, '')
      .split('?')[0];
    if (!isAcceptableAddress(email)) return;

    const at = email.lastIndexOf('@');
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const roleKind = classifyLocalPart(local);
    const own = isOwnDomain(domain, companyDomain);
    const confidence = Math.min(1, Number((ROLE_SCORE[roleKind] * (own ? 1 : 0.35) + boost).toFixed(3)));

    const prev = hits.get(email);
    if (!prev || prev.confidence < confidence) {
      hits.set(email, { email, local, domain, roleKind, confidence, pageUrl, source: 'published' });
    }
  };

  // mailto: リンクは最も確実（人間向けに置かれた窓口）。
  $('a[href^="mailto:" i]').each((_, el) => {
    add((($(el).attr('href') || '').slice('mailto:'.length)), 0.1);
  });

  // 本文テキスト。要素の境界を改行にしてから難読化を戻す。
  const text = deobfuscate(textWithBoundaries(html));
  for (const m of text.matchAll(EMAIL_RE)) {
    if (hasCleanStart(text, m.index ?? 0)) add(m[0], 0);
  }

  return [...hits.values()];
}

/**
 * 掲載アドレスが見つからなかったときの推測アドレス（info@ / contact@）。
 *
 * **既定では送信対象にしない**（config.email.allowGuessed）。特定電子メール法の
 * オプトイン例外は「自己のメールアドレスを**公開している**団体・営業を営む個人」
 * への送信を根拠にするため、掲載を確認できていないアドレスに送るとその根拠を
 * 失う。当て推量の宛先はバウンス率も上げる。
 */
export function guessRoleAddresses(domain: string): FoundEmail[] {
  const d = normalizeDomain(domain);
  if (!d) return [];
  return (['info', 'contact'] as const).map((local) => ({
    email: `${local}@${d}`,
    local,
    domain: d,
    roleKind: classifyLocalPart(local),
    confidence: 0.25,
    pageUrl: null,
    source: 'guessed' as const,
  }));
}
