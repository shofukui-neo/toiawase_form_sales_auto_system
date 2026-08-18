import { readFileSync } from 'node:fs';
import { companies, suppression, audit, hpCache } from '../db/repositories.js';
import { tx } from '../db/db.js';
import { transition } from '../core/stateMachine.js';
import { loadIcp, type IcpConfig } from '../config.js';
import { normalizeDomain } from '../utils/url.js';
import { resolveHomepage, type HomepageResult } from './l0_homepage.js';
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
  /** Rows whose company was already in the DB and was left untouched. */
  alreadyKnown: number;
  /** Rows dropped for having no domain (name-only rows without --resolve). */
  noDomain: string[];
  /** One domain claimed by two or more differently-named rows — almost always a
   * mis-mapped column (a CRM/lead URL taken as the company site). */
  collisions: { domain: string; names: string[] }[];
  /** Companies (re-)entering the pipeline; the caller drives discovery on these. */
  companyIds: number[];
  /** Re-imported companies whose failed run was reset so it retries. */
  requeued: number;
}

/** Terminal states a re-import is allowed to retry (nothing was sent, and the
 * exclusion wasn't a human/compliance decision). */
const RETRYABLE_STATUSES = new Set(['FORM_NOT_FOUND', 'PARSE_FAILED']);

/** Field separators we accept, in tie-break order (comma wins a tie). */
const DELIMITERS = [',', '\t', ';'] as const;

/**
 * Pick the field separator from the first record.
 *
 * A list pasted straight out of Excel / Google スプレッドシート is TAB-separated,
 * and parsing it as comma-CSV puts the whole line into `name` — every row then
 * looks like a company with no domain, so the whole list is skipped (or, with
 * HP自動探索 on, searched under a garbage query). Counted outside quotes so a
 * quoted `"株式会社サンプル, 東京"` cannot vote for comma.
 */
function detectDelimiter(text: string): string {
  // Skip blank leading lines so an empty first spreadsheet row doesn't decide it.
  const head = text.replace(/^(?:[^\S\r\n]*\r?\n)+/, '');
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '"') {
      if (inQuotes && head[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (c === '\n' || c === '\r') break;
      const n = counts.get(c);
      if (n !== undefined) counts.set(c, n + 1);
    }
  }
  let best: string = DELIMITERS[0];
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/** Minimal CSV parser (handles quoted fields + separators inside quotes). */
function parseCsv(text: string): string[][] {
  const delim = detectDelimiter(text);
  // Fast path: no quoting anywhere in the file (the common shape of a
  // spreadsheet paste / CRM export), so a field can never contain the delimiter
  // or a newline. split() runs in native code — on a 3万行リスト that is roughly
  // an order of magnitude cheaper than the char-by-char accumulator below,
  // which allocates a new string per character.
  if (text.indexOf('"') === -1) {
    const out: string[][] = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (line === '') continue;
      out.push(line.split(delim));
    }
    return out;
  }

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
    else if (c === delim) {
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

/**
 * Columns of a CRM/SFA export that describe the *lead record* or the person —
 * never the company. Matched before any role rule, because several of them
 * contain a role keyword: `リードURL` is the CRM's own lead page (same host on
 * every row), and taking it as the company website collapses the whole list
 * onto one domain — `companies.domain` is UNIQUE, so every company but the last
 * silently disappears and the one survivor gets discovered against the CRM.
 */
const NON_COMPANY_HEADERS: readonly RegExp[] = [
  /^(?:リード|lead)\s*(?:url|id|ｉｄ|ステージ|stage|所有者|owner|状態|status|スコア|score)$/i,
  /担当者|^担当$|役職|部署|部門|氏名|^姓$|^名$/,
  /電話|^tel$|fax|携帯/i,
  /コール|架電|通話|^call/i,
  /備考|メモ|コメント|^comment|^note/i,
  /日時|日付|^date$|^datetime$/i,
  /^(?:メール(?:アドレス)?|e-?mail|mail)$/i,
];

/** Exact column labels → canonical key. Checked first, so `Webサイト` wins the
 * domain slot over a fuzzy `url` hit elsewhere in the row. */
const EXACT_HEADER_RULES: readonly (readonly [string, RegExp])[] = [
  ['domain', /^(?:web\s*サイト|web\s*site|website|ホームページ|hp|url|ドメイン|domain|(?:会社|企業|自社|公式|コーポレート)\s*(?:url|サイト|hp|ホームページ))$/i],
  ['name', /^(?:会社名|企業名|法人名|社名|団体名|取引先名?|company(?:\s*name)?|name)$/i],
  ['employees', /^(?:従業員数?|従業員規模|社員数|規模|人数|employees?|(?:company\s*)?size)$/i],
  ['industry', /^(?:業種|業界|industry|sector)$/i],
  ['prefecture', /^(?:都道府県|府県|所在地|地域|エリア|pref(?:ecture)?|area|region)$/i],
  ['source', /^(?:出典|媒体|ソース|流入元|(?:リード|lead)\s*(?:ソース|source)|source)$/i],
];

/** Substring fallbacks, applied only to columns no exact rule claimed. */
const FUZZY_HEADER_RULES: readonly (readonly [string, RegExp])[] = [
  ['domain', /ホームページ|ドメイン|domain|url|サイト|\bhp\b/i],
  ['name', /会社|企業|法人|社名|company|name/i],
  ['employees', /従業員|規模|人数|employee/i],
  ['industry', /業種|業界|industry/i],
  ['prefecture', /都道府県|所在地|地域|エリア|pref/i],
  ['source', /出典|媒体|ソース|source/i],
];

/**
 * Map header cells to canonical column keys (JP or EN). Two passes — exact
 * labels first, then substring fallbacks — and each column may claim only one
 * key, so `会社URL` lands on `domain` instead of being double-counted as `name`.
 */
function headerIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  const claimed = new Set<number>();
  const cells = header.map((h) => h.trim().toLowerCase());
  const assign = (rules: readonly (readonly [string, RegExp])[]) => {
    cells.forEach((k, i) => {
      if (!k || claimed.has(i) || NON_COMPANY_HEADERS.some((re) => re.test(k))) return;
      const hit = rules.find(([, re]) => re.test(k));
      if (!hit || idx[hit[0]] !== undefined) return;
      idx[hit[0]] = i;
      claimed.add(i);
    });
  };
  assign(EXACT_HEADER_RULES);
  assign(FUZZY_HEADER_RULES);
  return idx;
}

/** Company-entity forms — a cell containing one is DATA, never a header label.
 * (Bare 法人 is excluded so a "法人名" header column isn't misread as data.) */
const LEGAL_TOKEN_RE = /株式会社|有限会社|合同会社|合資会社|合名会社|協同組合|（株）|\(株\)/;

/** A header cell is a pure column label — either a role we map or a CRM column. */
function isHeaderCell(cell: string): boolean {
  const k = cell.trim().toLowerCase();
  if (!k) return false;
  return (
    EXACT_HEADER_RULES.some(([, re]) => re.test(k)) ||
    NON_COMPANY_HEADERS.some((re) => re.test(k))
  );
}

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
  return cells.some(isHeaderCell);
}

/** Rows + the column mapping they were read with, from a single parse. */
export interface ParsedList {
  rows: IngestRow[];
  /** canonical key -> the header label it was taken from ({} when headerless). */
  columns: Record<string, string>;
}

/** Which canonical columns a header row resolves to — surfaced in the intake
 * preview so a mis-mapped list is visible before it is committed. */
export function detectColumns(text: string): Record<string, string> {
  return parseCompaniesList(text).columns;
}

/** Parse a companies CSV into raw rows (name required; domain may be empty). */
export function parseCompaniesCsv(text: string): IngestRow[] {
  return parseCompaniesList(text).rows;
}

/**
 * Parse once, return both the rows and the recognised columns.
 *
 * The intake preview used to call `parseCompaniesCsv` and `detectColumns`
 * separately, and the import handler parsed a third time — three full passes
 * over a multi-megabyte list per keystroke-debounced preview.
 */
export function parseCompaniesList(text: string): ParsedList {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], columns: {} };
  const hasHeader = looksLikeHeader(table[0]);
  const idx = hasHeader ? headerIndex(table[0]) : {};
  const columns: Record<string, string> = {};
  if (hasHeader) {
    for (const [key, i] of Object.entries(idx)) columns[key] = table[0][i]?.trim() ?? '';
  }
  const dataRows = hasHeader ? table.slice(1) : table;
  // Positional fallbacks (name=0, domain=1) apply ONLY to headerless files — with
  // a header we must not guess a column that isn't declared (else industry would
  // masquerade as domain).
  const pick = (cols: string[], key: string, headerlessIdx?: number) => {
    const i = idx[key] ?? (hasHeader ? undefined : headerlessIdx);
    return i !== undefined ? cols[i] : undefined;
  };
  const rows: IngestRow[] = [];
  for (const cols of dataRows) {
    const name = (pick(cols, 'name', 0) ?? '').trim();
    if (!name) continue;
    const employeesRaw = pick(cols, 'employees');
    rows.push({
      name,
      domain: (pick(cols, 'domain', 1) ?? '').trim(),
      industry: pick(cols, 'industry')?.trim() || undefined,
      employees: employeesRaw
        ? Number.parseInt(employeesRaw.replace(/[^\d]/g, ''), 10) || undefined
        : undefined,
      source: pick(cols, 'source')?.trim() || undefined,
      prefecture: pick(cols, 'prefecture')?.trim() || undefined,
    });
  }
  return { rows, columns };
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

/** What happened to a single row. Mirrors `import_rows.state`. */
export type IngestOutcome = 'ingested' | 'known' | 'suppressed' | 'nodomain';

export interface IngestOneResult {
  outcome: IngestOutcome;
  companyId?: number;
  /** Normalized domain actually written (empty for `nodomain`). */
  domain: string;
  /** True when a dead-ended company was reset to NEW so it retries. */
  requeued: boolean;
  /** Human-readable note (why it was skipped / what state it was already in). */
  detail?: string;
}

export interface IngestOneOptions {
  /**
   * Skip companies already present in `companies` instead of re-upserting and
   * re-running the pipeline on them. This is what makes re-importing an
   * overlapping list nearly free — the company was already saved on the first
   * pass, so the second pass must not pay for it again.
   */
  skipKnown?: boolean;
  icp?: IcpConfig;
}

/**
 * Ingest exactly one row. The unit of work the resumable intake job commits in
 * chunks; `ingestRows` is the in-memory batch wrapper around it.
 */
export function ingestOne(raw: IngestRow, opts: IngestOneOptions = {}): IngestOneResult {
  const icp = opts.icp ?? loadIcp();
  const name = raw.name?.trim();
  const domain = normalizeDomain(raw.domain || '');
  if (!domain || !name) {
    return { outcome: 'nodomain', domain: '', requeued: false };
  }

  // Cheap index lookup before any write: a company we have already read keeps
  // whatever state it reached, and (unless it dead-ended) is not re-processed.
  const known = companies.refByDomain(domain);
  if (known) {
    if (RETRYABLE_STATUSES.has(known.status)) {
      transition(known.id, 'NEW', { force: true, detail: 're-ingest retry' });
      return {
        outcome: 'ingested',
        companyId: known.id,
        domain,
        requeued: true,
        detail: '再取り込み（前回フォーム未発見/解析失敗）',
      };
    }
    if (opts.skipKnown) {
      return {
        outcome: 'known',
        companyId: known.id,
        domain,
        requeued: false,
        detail: `取り込み済み（${known.status}）`,
      };
    }
  }

  const row: IngestRow = { ...raw, domain, name };
  const { score, excluded } = scoreIcp(row, icp);
  const company = companies.upsert({ name, domain, source: row.source, icpScore: score });

  if (excluded) {
    suppression.add(domain, 'competitor');
    audit.log({ companyId: company.id, layer: 'L0', action: 'suppress:competitor', detail: name });
    if (company.status !== 'SUPPRESSED') {
      transition(company.id, 'SUPPRESSED', { force: true, detail: 'competitor/exclude at ingest' });
    }
    return { outcome: 'suppressed', companyId: company.id, domain, requeued: false, detail: '競合/除外キーワード' };
  }
  return { outcome: 'ingested', companyId: company.id, domain, requeued: false };
}

/**
 * Ingest rows (already parsed) into the DB, in ONE transaction.
 *
 * Per-row autocommit meant one fsync per company: a 3万件 list took minutes and
 * blocked the whole (single-threaded) process while it ran. Batched, the same
 * list commits in seconds. For interactive imports use the resumable job in
 * `pipeline/intake.ts` — it chunks this and checkpoints as it goes.
 */
export function ingestRows(rows: IngestRow[], opts: { skipKnown?: boolean } = {}): IngestResult {
  const icp = loadIcp();
  let ingested = 0;
  let suppressed = 0;
  let skipped = 0;
  let requeued = 0;
  let alreadyKnown = 0;
  const noDomain: string[] = [];
  const companyIds: number[] = [];
  // domain -> distinct names seen in this batch, to catch a mis-mapped URL column.
  const byDomain = new Map<string, string[]>();

  tx(() => {
    for (const raw of rows) {
      const r = ingestOne(raw, { icp, skipKnown: opts.skipKnown });
      if (r.outcome === 'nodomain') {
        skipped++;
        if (raw.name?.trim()) noDomain.push(raw.name.trim());
        continue;
      }
      const names = byDomain.get(r.domain) ?? [];
      const name = raw.name.trim();
      if (!names.includes(name)) names.push(name);
      byDomain.set(r.domain, names);

      if (r.requeued) requeued++;
      if (r.outcome === 'suppressed') {
        suppressed++;
      } else if (r.outcome === 'known') {
        alreadyKnown++;
      } else {
        companyIds.push(r.companyId!);
        ingested++;
      }
    }
  });

  const collisions = [...byDomain.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([domain, names]) => ({ domain, names }));
  for (const c of collisions) {
    log.warn(`domain collision: ${c.domain} claimed by ${c.names.length} companies (${c.names.join(' / ')})`);
    audit.log({ layer: 'L0', action: 'domain_collision', detail: `${c.domain}: ${c.names.join(' / ')}` });
  }

  log.info(
    `ingested=${ingested} known=${alreadyKnown} suppressed=${suppressed} skipped=${skipped} requeued=${requeued}`,
  );
  return { ingested, suppressed, skipped, alreadyKnown, noDomain, collisions, companyIds, requeued };
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
  return ingestRowsWithResolve(parseCompaniesCsv(readFileSync(path, 'utf8')), opts);
}

/**
 * Same as {@link ingestCsvWithResolve} but from already-parsed rows — the entry
 * point the web intake job uses (list pasted / uploaded in the browser, parsed
 * client-side into rows, then resolved + ingested here).
 */
/** Cache key for a name lookup — normalized so casing/spacing don't split it. */
export function hpCacheKey(name: string, hints: { industry?: string; prefecture?: string } = {}): string {
  const norm = (s?: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [norm(name), norm(hints.industry), norm(hints.prefecture)].join('|');
}

/**
 * {@link resolveHomepage} with a persistent cache.
 *
 * Each lookup costs several search + fetch round-trips (seconds), which is what
 * makes a 3万件 name-only list impossible to re-run. Results — *including
 * misses* — are stored, so re-importing an overlapping list never repeats a
 * search it has already done.
 */
export async function resolveHomepageCached(
  name: string,
  hints: { industry?: string; prefecture?: string } = {},
): Promise<{ hp: HomepageResult | null; cached: boolean }> {
  const key = hpCacheKey(name, hints);
  const hit = hpCache.get(key);
  if (hit) {
    if (!hit.domain) return { hp: null, cached: true };
    return {
      cached: true,
      hp: {
        domain: hit.domain,
        url: `https://${hit.domain}`,
        confidence: hit.confidence ?? 0.5,
        method: (hit.method as HomepageResult['method']) ?? 'search+unverified',
        evidence: 'cached',
        alternatives: [],
      },
    };
  }
  const hp = await resolveHomepage(name, hints).catch((e) => {
    log.error(`resolve failed ${name}: ${(e as Error).message}`);
    return null;
  });
  hpCache.set(key, {
    domain: hp?.domain ?? null,
    method: hp?.method ?? null,
    confidence: hp?.confidence ?? null,
  });
  return { hp, cached: false };
}

export async function ingestRowsWithResolve(
  rows: IngestRow[],
  opts: ResolveIngestOptions = {},
): Promise<ResolveIngestResult> {
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
    const { hp } = await resolveHomepageCached(row.name, {
      industry: row.industry,
      prefecture: row.prefecture,
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
