import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

/**
 * Minimal web-search backend for L0 homepage resolution (§4-L0 拡張).
 *
 * The spec assumes the input list already carries an HP URL. To let the pipeline
 * accept *name-only* lists ("企業HPも勝手に探して"), we resolve the official
 * homepage from a plain keyword search. No paid API / key is required: we scrape
 * the HTML endpoints of DuckDuckGo (html + lite) and fall back to Bing. Each
 * provider is a pure `(query) => results` function so tests can inject a fake.
 */

const log = logger('websearch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A search backend: takes a query, returns ranked organic results. */
export type SearchProvider = (query: string) => Promise<SearchResult[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string, timeoutMs = 12000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.8',
      },
    });
    if (res.status >= 400) return null;
    return await res.text();
  } catch (e) {
    log.debug(`fetch failed ${url}: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** DuckDuckGo wraps outbound links in a redirect carrying the real URL in `uddg`. */
function decodeDdgHref(href: string): string | null {
  try {
    let h = href;
    if (h.startsWith('//')) h = 'https:' + h;
    const u = new URL(h, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (/^https?:/i.test(h)) return h;
    return null;
  } catch {
    return null;
  }
}

/** DuckDuckGo HTML endpoint (richest, but occasionally rate-limits). */
export const duckduckgoHtml: SearchProvider = async (query) => {
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query));
  if (!html) return [];
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  $('div.result, div.web-result').each((_, el) => {
    const a = $(el).find('a.result__a').first();
    const url = decodeDdgHref(a.attr('href') || '');
    if (!url) return;
    out.push({
      title: a.text().trim(),
      url,
      snippet: $(el).find('.result__snippet').first().text().trim(),
    });
  });
  return out;
};

/** DuckDuckGo lite endpoint — plainer HTML, a good fallback when html/ throttles. */
export const duckduckgoLite: SearchProvider = async (query) => {
  const html = await fetchText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query));
  if (!html) return [];
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  $('a.result-link').each((_, el) => {
    const url = decodeDdgHref($(el).attr('href') || '');
    if (!url) return;
    out.push({ title: $(el).text().trim(), url, snippet: '' });
  });
  return out;
};

/** Bing wraps organic links in a /ck/a redirect carrying the real URL (base64) in `u`. */
function decodeBingHref(href: string): string | null {
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (/(^|\.)bing\.com$/.test(u.hostname) || u.pathname.startsWith('/ck/')) {
      const uu = u.searchParams.get('u');
      if (!uu) return null; // internal bing link (login/maps/etc.) — not a result
      let b = uu.startsWith('a1') ? uu.slice(2) : uu;
      b = b.replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const decoded = Buffer.from(b, 'base64').toString('utf8');
      return /^https?:/i.test(decoded) ? decoded : null;
    }
    return /^https?:/i.test(href) ? href : null;
  } catch {
    return null;
  }
}

/** Bing HTML — independent index, used as a last resort. */
export const bing: SearchProvider = async (query) => {
  const html = await fetchText('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=ja');
  if (!html) return [];
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  $('li.b_algo').each((_, el) => {
    const a = $(el).find('h2 a').first();
    const url = decodeBingHref(a.attr('href') || '');
    if (!url) return;
    out.push({
      title: a.text().trim(),
      url,
      snippet: $(el).find('.b_caption p').first().text().trim(),
    });
  });
  return out;
};

/** Default provider chain, cheapest/most-reliable first. */
export const DEFAULT_PROVIDERS: SearchProvider[] = [duckduckgoHtml, duckduckgoLite, bing];

export interface SearchOptions {
  /** Provider chain to try in order. Defaults to DEFAULT_PROVIDERS. */
  providers?: SearchProvider[];
  /** Stop as soon as a provider returns at least this many results. Default 3. */
  minResults?: number;
  /** Delay between provider attempts (ms) to be polite / dodge throttling. Default 800. */
  delayMs?: number;
}

/**
 * Run a query through the provider chain until one yields enough results.
 * Returns the merged results (deduped by URL) from the first productive
 * provider, or [] if every backend was empty/blocked.
 */
export async function searchWeb(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const providers = opts.providers ?? DEFAULT_PROVIDERS;
  const minResults = opts.minResults ?? 3;
  const delayMs = opts.delayMs ?? 800;

  for (let i = 0; i < providers.length; i++) {
    try {
      const results = await providers[i](query);
      const deduped = dedupeByUrl(results);
      if (deduped.length >= minResults) {
        log.debug(`provider#${i} answered "${query}" with ${deduped.length}`);
        return deduped;
      }
      if (deduped.length > 0 && i === providers.length - 1) return deduped;
    } catch (e) {
      log.debug(`provider#${i} threw: ${(e as Error).message}`);
    }
    if (i < providers.length - 1) await sleep(delayMs);
  }
  return [];
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
