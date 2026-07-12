import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { baseUrl, normalizeDomain, resolveUrl, sameSite } from '../utils/url.js';
import { BrowserSession } from '../browser/browser.js';
import { extractFields } from '../browser/extract.js';
import { logger } from '../utils/logger.js';

const log = logger('L1');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 1. Common contact paths, cheapest first (spec §4-L1 step 1). */
const COMMON_PATHS = [
  '/contact', '/contact/', '/contact-us', '/contact-us/', '/inquiry', '/inquiry/',
  '/otoiawase', '/toiawase', '/otoiawase/', '/form', '/form/', '/contact.html',
  '/inquiry.html', '/support/contact', '/company/contact', '/contact/form/', '/contact/form',
];

/** 2. Link text signals to follow from the homepage. */
const LINK_SIGNALS = [
  'お問い合わせ', 'お問合せ', '問合せ', 'お問い合せ', 'コンタクト', 'contact',
  'inquiry', 'ご相談', 'お見積', '資料請求', 'デモ', 'お申し込み',
];

const CONTACTISH = /contact|inquiry|toiawase|otoiawase|form|soudan|shiryou|entry|demo/i;

export type DiscoveryMethod = 'common_path' | 'link_scan' | 'sitemap' | 'browser_render' | 'none';

export interface DiscoveryResult {
  formUrl: string | null;
  confidence: number; // 0..1
  method: DiscoveryMethod;
}

interface FetchedPage {
  url: string;
  status: number;
  html: string;
}

async function fetchPage(url: string, timeoutMs = 12000): Promise<FetchedPage | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    const html = await res.text();
    return { url: res.url || url, status: res.status, html };
  } catch (e) {
    log.debug(`fetch failed ${url}: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

interface FormSignals {
  hasForm: boolean;
  hasTextarea: boolean;
  fillableCount: number; // text/email/tel/textarea/select inputs (excludes hidden/search/submit)
}

/** Static (cheerio) form signal count for the largest form on the page. */
function staticFormSignals(html: string): FormSignals {
  const $ = cheerio.load(html);
  const forms = $('form');
  if (forms.length === 0) return { hasForm: false, hasTextarea: false, fillableCount: 0 };
  let best = { hasForm: true, hasTextarea: false, fillableCount: 0 };
  forms.each((_, el) => {
    const $f = $(el);
    const textareas = $f.find('textarea').length;
    let fillable = textareas;
    $f.find('input').each((__, inp) => {
      const type = ($(inp).attr('type') || 'text').toLowerCase();
      if (['text', 'email', 'tel', 'url', 'number'].includes(type)) fillable++;
    });
    fillable += $f.find('select').length;
    if (fillable > best.fillableCount) {
      best = { hasForm: true, hasTextarea: textareas > 0, fillableCount: fillable };
    }
  });
  return best;
}

/** Is this a real contact form (not a lone search/newsletter box)? */
function looksLikeContactForm(s: FormSignals): boolean {
  if (!s.hasForm) return false;
  return s.hasTextarea || s.fillableCount >= 3;
}

function scoreForm(url: string, s: FormSignals, method: DiscoveryMethod): number {
  let score = 0.4;
  if (s.hasTextarea) score += 0.3;
  if (s.fillableCount >= 4) score += 0.1;
  if (CONTACTISH.test(url)) score += 0.12;
  if (method === 'common_path') score += 0.08;
  else if (method === 'browser_render') score += 0.05;
  return Math.min(1, Number(score.toFixed(3)));
}

/**
 * Resolve the working https base for a domain. Corporate sites frequently serve
 * only on `www.` (the apex doesn't resolve or its TLS cert is www-only), so try
 * `https://www.<d>` first, then the apex. Returns the first base whose homepage
 * responds < 400; falls back to the apex when neither responds.
 */
async function resolveBase(domain: string): Promise<string> {
  const norm = normalizeDomain(domain);
  for (const base of [`https://www.${norm}`, `https://${norm}`]) {
    const home = await fetchPage(base + '/');
    if (home && home.status < 400) return base;
  }
  return baseUrl(domain);
}

/** Collect contact-ish candidate URLs (200 OK) from all static stages. */
async function collectCandidates(domain: string, base: string): Promise<{ url: string; page: FetchedPage; method: DiscoveryMethod }[]> {
  const seen = new Set<string>();
  const out: { url: string; page: FetchedPage; method: DiscoveryMethod }[] = [];

  const add = async (url: string, method: DiscoveryMethod) => {
    if (seen.has(url)) return;
    seen.add(url);
    const page = await fetchPage(url);
    if (page && page.status < 400) out.push({ url: page.url, page, method });
  };

  // 1. common paths
  for (const p of COMMON_PATHS) await add(base + p, 'common_path');

  // 2. homepage link scan
  const home = await fetchPage(base);
  if (home) {
    const $ = cheerio.load(home.html);
    const links: string[] = [];
    $('a[href]').each((_, el) => {
      const text = `${$(el).text()} ${$(el).attr('title') || ''} ${$(el).attr('aria-label') || ''}`.toLowerCase();
      const href = $(el).attr('href') || '';
      if (LINK_SIGNALS.some((s) => text.includes(s.toLowerCase()) || href.toLowerCase().includes(s.toLowerCase()))) {
        const abs = resolveUrl(href, home.url);
        if (abs && sameSite(abs, domain) && !links.includes(abs)) links.push(abs);
      }
    });
    for (const u of links.slice(0, 8)) await add(u, 'link_scan');
  }

  // 3. sitemap
  const sm = await fetchPage(`${base}/sitemap.xml`);
  if (sm && sm.status < 400) {
    try {
      const parser = new XMLParser({ ignoreAttributes: false });
      const doc = parser.parse(sm.html);
      const locs: string[] = [];
      const collect = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) node.forEach(collect);
        else if (typeof node === 'object') {
          if (typeof node.loc === 'string') locs.push(node.loc);
          Object.values(node).forEach(collect);
        }
      };
      collect(doc);
      for (const u of locs.filter((x) => CONTACTISH.test(x) && sameSite(x, domain)).slice(0, 6)) {
        await add(u, 'sitemap');
      }
    } catch { /* ignore malformed sitemap */ }
  }

  return out;
}

/** Browser-render a candidate URL and check for a real form (catches SPA/JS forms). */
async function browserConfirm(urls: string[]): Promise<DiscoveryResult | null> {
  if (urls.length === 0) return null;
  const session = new BrowserSession({ seed: 7 });
  try {
    const page = await session.open();
    for (const url of urls.slice(0, 3)) {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
        const fields = await extractFields(page);
        const fillable = fields.filter((f) => !f.honeypot && (f.type || '') !== 'hidden');
        const hasTextarea = fillable.some((f) => f.tag === 'textarea');
        const signals: FormSignals = {
          hasForm: fillable.length > 0,
          hasTextarea,
          fillableCount: fillable.length,
        };
        if (looksLikeContactForm(signals)) {
          const finalUrl = page.url();
          return { formUrl: finalUrl, confidence: scoreForm(finalUrl, signals, 'browser_render'), method: 'browser_render' };
        }
      } catch (e) {
        log.debug(`browser render failed ${url}: ${(e as Error).message}`);
      }
    }
    return null;
  } finally {
    await session.close();
  }
}

export interface DiscoverOptions {
  /** Enable the (expensive) Playwright render fallback for SPA forms. Default true. */
  browserFallback?: boolean;
}

/**
 * L1 — discover the contact form URL for a domain (spec §4-L1). Static, cost-
 * ordered candidate collection first; confirms the cheapest passing candidate.
 * Falls back to a Playwright render pass for JS/SPA forms that static fetch
 * cannot see. Returns formUrl=null (FORM_NOT_FOUND) as an expected outcome.
 */
export async function discoverForm(domain: string, opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const base = await resolveBase(domain);
  const candidates = await collectCandidates(domain, base);

  // Static confirmation, preferring cheaper methods and stronger signals.
  const order: DiscoveryMethod[] = ['common_path', 'link_scan', 'sitemap'];
  let best: DiscoveryResult | null = null;
  for (const c of candidates) {
    const s = staticFormSignals(c.page.html);
    if (!looksLikeContactForm(s)) continue;
    const conf = scoreForm(c.url, s, c.method);
    if (!best || conf > best.confidence || order.indexOf(c.method) < order.indexOf(best.method)) {
      best = { formUrl: c.url, confidence: conf, method: c.method };
    }
  }
  if (best) {
    log.info(`${domain} -> ${best.formUrl} (${best.method}, conf=${best.confidence})`);
    return best;
  }

  // Browser fallback on the most contact-ish candidates (SPA forms live here).
  if (opts.browserFallback !== false) {
    let targets = candidates.map((c) => c.url).filter((u) => CONTACTISH.test(u));
    if (targets.length === 0) targets = candidates.map((c) => c.url);
    // If static fetch was fully blocked (no candidates at all, e.g. bot-walled
    // sites), still try rendering the common contact paths with a real browser.
    if (targets.length === 0) {
      targets = ['/contact/', '/contact', '/inquiry/', '/otoiawase/', '/'].map((p) => base + p);
    }
    const rendered = await browserConfirm(targets);
    if (rendered) {
      log.info(`${domain} -> ${rendered.formUrl} (browser_render, conf=${rendered.confidence})`);
      return rendered;
    }
  }

  log.info(`${domain} -> FORM_NOT_FOUND`);
  return { formUrl: null, confidence: 0, method: 'none' };
}
