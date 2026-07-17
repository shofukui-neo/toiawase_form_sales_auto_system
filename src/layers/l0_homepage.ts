import * as cheerio from 'cheerio';
import { searchWeb, type SearchResult } from './websearch.js';
import { normalizeDomain } from '../utils/url.js';
import { logger } from '../utils/logger.js';

/**
 * L0 拡張 — official homepage resolution ("企業HPも勝手に探す").
 *
 * Given only a company NAME (+ optional industry / prefecture hints), find the
 * company's own homepage domain so the rest of the pipeline (L1 form discovery →
 * L2 parse → send) can run. The hard problem is not *finding a page* — search
 * engines do that — but rejecting the aggregators, SNS pages, job boards and
 * directories that dominate the results and landing on the company's OWN site.
 *
 * Two defenses:
 *   1. a blocklist of non-corporate hosts (SNS / 求人 / 企業DB / news / gov …),
 *   2. verification — fetch the candidate homepage and confirm the company name
 *      or corporate signals actually appear (we never send to an unverified
 *      domain by default; a wrong domain = brand damage, spec の絶対制約).
 */

const log = logger('L0-hp');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Registrable domains that are never a company's own site. */
const BLOCK_DOMAINS = new Set([
  // SNS / UGC / blog / site-builders
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'linkedin.com',
  'note.com', 'ameblo.jp', 'hatenablog.com', 'fc2.com', 'wixsite.com', 'jimdofree.com',
  'wordpress.com', 'blogspot.com', 'pinterest.com', 'tiktok.com', 'line.me', 'threads.net',
  // encyclopedia / dictionary / news
  'wikipedia.org', 'weblio.jp', 'nikkei.com', 'yahoo.co.jp', 'prtimes.jp', 'itmedia.co.jp',
  'response.jp', 'toyokeizai.net', 'diamond.jp', 'goo.ne.jp',
  // corporate databases / aggregators / directories
  'baseconnect.in', 'salesnow.jp', 'houjin.jp', 'houjin-bangou.nta.go.jp', 'alarmbox.jp',
  'compalyze.co.jp', 'ipros.jp', 'jpnumber.com', 'buffett-code.com', 'ullet.com',
  'minkabu.jp', 'kabutan.jp', 'shikiho.toyokeizai.net', 'g-search.jp', 'mapion.co.jp',
  'its-mo.com', 'navitime.co.jp', 'ekiten.jp', 'itp.ne.jp', 'i-town.jp', 'townpage.jp',
  'jobtalk.jp', 'career-tasu.jp', 'craft-gogo.com', 'baseconnect.com', 'ba-connect.com',
  // job boards / 口コミ (a company page there is NOT its HP)
  'mynavi.jp', 'rikunabi.com', 'next.rikunabi.com', 'en-japan.com', 'doda.jp', 'type.jp',
  'wantedly.com', 'townwork.net', 'baitoru.com', 'indeed.com', 'jp.indeed.com',
  'en-hyouban.com', 'openwork.jp', 'vorkers.com', 'job-medley.com', 'kaigojob.com',
  'green-japan.com', 'levtech.jp', 'hatarako.net', 'jobmedley.com', 'kyujin-box.com',
  // marketplaces / maps / misc portals
  'amazon.co.jp', 'rakuten.co.jp', 'google.com', 'google.co.jp', 'tabelog.com',
  'ne.jp', 'jimdo.com',
  // search engines themselves (never a company's own site)
  'bing.com', 'duckduckgo.com', 'microsoft.com', 'msn.com', 'yahoo.com',
]);

/** Substrings that flag a host as an aggregator/portal even if not enumerated. */
const BLOCK_SUBSTR = ['wikipedia', 'wiki.', 'blog.', 'ameblo', 'hatena', 'note.com',
  'kyujin', 'kyuujin', 'recruit-navi', 'baito', 'townwork', 'hellowork', 'hello-work'];

/** Public-suffix labels used to compute the registrable domain for .jp sites. */
const JP_SECOND_LEVELS = new Set(['co', 'or', 'ne', 'go', 'ac', 'ed', 'gr', 'lg', 'geo']);

/**
 * Shared-hosting / ISP registrable domains under which many *different* companies
 * live on their own subdomain (e.g. komeri.bit.or.jp). For these the company is
 * the SUBDOMAIN — collapsing to the registrable domain would point every tenant
 * at the ISP. So candidateDomain() keeps the full host for these.
 */
const SHARED_HOSTING = new Set([
  'bit.or.jp', 'sakura.ne.jp', 'lolipop.jp', 'xsrv.jp', 'xdomain.jp', 'coreserver.jp',
  'wpx.jp', 'netowl.jp', 'chobi.net', 'o0o0.jp', 'crayonsite.com', 'jimdo.com',
  'on.jp', 'so-net.ne.jp', 'ocn.ne.jp', 'nifty.com', 'plala.or.jp', 'gozaru.jp',
]);

/** Reduce a host to its registrable domain (care21.co.jp from www.care21.co.jp). */
export function registrableDomain(host: string): string {
  const h = normalizeDomain(host);
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  if (last === 'jp' && JP_SECOND_LEVELS.has(second)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/**
 * The domain identity we hand to L1. Normally the registrable domain, but when
 * that is a shared-hosting suffix we keep the full host (the company's own
 * subdomain). www is always stripped (L1 re-adds it).
 */
export function candidateDomain(host: string): string {
  const h = normalizeDomain(host);
  return SHARED_HOSTING.has(registrableDomain(h)) ? h : registrableDomain(h);
}

/** Corporate-form suffixes/prefixes stripped to get the "core" brand name. */
const LEGAL_TOKENS = [
  '株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '一般社団法人', '一般財団法人',
  '公益社団法人', '公益財団法人', '社会福祉法人', '医療法人社団', '医療法人財団', '医療法人',
  '学校法人', '宗教法人', '特定非営利活動法人', 'ＮＰＯ法人', 'NPO法人', '協同組合',
  '生活協同組合', '農業協同組合', '（株）', '(株)', '（有）', '(有)',
];

/** Strip legal tokens + whitespace to compare names against page text. */
export function coreName(name: string): string {
  let s = name.trim();
  for (const t of LEGAL_TOKENS) s = s.split(t).join('');
  return s.replace(/[\s　]+/g, '').trim();
}

/** Longest run of CJK characters in a string (a strong, specific match token). */
function longestKanjiRun(s: string): string {
  const runs = s.match(/[㐀-鿿゠-ヿｦ-ﾟ]{2,}/g) || [];
  return runs.sort((a, b) => b.length - a.length)[0] || '';
}

async function fetchHtml(url: string, timeoutMs = 12000): Promise<{ status: number; html: string; finalUrl: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en;q=0.8' },
    });
    const html = await res.text();
    return { status: res.status, html, finalUrl: res.url || url };
  } catch (e) {
    log.debug(`fetch failed ${url}: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface ResolveHints {
  industry?: string;
  prefecture?: string;
}

export interface HomepageResult {
  /** Bare registrable domain, ready for L1 (e.g. "care21.co.jp"). */
  domain: string;
  /** Working https base that responded during verification. */
  url: string;
  confidence: number; // 0..1
  method: 'search+verified' | 'search+unverified';
  /** Human-readable reason (for the audit log / resolve report). */
  evidence: string;
  /** Other registrable domains that were considered. */
  alternatives: string[];
}

export interface ResolveDeps {
  /** Search backend. Defaults to the real multi-provider searchWeb. */
  search?: (query: string) => Promise<SearchResult[]>;
  /** Homepage fetcher (for verification). Defaults to a real fetch. */
  fetchHtml?: (url: string) => Promise<{ status: number; html: string; finalUrl: string } | null>;
  /** Delay between query variants (ms). Default 1200; set 0 in tests. */
  queryDelayMs?: number;
}

interface Candidate {
  domain: string;
  bestRank: number;
  hits: number;
  titleMatch: boolean;
  score: number;
  sampleUrl: string;
}

function tldBonus(domain: string): number {
  if (domain.endsWith('.co.jp')) return 0.3;
  if (domain.endsWith('.jp')) return 0.18;
  if (domain.endsWith('.com')) return 0.1;
  if (domain.endsWith('.net') || domain.endsWith('.inc')) return 0.05;
  return 0;
}

function isBlocked(domain: string): boolean {
  if (BLOCK_DOMAINS.has(domain)) return true;
  return BLOCK_SUBSTR.some((s) => domain.includes(s));
}

/** Build candidate domains from search results, scored but not yet verified. */
function rankCandidates(results: SearchResult[], name: string): Candidate[] {
  const core = coreName(name);
  const kanji = longestKanjiRun(core);
  const byDomain = new Map<string, Candidate>();

  results.forEach((r, rank) => {
    let host: string;
    try {
      host = new URL(r.url).host;
    } catch {
      return;
    }
    // Blocklist is checked on the registrable domain (so company.mynavi.jp is
    // caught), but candidate identity keeps ISP-hosted subdomains intact.
    if (isBlocked(registrableDomain(host))) return;
    const domain = candidateDomain(host);
    if (!domain || domain.split('.').length < 2) return;

    const titleHit =
      (!!core && r.title.includes(core)) || (!!kanji && kanji.length >= 2 && r.title.includes(kanji));

    const existing = byDomain.get(domain);
    if (existing) {
      existing.hits++;
      existing.bestRank = Math.min(existing.bestRank, rank);
      existing.titleMatch = existing.titleMatch || titleHit;
    } else {
      byDomain.set(domain, {
        domain,
        bestRank: rank,
        hits: 1,
        titleMatch: titleHit,
        score: 0,
        sampleUrl: r.url,
      });
    }
  });

  const candidates = [...byDomain.values()];
  for (const c of candidates) {
    let s = 0.4;
    s += Math.max(0, 0.3 - c.bestRank * 0.05); // earlier rank = better
    s += tldBonus(c.domain);
    if (c.titleMatch) s += 0.25;
    if (c.hits >= 2) s += 0.1; // showed up across variants/results
    c.score = Number(Math.min(1, s).toFixed(3));
  }
  return candidates.sort((a, b) => b.score - a.score);
}

/** Try www then apex; return the first base whose homepage responds < 400. */
async function verifyDomain(
  domain: string,
  name: string,
  fetcher: NonNullable<ResolveDeps['fetchHtml']>,
): Promise<{ ok: boolean; url: string; reason: string }> {
  const core = coreName(name);
  const kanji = longestKanjiRun(core);
  for (const base of [`https://www.${domain}`, `https://${domain}`]) {
    const page = await fetcher(base + '/');
    if (!page || page.status >= 400) continue;

    const $ = cheerio.load(page.html);
    const title = $('title').text();
    const text = $('body').text().replace(/[\s　]+/g, '');
    const head = `${title} ${$('meta[name="description"]').attr('content') || ''}`;

    // Parked / for-sale / placeholder pages are not a real corporate site.
    if (/このドメインは|お名前\.com|domain (is )?for sale|ドメイン(の販売|パーキング)|parked/i.test(head + text.slice(0, 400))) {
      return { ok: false, url: base, reason: 'parked/placeholder page' };
    }

    const nameHit = (!!core && (title.includes(core) || text.includes(core))) ||
      (!!kanji && kanji.length >= 2 && (title.includes(kanji) || text.includes(kanji)));
    const corporateHit = /会社概要|会社情報|企業情報|会社案内|プライバシーポリシー|個人情報|採用情報|事業内容|お問い?合わせ/.test(text);

    // Verification REQUIRES the company name on its own homepage. Corporate
    // signals (会社概要 …) appear on nearly every JP site, so they can't verify
    // a domain on their own — that would rubber-stamp the wrong company
    // (brand-safety: a wrong domain = wrong recipient). Corporate signals only
    // annotate the reason.
    if (nameHit) return { ok: true, url: base, reason: `name on homepage${corporateHit ? '+corporate signals' : ''}` };
    return { ok: false, url: base, reason: 'company name not found on homepage' };
  }
  return { ok: false, url: `https://${domain}`, reason: 'homepage did not respond' };
}

export interface ResolveOptions extends ResolveHints {
  /** How many top candidates to verify (fetch). Default 3. */
  maxVerify?: number;
}

/**
 * Resolve the official homepage for a company name. Returns the verified best
 * domain, or the top unverified candidate (method='search+unverified') when
 * nothing could be confirmed, or null when search found nothing usable.
 */
export async function resolveHomepage(
  name: string,
  opts: ResolveOptions = {},
  deps: ResolveDeps = {},
): Promise<HomepageResult | null> {
  const search = deps.search ?? ((q: string) => searchWeb(q));
  const fetcher = deps.fetchHtml ?? fetchHtml;
  const maxVerify = opts.maxVerify ?? 3;
  const queryDelayMs = deps.queryDelayMs ?? 1200;

  // Quote the name so a search engine must match it verbatim — an unquoted
  // "…会社概要" query lets engines drop the name and return generic "株式会社とは"
  // explainer pages (observed: mizuhobank/freee) that pollute the candidates.
  const q = `"${name}"`;
  const hint = [opts.prefecture, opts.industry].filter(Boolean).join(' ').trim();
  const variants = [
    `${q} 公式サイト`,
    hint ? `${q} ${hint}` : `${q} 会社概要`,
    q,
  ];

  // Eager verification: after EACH search variant, try to verify the current
  // top candidates. Easy companies (the majority) resolve on variant 1 with a
  // single search call — only the unresolved escalate to more searches. This
  // keeps throttle-prone search volume low while spending cheap company-site
  // fetches instead (those aren't rate-limited like the search engines).
  const all: SearchResult[] = [];
  const tried = new Set<string>();
  for (let vi = 0; vi < variants.length; vi++) {
    if (vi > 0 && queryDelayMs > 0) await new Promise((r) => setTimeout(r, queryDelayMs));
    const res = await search(variants[vi]).catch(() => [] as SearchResult[]);
    all.push(...res);

    const ranked = rankCandidates(all, name);
    for (const c of ranked.slice(0, maxVerify)) {
      if (tried.has(c.domain)) continue;
      tried.add(c.domain);
      const v = await verifyDomain(c.domain, name, fetcher);
      if (v.ok) {
        const confidence = Number(Math.min(0.95, c.score + 0.1).toFixed(3));
        log.info(`${name} -> ${c.domain} (verified, conf=${confidence}; ${v.reason})`);
        return {
          domain: c.domain,
          url: v.url,
          confidence,
          method: 'search+verified',
          evidence: `search hit; ${v.reason}`,
          alternatives: rankCandidates(all, name).slice(0, 6).map((x) => x.domain).filter((d) => d !== c.domain),
        };
      }
    }
  }

  const candidates = rankCandidates(all, name);
  if (candidates.length === 0) {
    log.info(`${name} -> no usable candidate`);
    return null;
  }
  const alternatives = candidates.slice(0, 6).map((c) => c.domain);

  // Nothing verified. Only surface an unverified GUESS when a candidate's search
  // title actually contained the company name — otherwise the search simply
  // failed (throttle / no index hit) and returning a random top domain (e.g. a
  // bank's "株式会社とは" page) is worse than an honest "not found".
  const top = candidates.find((c) => c.titleMatch);
  if (!top) {
    log.info(`${name} -> no name-matching candidate (not found)`);
    return null;
  }
  const confidence = Number((top.score * 0.5).toFixed(3));
  log.info(`${name} -> ${top.domain} (UNVERIFIED, conf=${confidence})`);
  return {
    domain: top.domain,
    url: `https://${top.domain}`,
    confidence,
    method: 'search+unverified',
    evidence: 'search title matched name; homepage not verified',
    alternatives: alternatives.filter((d) => d !== top.domain),
  };
}
