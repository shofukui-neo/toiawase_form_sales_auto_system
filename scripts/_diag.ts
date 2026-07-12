/**
 * Diagnostic for FORM_NOT_FOUND companies. For each domain:
 *  - fetch homepage (report HTTP status / block)
 *  - list contact-ish links found on homepage
 *  - browser-render top candidate contact pages and report field + iframe counts
 * Read-only. No DB writes, no sends.
 */
import * as cheerio from 'cheerio';
import { baseUrl, resolveUrl, sameSite } from '../src/utils/url.js';
import { BrowserSession } from '../src/browser/browser.js';
import { extractFields } from '../src/browser/extract.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DOMAINS = process.argv.slice(2);

async function fetchStatus(url: string): Promise<{ status: number; html: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
    const html = await res.text();
    return { status: res.status, html };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const session = new BrowserSession({ seed: 7 });
  const page = await session.open();
  for (const domain of DOMAINS) {
    console.log(`\n================ ${domain} ================`);
    const base = baseUrl(domain);
    const home = await fetchStatus(base);
    console.log(`homepage static fetch: ${home ? 'HTTP ' + home.status + ' (' + home.html.length + ' bytes)' : 'FAILED/timeout'}`);
    const candidates: string[] = [];
    if (home && home.status < 400) {
      const $ = cheerio.load(home.html);
      $('a[href]').each((_, el) => {
        const text = `${$(el).text()} ${$(el).attr('title') || ''} ${$(el).attr('aria-label') || ''}`.toLowerCase();
        const href = $(el).attr('href') || '';
        if (/問い?合|問合|contact|inquiry|toiawase|相談|見積|資料|お申|entry|support/i.test(text + ' ' + href)) {
          const abs = resolveUrl(href, base);
          if (abs && sameSite(abs, domain) && !candidates.includes(abs)) candidates.push(abs);
        }
      });
    }
    // also try common paths via browser
    for (const p of ['/contact/', '/contact', '/inquiry/', '/otoiawase/', '/toiawase/']) {
      const u = base + p;
      if (!candidates.includes(u)) candidates.push(u);
    }
    console.log(`candidate contact URLs (${candidates.length}):`);
    for (const u of candidates.slice(0, 12)) console.log('   ' + u);

    // browser-render top candidates
    for (const url of candidates.slice(0, 6)) {
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
        const status = resp ? resp.status() : 0;
        const fields = await extractFields(page);
        const fillable = fields.filter((f) => !f.honeypot && (f.type || '') !== 'hidden');
        const textareas = fillable.filter((f) => f.tag === 'textarea').length;
        const iframes = await page.$$eval('iframe', (els) => els.map((e) => (e as HTMLIFrameElement).src).filter(Boolean));
        const crossIframes = iframes.filter((s) => /hsforms|hubspot|marketo|mktoweb|typeform|google\.com\/forms|formrun|tayori|shanon/i.test(s));
        console.log(`   [${status}] ${page.url()}  fillable=${fillable.length} textarea=${textareas}` +
          (crossIframes.length ? `  <<embedded-form-iframe: ${crossIframes.slice(0,2).join(', ')}>>` : (iframes.length ? `  iframes=${iframes.length}` : '')));
      } catch (e) {
        console.log(`   [ERR] ${url}  ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }
  await session.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
