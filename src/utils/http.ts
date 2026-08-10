/**
 * Shared HTTP client for the crawler (L0 search / L0 HP verification / L1 form
 * discovery). One place owns the network stack, because *which* undici runs our
 * requests decides whether a broken third-party site can kill the process.
 *
 * The bug this exists for: undici ≤ 7 crashes the whole Node process when a peer
 * ends the connection while the HTTP/1.1 body parser is paused by backpressure —
 * `Parser.finish()` runs `assert(!this.paused)` and throws from the socket's
 * 'end' listener, outside any promise, so no `try/catch` around `fetch()` sees
 * it. Observed mid-batch during HP resolution (`AssertionError [ERR_ASSERTION]`
 * at `client-h1.js` → `onHttpSocketEnd`). undici 8 drains the paused parser at
 * EOF instead of asserting, so we depend on it directly and route through it:
 *
 *   - `setGlobalDispatcher()` moves *every* fetch in the process — ours plus the
 *     Anthropic / googleapis SDKs, which use the global `fetch` — onto the fixed
 *     v8 pool, instead of the older undici Node bundles.
 *   - cheerio is imported as `cheerio/slim` throughout, so it no longer pulls in
 *     its own undici copy; importing plain `cheerio` silently installed *that*
 *     Agent as the process-wide dispatcher (the undici 7.x in the crash trace).
 */
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { installCrashGuard } from './crash_guard.js';
import { logger } from './logger.js';

const log = logger('http');

/**
 * Crawler-tuned pool: company sites are slow, and half of the interesting ones
 * are misconfigured. Bounded timeouts keep a dead host from parking a worker.
 */
export const crawlerAgent = new Agent({
  connect: { timeout: 10_000 },
  headersTimeout: 15_000,
  bodyTimeout: 15_000,
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 10_000,
});
setGlobalDispatcher(crawlerAgent);

// Belt and braces: the undici bump removes the assertion we hit, but a crawler
// must not die on the next parser edge case some server finds for us.
installCrashGuard();

export const CRAWLER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface FetchedPage {
  status: number;
  html: string;
  /** URL after redirects (falls back to the requested URL). */
  finalUrl: string;
}

export interface FetchPageOptions {
  /** Wall-clock budget for connect + headers + body. Default 12s. */
  timeoutMs?: number;
  /** Extra request headers, merged over the crawler defaults. */
  headers?: Record<string, string>;
}

/**
 * GET a page as text. Returns null on any transport failure (DNS, TLS, timeout,
 * reset) — callers treat "no page" and "bad page" the same way, and a crawl must
 * never throw on a single unreachable host.
 */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchedPage | null> {
  const { timeoutMs = 12_000, headers = {} } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': CRAWLER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.8',
        ...headers,
      },
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
