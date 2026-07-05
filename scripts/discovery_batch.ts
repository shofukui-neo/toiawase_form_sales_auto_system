/**
 * B — real L1 discovery batch. Runs discoverForm() against a list of actual
 * domains (from CLI args or a file), with bounded concurrency, and prints a
 * results table. Optionally ingests results into the DB (--ingest).
 *
 * Usage:
 *   npm run discover-batch -- mochica.jp en-japan.com ...
 *   npm run discover-batch -- --file domains.txt
 *   npm run discover-batch -- --file domains.txt --ingest --concurrency 4
 */
import { readFileSync } from 'node:fs';
import { discoverForm, type DiscoveryResult } from '../src/layers/l1_discovery.js';
import { normalizeDomain } from '../src/utils/url.js';

interface Row {
  domain: string;
  result: DiscoveryResult;
  ms: number;
  error?: string;
}

function parseArgs(argv: string[]): { domains: string[]; ingest: boolean; concurrency: number } {
  const domains: string[] = [];
  let ingest = false;
  let concurrency = 4;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') {
      const path = argv[++i];
      const text = readFileSync(path, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const d = line.split(',')[0].trim();
        if (d && !d.startsWith('#')) domains.push(d);
      }
    } else if (a === '--ingest') ingest = true;
    else if (a === '--concurrency') concurrency = Number(argv[++i]) || 4;
    else if (!a.startsWith('--')) domains.push(a);
  }
  return { domains: domains.map(normalizeDomain).filter(Boolean), ingest, concurrency };
}

/** Simple bounded-concurrency map. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  const { domains, ingest, concurrency } = parseArgs(process.argv.slice(2));
  if (domains.length === 0) {
    console.error('No domains. Pass domains as args or --file <path>.');
    process.exit(1);
  }
  console.log(`Discovering ${domains.length} domain(s), concurrency=${concurrency}, ingest=${ingest}\n`);

  const start = Date.now();
  const rows = await mapLimit(domains, concurrency, async (domain): Promise<Row> => {
    const t0 = Date.now();
    try {
      const result = await discoverForm(domain);
      return { domain, result, ms: Date.now() - t0 };
    } catch (e) {
      return {
        domain,
        result: { formUrl: null, confidence: 0, method: 'none' },
        ms: Date.now() - t0,
        error: (e as Error).message,
      };
    }
  });

  // ---- table ----
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  console.log(pad('DOMAIN', 28) + pad('METHOD', 13) + pad('CONF', 6) + pad('MS', 7) + 'FORM URL');
  console.log('-'.repeat(100));
  let found = 0;
  for (const r of rows) {
    if (r.result.formUrl) found++;
    console.log(
      pad(r.domain, 28) +
        pad(r.error ? 'ERROR' : r.result.method, 13) +
        pad(r.result.confidence.toFixed(2), 6) +
        pad(String(r.ms), 7) +
        (r.error ? `(${r.error})` : r.result.formUrl ?? 'FORM_NOT_FOUND'),
    );
  }
  console.log('-'.repeat(100));
  const rate = ((found / domains.length) * 100).toFixed(0);
  console.log(
    `\nFound ${found}/${domains.length} (発見率 ${rate}%) in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );

  // ---- optional ingest into DB (feeds the pipeline) ----
  if (ingest) {
    const { companies } = await import('../src/db/repositories.js');
    const { transition } = await import('../src/core/stateMachine.js');
    for (const r of rows) {
      const c = companies.upsert({ name: r.domain, domain: r.domain, source: 'discover-batch' });
      if (r.result.formUrl) {
        companies.setForm(c.id, r.result.formUrl, r.result.confidence);
        try {
          transition(c.id, 'DISCOVERING');
          transition(c.id, 'FORM_FOUND', { detail: r.result.method });
        } catch { /* already advanced */ }
      } else {
        try {
          transition(c.id, 'DISCOVERING');
          transition(c.id, 'FORM_NOT_FOUND');
        } catch { /* already terminal */ }
      }
    }
    console.log(`\nIngested ${rows.length} companies into DB.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
