import { resolveMx } from 'node:dns/promises';
import * as cheerio from 'cheerio/slim';
import { fetchPage } from '../utils/http.js';
import { baseUrl, normalizeDomain, resolveUrl, sameSite } from '../utils/url.js';
import { detectNoSalesPolicy } from '../crosscutting/compliance.js';
import { extractEmailsFromHtml, type FoundEmail } from './l0_email_parse.js';
import { logger } from '../utils/logger.js';

const log = logger('M0');

/**
 * M0（取得部）— メールアドレス自動探索。
 *
 * 企業サイトに **実際に掲載されている** アドレスだけを拾う。抽出・除外の規則は
 * {@link l0_email_parse} 側（純粋関数）にあり、ここはページの取り方と
 * MX 確認だけを持つ。
 *
 * 探索は「会社概要・お問い合わせ系のページを数枚取る」だけの静的クロールで、
 * ブラウザは使わない。フォーム発見 (L1) と違い JS 描画の必要がほぼ無いうえ、
 * 3万件規模ではブラウザ枠の奪い合いになるため。
 */

/** メールが載っていることが多いページ。安い順に見る。 */
const CANDIDATE_PATHS = [
  '/contact', '/contact/', '/contact-us', '/inquiry', '/inquiry/',
  '/company', '/company/', '/about', '/about/', '/corporate', '/profile',
  '/company/outline', '/company/profile', '/privacy', '/privacy/',
];

/** ページ内リンクのうち、たどる価値のあるテキスト。 */
const LINK_SIGNALS = [
  '会社概要', '企業情報', '会社案内', 'お問い合わせ', 'お問合せ', '問合せ',
  'contact', 'company', 'about', 'corporate', 'privacy', 'プライバシー',
];

/** 1 社あたりに取得するページ数の上限。3万社を回す前提のコスト上限。 */
const MAX_PAGES = 6;

export type { FoundEmail } from './l0_email_parse.js';
export { classifyLocalPart, guessRoleAddresses } from './l0_email_parse.js';

export interface EmailDiscoveryResult {
  emails: FoundEmail[];
  /** 「営業メールお断り」等をサイト上で検出した場合の該当文言。 */
  noSalesPolicy: string | null;
  /** 実際に取得できたページ数（0 ならサイトが落ちている）。 */
  pagesFetched: number;
}

/** 取得するページを集める（トップ → リンク走査 → 定番パス）。 */
async function collectPages(domain: string): Promise<{ url: string; html: string }[]> {
  const base = baseUrl(domain);
  const out: { url: string; html: string }[] = [];
  const seen = new Set<string>();

  const take = async (url: string): Promise<string | null> => {
    if (seen.has(url) || out.length >= MAX_PAGES) return null;
    seen.add(url);
    const page = await fetchPage(url, { timeoutMs: 10000 });
    if (!page || page.status >= 400 || !page.html) return null;
    out.push({ url: page.finalUrl, html: page.html });
    return page.html;
  };

  // apex が引けないサイトは www を試す（L1 と同じ事情）。
  const home = await take(`${base}/`);
  if (!home) await take(`https://www.${normalizeDomain(domain)}/`);

  // トップのリンクから会社概要・問い合わせ系をたどる。
  const first = out[0];
  if (first) {
    const $ = cheerio.load(first.html);
    const links: string[] = [];
    $('a[href]').each((_, el) => {
      const label = `${$(el).text()} ${$(el).attr('title') || ''}`.toLowerCase();
      const href = $(el).attr('href') || '';
      const hit = LINK_SIGNALS.some(
        (s) => label.includes(s.toLowerCase()) || href.toLowerCase().includes(s.toLowerCase()),
      );
      if (!hit) return;
      const abs = resolveUrl(href, first.url);
      if (abs && sameSite(abs, domain) && !links.includes(abs)) links.push(abs);
    });
    for (const u of links.slice(0, 4)) await take(u);
  }

  // 定番パスの取りこぼしを補う。
  for (const p of CANDIDATE_PATHS) {
    if (out.length >= MAX_PAGES) break;
    await take(base + p);
  }
  return out;
}

/** MX レコードが引けるか。バウンスを事前に減らすための最小の検証。 */
export async function hasMx(domain: string): Promise<boolean> {
  try {
    const mx = await resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

/**
 * 企業ドメインからメールアドレスを探す。ネットワークだけを触り、DB は書かない
 * （キャッシュと保存は `pipeline/emailDiscovery` の責務）。
 */
export async function discoverEmails(domain: string): Promise<EmailDiscoveryResult> {
  const pages = await collectPages(domain);
  if (pages.length === 0) return { emails: [], noSalesPolicy: null, pagesFetched: 0 };

  const merged = new Map<string, FoundEmail>();
  let noSales: string | null = null;

  for (const p of pages) {
    for (const e of extractEmailsFromHtml(p.html, p.url, domain)) {
      const prev = merged.get(e.email);
      if (!prev || prev.confidence < e.confidence) merged.set(e.email, e);
    }
    if (!noSales) {
      const $ = cheerio.load(p.html);
      noSales = detectNoSalesPolicy($('body').text() || '');
    }
  }

  const emails = [...merged.values()].sort((a, b) => b.confidence - a.confidence);
  log.debug(`${domain}: ${emails.length} 件のアドレス / ${pages.length} ページ`);
  return { emails, noSalesPolicy: noSales, pagesFetched: pages.length };
}
