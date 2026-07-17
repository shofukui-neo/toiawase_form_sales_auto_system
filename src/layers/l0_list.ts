import { readFileSync } from 'node:fs';
import { companies, suppression, audit } from '../db/repositories.js';
import { transition } from '../core/stateMachine.js';
import { loadIcp, type IcpConfig } from '../config.js';
import { normalizeDomain } from '../utils/url.js';
import { resolveHomepage } from './l0_homepage.js';
import { logger } from '../utils/logger.js';

const log = logger('L0');

/**
 * L0 — ICP list ingest (spec §4-L0).
 *
 * The spec says input is only [company name, HP URL]; richer ICP enrichment
 * (gBizINFO / 法人番号API / 求人媒体) is delegated to the existing Trinity-GAS
 * asset and fed in as extra CSV columns when available. So this layer:
 *   - parses a CSV,
 *   - scores each row against the ICP config with whatever columns exist,
 *   - upserts into `companies`,
 *   - hard-suppresses obvious competitors/excludes.
 */

export interface IngestRow {
  name: string;
  domain: string;
  industry?: string;
  employees?: number;
  source?: string;
  /** Prefecture / region hint (not scored; used to disambiguate HP search). */
  prefecture?: string;
}

export interface IngestResult {
  ingested: number;
  suppressed: number;
  skipped: number;
}

/** Minimal CSV parser (handles quoted fields + commas inside quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Map header names (JP or EN) to canonical column keys. */
function headerIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    const k = h.trim().toLowerCase();
    if (/name|会社|企業|法人/.test(k)) idx.name ??= i;
    if (/domain|url|ドメイン|hp|ホームページ/.test(k)) idx.domain ??= i;
    if (/industry|業界|業種/.test(k)) idx.industry ??= i;
    if (/employee|従業員|規模|人数/.test(k)) idx.employees ??= i;
    if (/source|ソース|媒体|出典/.test(k)) idx.source ??= i;
    if (/pref|prefecture|都道府県|所在地|地域|エリア/.test(k)) idx.prefecture ??= i;
  });
  return idx;
}

/** Company-entity forms — a cell containing one is DATA, never a header label.
 * (Bare 法人 is excluded so a "法人名" header column isn't misread as data.) */
const LEGAL_TOKEN_RE = /株式会社|有限会社|合同会社|合資会社|合名会社|協同組合|（株）|\(株\)/;
/** A header cell is a short, pure column keyword (anchored so names don't match). */
const HEADER_CELL_RE =
  /^(name|company|会社名?|企業名?|法人名|domain|url|ドメイン|hp|ホームページ|industry|業種|業界|employees?|従業員数?|規模|人数|prefecture|pref|都道府県|所在地|地域|エリア|source|ソース|媒体|出典)$/i;

/**
 * Decide whether row 0 is a header row. We can't just look for known tokens
 * because company names themselves contain 会社/法人 — so a row is a header only
 * when a cell is a *pure* column keyword and no cell looks like data (legal
 * token or a dotted domain). Prevents eating the first company of a name-only
 * list whose name happens to contain 株式会社.
 */
function looksLikeHeader(row: string[]): boolean {
  const cells = row.map((c) => c.trim()).filter(Boolean);
  if (cells.length === 0) return false;
  if (cells.some((c) => LEGAL_TOKEN_RE.test(c) || /\.[a-z]{2,}/i.test(c))) return false;
  return cells.some((c) => HEADER_CELL_RE.test(c.toLowerCase()));
}

/** Parse a companies CSV into raw rows (name required; domain may be empty). */
export function parseCompaniesCsv(text: string): IngestRow[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];
  const hasHeader = looksLikeHeader(table[0]);
  const idx = hasHeader ? headerIndex(table[0]) : {};
  const dataRows = hasHeader ? table.slice(1) : table;
  // Positional fallbacks (name=0, domain=1) apply ONLY to headerless files — with
  // a header we must not guess a column that isn't declared (else industry would
  // masquerade as domain).
  const pick = (cols: string[], key: string, headerlessIdx?: number) => {
    const i = idx[key] ?? (hasHeader ? undefined : headerlessIdx);
    return i !== undefined ? cols[i] : undefined;
  };
  return dataRows
    .map((cols): IngestRow => ({
      name: (pick(cols, 'name', 0) ?? '').trim(),
      domain: (pick(cols, 'domain', 1) ?? '').trim(),
      industry: pick(cols, 'industry')?.trim() || undefined,
      employees: (() => {
        const v = pick(cols, 'employees');
        return v ? Number.parseInt(v.replace(/[^\d]/g, ''), 10) || undefined : undefined;
      })(),
      source: pick(cols, 'source')?.trim() || undefined,
      prefecture: pick(cols, 'prefecture')?.trim() || undefined,
    }))
    .filter((r) => r.name);
}

/**
 * Score a row 0..1 against ICP. With only name+domain we can't judge much,
 * so the base is neutral (0.5) and industry/size columns adjust it. Competitor
 * / exclude keywords force 0 (caller suppresses those).
 */
export function scoreIcp(row: IngestRow, icp: IcpConfig): { score: number; excluded: boolean } {
  const hay = `${row.name} ${row.industry ?? ''} ${row.source ?? ''}`;

  // Hard exclude: competitor ATS or exclude keyword present in the row text.
  const excluded =
    icp.competitorAts.some((c) => hay.includes(c)) ||
    icp.excludeKeywords.some((c) => hay.includes(c));
  if (excluded) return { score: 0, excluded: true };

  let score = 0.5;

  if (row.employees !== undefined) {
    const inRange = row.employees >= icp.employees.min && row.employees <= icp.employees.max;
    score += inRange ? 0.2 : -0.3;
    // ICP v2: extra weight for the sweet band (300–500名, 成約 1.41x).
    if (inRange && icp.employeesSweet &&
        row.employees >= icp.employeesSweet.min && row.employees <= icp.employeesSweet.max) {
      score += 0.15;
    }
  }
  if (row.industry && icp.targetIndustries.some((t) => row.industry!.includes(t))) score += 0.2;
  if (icp.signals.some((s) => hay.includes(s))) score += 0.1;
  // ICP v2 soft exclude (減点): low-conversion细分ラベル — penalized, not dropped.
  if (icp.penalizeKeywords?.some((p) => hay.includes(p))) score -= 0.25;

  return { score: Math.max(0, Math.min(1, Number(score.toFixed(3)))), excluded: false };
}

/** Ingest rows (already parsed) into the DB. */
export function ingestRows(rows: IngestRow[]): IngestResult {
  const icp = loadIcp();
  let ingested = 0;
  let suppressed = 0;
  let skipped = 0;

  for (const raw of rows) {
    const domain = normalizeDomain(raw.domain || '');
    const name = raw.name?.trim();
    if (!domain || !name) {
      skipped++;
      continue;
    }
    const row: IngestRow = { ...raw, domain, name };
    const { score, excluded } = scoreIcp(row, icp);
    const company = companies.upsert({
      name,
      domain,
      source: row.source,
      icpScore: score,
    });
    if (excluded) {
      suppression.add(domain, 'competitor');
      audit.log({ companyId: company.id, layer: 'L0', action: 'suppress:competitor', detail: name });
      if (company.status !== 'SUPPRESSED') {
        transition(company.id, 'SUPPRESSED', { force: true, detail: 'competitor/exclude at ingest' });
      }
      suppressed++;
    } else {
      ingested++;
    }
  }
  log.info(`ingested=${ingested} suppressed=${suppressed} skipped=${skipped}`);
  return { ingested, suppressed, skipped };
}

/** Ingest from a CSV file path. Rows without a domain are skipped. */
export function ingestCsv(path: string): IngestResult {
  const rows = parseCompaniesCsv(readFileSync(path, 'utf8'));
  return ingestRows(rows);
}

export interface ResolveIngestOptions {
  /** Ingest even domains whose homepage could not be verified. Default false. */
  acceptUnverified?: boolean;
  /** Per-company progress callback. */
  onProgress?: (msg: string) => void;
}

export interface UnresolvedRow {
  name: string;
  reason: string;
  candidate?: string;
}

export interface ResolveIngestResult extends IngestResult {
  /** Rows that already had a domain (no search needed). */
  hadDomain: number;
  /** Rows whose HP we resolved via web search. */
  resolved: number;
  /** Rows we could not confidently resolve (with reason). */
  unresolved: UnresolvedRow[];
}

/**
 * L0 拡張 — ingest a name-only (or partially-filled) CSV, auto-discovering each
 * missing homepage via web search before scoring/upsert. This is the entry point
 * for "企業HPも勝手に探してフォーム送る": feed names, the system finds the HP,
 * then the normal pipeline (discover → plan → send) takes over.
 */
export async function ingestCsvWithResolve(
  path: string,
  opts: ResolveIngestOptions = {},
): Promise<ResolveIngestResult> {
  const rows = parseCompaniesCsv(readFileSync(path, 'utf8'));
  const resolvedRows: IngestRow[] = [];
  const unresolved: UnresolvedRow[] = [];
  let hadDomain = 0;
  let resolved = 0;

  for (const row of rows) {
    if (row.domain) {
      hadDomain++;
      resolvedRows.push(row);
      continue;
    }
    opts.onProgress?.(`resolving HP: ${row.name}`);
    const hp = await resolveHomepage(row.name, {
      industry: row.industry,
      prefecture: row.prefecture,
    }).catch((e) => {
      log.error(`resolve failed ${row.name}: ${(e as Error).message}`);
      return null;
    });

    if (!hp) {
      unresolved.push({ name: row.name, reason: 'no candidate found' });
      continue;
    }
    if (hp.method === 'search+unverified' && !opts.acceptUnverified) {
      unresolved.push({ name: row.name, reason: 'unverified', candidate: hp.domain });
      audit.log({ layer: 'L0', action: 'hp_unverified', detail: `${row.name} -> ${hp.domain}` });
      continue;
    }
    resolved++;
    resolvedRows.push({ ...row, domain: hp.domain, source: row.source ?? 'hp_auto' });
    audit.log({
      layer: 'L0',
      action: 'hp_resolved',
      detail: `${row.name} -> ${hp.domain} (${hp.method}, conf=${hp.confidence})`,
    });
    opts.onProgress?.(`  -> ${hp.domain} (${hp.method}, conf=${hp.confidence})`);
  }

  const base = ingestRows(resolvedRows);
  return { ...base, hadDomain, resolved, unresolved };
}
