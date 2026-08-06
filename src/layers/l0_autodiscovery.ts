import { readFileSync } from 'node:fs';
import { IngestRow, ingestRows } from './l0_list.js';
import { searchWeb, type SearchResult } from './websearch.js';
import { candidateDomain, isBlockedDomain } from './l0_homepage.js';

const DEFAULT_PREFECTURES = ['東京都', '大阪府', '愛知県'];
const DEFAULT_INDUSTRIES = ['介護', '建設', '物流', '小売', '製造', 'IT', '不動産', '金融'];
const GENERIC_TITLE_RE = /^(?:公式サイト|公式ホームページ|会社概要|お問い合わせ|採用情報|トップページ|ホームページ|サービス|事業内容|お知らせ|サイト|公式)$/i;
const COMPANY_NAME_CLEAN_RE = /(?:公式サイト|公式ホームページ|ホームページ|会社概要|お問い合わせ|採用情報|トップページ|事業内容|お知らせ|公式|サイト)/gi;

export interface SearchDiscoveryOptions {
  /** Raw search phrases to use instead of industry/prefecture seeds. */
  queries?: string[];
  industries?: string[];
  prefectures?: string[];
  maxResultsPerQuery?: number;
  maxCompanies?: number;
  queryDelayMs?: number;
}

export interface SearchDiscoveryDeps {
  search?: (query: string) => Promise<SearchResult[]>;
}

interface QueryDef {
  query: string;
  industry?: string;
  prefecture?: string;
}

interface SearchCandidate {
  name: string;
  domain: string;
  source: string;
  industry?: string;
  prefecture?: string;
  score: number;
  queries: string[];
  sampleUrl: string;
  title: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeQueryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function buildQueries(opts: SearchDiscoveryOptions): QueryDef[] {
  const industries = opts.industries?.map((i) => i.trim()).filter(Boolean) ?? DEFAULT_INDUSTRIES;
  const prefectures = opts.prefectures?.map((p) => p.trim()).filter(Boolean) ?? DEFAULT_PREFECTURES;
  const queries: QueryDef[] = [];

  for (const industry of industries) {
    if (prefectures.length === 0) {
      queries.push({ query: `${industry} 公式サイト`, industry });
      queries.push({ query: `${industry} 会社概要`, industry });
    } else {
      for (const prefecture of prefectures) {
        queries.push({ query: `${industry} ${prefecture} 公式サイト`, industry, prefecture });
        queries.push({ query: `${industry} ${prefecture} 会社概要`, industry, prefecture });
      }
    }
  }
  return queries;
}

export function extractCompanyNameFromTitle(title: string, fallback: string): string {
  const trimmed = title.trim();
  if (!trimmed) return fallback;

  const raw = trimmed.replace(COMPANY_NAME_CLEAN_RE, '').replace(/【.*?】/g, '').trim();
  const parts = raw.split(/\s*[｜|\-–—:：]\s*/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    if (!GENERIC_TITLE_RE.test(part) && part.length >= 2) return part;
  }
  if (parts.length > 0) return parts[0];
  return fallback;
}

function scoreResult(result: SearchResult, rank: number, industry?: string, prefecture?: string): number {
  let score = 0.4;
  score += Math.max(0, 0.24 - rank * 0.04);
  if (/公式サイト|公式ホームページ|会社概要|会社概要/.test(result.title)) score += 0.16;
  if (industry && result.title.includes(industry)) score += 0.08;
  if (prefecture && result.title.includes(prefecture)) score += 0.04;
  if (/\/(?:index\.|$)/i.test(result.url)) score += 0.04;
  if (/株式会社|有限会社|合同会社|社団法人|協同組合|医療法人/.test(result.title)) score += 0.04;
  return Number(Math.min(1, score).toFixed(3));
}

function extractHost(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

export async function discoverCompanyRows(
  opts: SearchDiscoveryOptions = {},
  deps: SearchDiscoveryDeps = {},
): Promise<IngestRow[]> {
  const queries: QueryDef[] = opts.queries && opts.queries.length
    ? opts.queries.map((q) => ({ query: normalizeQueryText(q), industry: undefined, prefecture: undefined }))
    : buildQueries(opts);
  const search = deps.search ?? ((query: string) => searchWeb(query, { minResults: 5, delayMs: 800 }));
  const delayMs = opts.queryDelayMs ?? 1200;
  const maxResultsPerQuery = opts.maxResultsPerQuery ?? 5;
  const maxCompanies = opts.maxCompanies ?? 200;

  const candidates = new Map<string, SearchCandidate>();

  for (const { query, industry, prefecture } of queries) {
    if (!query) continue;
    if (delayMs > 0) await sleep(delayMs);
    const results = await search(query).catch(() => [] as SearchResult[]);

    for (let rank = 0; rank < Math.min(results.length, maxResultsPerQuery); rank++) {
      const result = results[rank];
      const host = extractHost(result.url);
      if (!host) continue;
      const blocked = isBlockedDomain(host);
      if (blocked) continue;
      const domain = candidateDomain(host);
      if (!domain || domain.split('.').length < 2) continue;

      const title = result.title || domain;
      const name = extractCompanyNameFromTitle(title, domain);
      const score = scoreResult(result, rank, industry, prefecture);
      const source = `search:${query}`;
      const existing = candidates.get(domain);
      if (existing) {
        existing.queries = Array.from(new Set([...existing.queries, query]));
        if (score > existing.score) {
          existing.score = score;
          existing.name = name;
          existing.title = title;
          existing.source = source;
          existing.industry = industry ?? existing.industry;
          existing.prefecture = prefecture ?? existing.prefecture;
          existing.sampleUrl = result.url;
        }
        continue;
      }

      candidates.set(domain, {
        name,
        domain,
        source,
        industry,
        prefecture,
        score,
        queries: [query],
        sampleUrl: result.url,
        title,
      });
    }
  }

  const rows: IngestRow[] = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCompanies)
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      industry: c.industry,
      prefecture: c.prefecture,
      source: 'search_discovery',
    }));

  return rows;
}

export async function discoverAndIngestCompanyRows(
  opts: SearchDiscoveryOptions = {},
  deps: SearchDiscoveryDeps = {},
) {
  const rows = await discoverCompanyRows(opts, deps);
  const result = ingestRows(rows);
  return { rows, result };
}

export async function discoverQueriesFromFile(path: string): Promise<string[]> {
  const text = readFileSync(path, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
