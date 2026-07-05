import { readFileSync } from 'node:fs';
import { companies, suppression, audit } from '../db/repositories.js';
import { transition } from '../core/stateMachine.js';
import { loadIcp, type IcpConfig } from '../config.js';
import { normalizeDomain } from '../utils/url.js';
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
  });
  return idx;
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
    score += row.employees >= icp.employees.min && row.employees <= icp.employees.max ? 0.2 : -0.3;
  }
  if (row.industry && icp.targetIndustries.some((t) => row.industry!.includes(t))) score += 0.2;
  if (icp.signals.some((s) => hay.includes(s))) score += 0.1;

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

/** Ingest from a CSV file path. */
export function ingestCsv(path: string): IngestResult {
  const text = readFileSync(path, 'utf8');
  const table = parseCsv(text);
  if (table.length === 0) return { ingested: 0, suppressed: 0, skipped: 0 };
  const idx = headerIndex(table[0]);
  const dataRows = table.slice(1);
  const rows: IngestRow[] = dataRows.map((cols) => ({
    name: idx.name !== undefined ? cols[idx.name] : cols[0],
    domain: idx.domain !== undefined ? cols[idx.domain] : cols[1],
    industry: idx.industry !== undefined ? cols[idx.industry] : undefined,
    employees:
      idx.employees !== undefined && cols[idx.employees]
        ? Number.parseInt(cols[idx.employees].replace(/[^\d]/g, ''), 10) || undefined
        : undefined,
    source: idx.source !== undefined ? cols[idx.source] : undefined,
  }));
  return ingestRows(rows);
}
