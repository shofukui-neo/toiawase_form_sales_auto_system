import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { baseUrl, resolveUrl, sameSite } from '../utils/url.js';
import { logger } from '../utils/logger.js';

const log = logger('L1');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 1. Common contact paths, cheapest first (spec §4-L1 step 1). */
const COMMON_PATHS = [
  '/contact',
  '/contact/',
  '/contact-us',
  '/contact-us/',
  '/inquiry',
  '/inquiry/',
  '/otoiawase',
  '/toiawase',
  '/otoiawase/',
  '/form',
  '/form/',
  '/contact.html',
  '/inquiry.html',
  '/support/contact',
  '/company/contact',
];

/** 2. Link text signals to follow from the homepage. */
const LINK_SIGNALS = [
  'お問い合わせ',
  'お問合せ',
  '問合せ',
  'お問い合せ',
  'コンタクト',
  'contact',
  'inquiry',
  'ご相談',
  'お見積',
  '資料請求',
];

export type DiscoveryMethod = 'common_path' | 'link_scan' | 'sitemap' | 'none';

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
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html') && !ct.includes('xml')) {
      // Still return for sitemap xml callers; they pass through.
    }
    const html = await res.text();
    return { url: res.url || url, status: res.status, html };
  } catch (e) {
    log.debug(`fetch failed ${url}: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** True when the HTML contains a real form with a message-like textarea (spec §4-L1 step 4). */
function hasRealForm(html: string): { form: boolean; textarea: boolean } {
  const $ = cheerio.load(html);
  const forms = $('form');
  let hasTextarea = false;
  forms.each((_, el) => {
    if ($(el).find('textarea').length > 0) hasTextarea = true;
  });
  return { form: forms.length > 0, textarea: hasTextarea };
}

/** Confidence heuristic for a confirmed form page. */
function scoreForm(url: string, real: { form: boolean; textarea: boolean }, method: DiscoveryMethod): number {
  let s = 0;
  if (real.form) s += 0.5;
  if (real.textarea) s += 0.3;
  if (/contact|inquiry|toiawase|otoiawase|form/i.test(url)) s += 0.1;
  if (method === 'common_path') s += 0.1;
  else if (method === 'link_scan') s += 0.05;
  return Math.min(1, Number(s.toFixed(3)));
}

async function tryCommonPaths(domain: string): Promise<DiscoveryResult | null> {
  const base = baseUrl(domain);
  for (const p of COMMON_PATHS) {
    const url = base + p;
    const page = await fetchPage(url);
    if (!page || page.status >= 400) continue;
    const real = hasRealForm(page.html);
    if (real.form && real.textarea) {
      return { formUrl: page.url, confidence: scoreForm(page.url, real, 'common_path'), method: 'common_path' };
    }
  }
  return null;
}

async function tryLinkScan(domain: string): Promise<DiscoveryResult | null> {
  const base = baseUrl(domain);
  const home = await fetchPage(base);
  if (!home) return null;
  const $ = cheerio.load(home.html);
  const candidates: string[] = [];
  $('a[href]').each((_, el) => {
    const text = ($(el).text() || '') + ' ' + ($(el).attr('title') || '') + ' ' + ($(el).attr('aria-label') || '');
    const href = $(el).attr('href') || '';
    const matches = LINK_SIGNALS.some((sig) => text.toLowerCase().includes(sig.toLowerCase()) || href.toLowerCase().includes(sig.toLowerCase()));
    if (!matches) return;
    const abs = resolveUrl(href, home.url);
    if (abs && sameSite(abs, domain) && !candidates.includes(abs)) candidates.push(abs);
  });

  for (const url of candidates.slice(0, 8)) {
    const page = await fetchPage(url);
    if (!page || page.status >= 400) continue;
    const real = hasRealForm(page.html);
    if (real.form && real.textarea) {
      return { formUrl: page.url, confidence: scoreForm(page.url, real, 'link_scan'), method: 'link_scan' };
    }
  }
  return null;
}

async function trySitemap(domain: string): Promise<DiscoveryResult | null> {
  const base = baseUrl(domain);
  const sm = await fetchPage(`${base}/sitemap.xml`);
  if (!sm || sm.status >= 400) return null;
  let urls: string[] = [];
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
    urls = locs;
  } catch {
    return null;
  }
  const contactish = urls.filter((u) => /contact|inquiry|toiawase|otoiawase|form/i.test(u)).slice(0, 8);
  for (const url of contactish) {
    if (!sameSite(url, domain)) continue;
    const page = await fetchPage(url);
    if (!page || page.status >= 400) continue;
    const real = hasRealForm(page.html);
    if (real.form && real.textarea) {
      return { formUrl: page.url, confidence: scoreForm(page.url, real, 'sitemap'), method: 'sitemap' };
    }
  }
  return null;
}

/**
 * L1 — discover the contact form URL for a domain. Staged, cost-ordered; stops
 * at the first confirmed form (spec §4-L1). Returns FORM_NOT_FOUND-equivalent
 * (formUrl null) when nothing is confirmed — an expected, non-error outcome.
 */
export async function discoverForm(domain: string): Promise<DiscoveryResult> {
  for (const stage of [tryCommonPaths, tryLinkScan, trySitemap]) {
    const r = await stage(domain);
    if (r) {
      log.info(`${domain} -> ${r.formUrl} (${r.method}, conf=${r.confidence})`);
      return r;
    }
  }
  log.info(`${domain} -> FORM_NOT_FOUND`);
  return { formUrl: null, confidence: 0, method: 'none' };
}
