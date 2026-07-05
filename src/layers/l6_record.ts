import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { companies, submissions, suppression } from '../db/repositories.js';
import { logger } from '../utils/logger.js';

const log = logger('L6');

/**
 * L6 — result management / report layer (spec §4-L6, §8).
 * DB is the source of truth; this emits a flat CSV report — the pragmatic
 * stand-in for the Sheets report layer (§13-4: DB engine + Sheets report).
 * A real Sheets sync would push these same rows via the Sheets API.
 */

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const head = headers.map(csvCell).join(',');
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

export interface Table {
  headers: string[];
  rows: unknown[][];
}

/** Build the master report table (shared by CSV export and Sheets sync). */
export function buildReportTable(): Table {
  const headers = [
    'company_id', 'name', 'domain', 'icp_score', 'status', 'form_url', 'form_confidence',
    'submission_status', 'approved_by', 'submitted_at', 'result_detail', 'plan_screenshot',
  ];
  const rows: unknown[][] = companies.all().map((c) => {
    const sub = submissions.latestForCompany(c.id);
    return [
      c.id, c.name, c.domain, c.icp_score, c.status, c.form_url, c.form_confidence,
      sub?.status ?? '', sub?.approved_by ?? '', sub?.submitted_at ?? '',
      sub?.result_detail ?? '', sub?.plan_screenshot_url ?? '',
    ];
  });
  return { headers, rows };
}

/** Build the suppression table. */
export function buildSuppressionTable(): Table {
  return {
    headers: ['domain', 'reason', 'created_at'],
    rows: suppression.all().map((s) => [s.domain, s.reason, s.created_at]),
  };
}

/** Export the master report: one row per company with its latest submission. */
export function exportReport(outPath?: string): string {
  const dest = outPath ?? resolve(config.artifactsDir, 'report.csv');
  mkdirSync(config.artifactsDir, { recursive: true });
  const { headers, rows } = buildReportTable();
  writeFileSync(dest, toCsv(headers, rows), 'utf8');
  log.info(`report exported: ${dest} (${rows.length} companies)`);
  return dest;
}

/** Export the suppression list (audit/compliance visibility). */
export function exportSuppression(outPath?: string): string {
  const dest = outPath ?? resolve(config.artifactsDir, 'suppression.csv');
  mkdirSync(config.artifactsDir, { recursive: true });
  const { headers, rows } = buildSuppressionTable();
  writeFileSync(dest, toCsv(headers, rows), 'utf8');
  log.info(`suppression exported: ${dest} (${rows.length} rows)`);
  return dest;
}
