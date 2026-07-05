import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import { config } from '../config.js';
import { buildReportTable, buildSuppressionTable, type Table } from './l6_record.js';
import { logger } from '../utils/logger.js';

const log = logger('L6-sheets');

/**
 * C — Google Sheets report sync (spec §8, §13-4). DB stays the source of truth;
 * this pushes the same report/suppression tables into a spreadsheet so 閲覧用
 * レポート層 lives in Sheets (replacing the CSV stand-in when configured).
 *
 * Auth: a Google service account. Set:
 *   SHEETS_SPREADSHEET_ID = <the spreadsheet id>
 *   GOOGLE_SERVICE_ACCOUNT_KEY = <path to the service-account JSON key>
 * and share the spreadsheet with the service account's email (Editor).
 *
 * No-ops with a warning when unconfigured (like the LLM fallback), so the rest
 * of the pipeline never hard-depends on Sheets.
 */

export interface SheetsSyncResult {
  synced: boolean;
  reason?: string;
  reportRows?: number;
  suppressionRows?: number;
}

function isConfigured(): boolean {
  return !!(config.sheets.spreadsheetId && config.sheets.keyFile);
}

async function getClient(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.sheets.keyFile!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient as any });
}

/** Ensure a tab (sheet) with the given title exists; create it if missing. */
async function ensureTab(sheets: sheets_v4.Sheets, spreadsheetId: string, title: string): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === title);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  log.info(`created tab "${title}"`);
}

/** Overwrite a tab with a table (clear then write header + rows). */
async function writeTable(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tab: string,
  table: Table,
): Promise<void> {
  await ensureTab(sheets, spreadsheetId, tab);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A:Z` });
  const values = [table.headers, ...table.rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : c)))];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/** Sync report + suppression tables into the configured spreadsheet. */
export async function syncSheets(): Promise<SheetsSyncResult> {
  if (!isConfigured()) {
    const reason = 'Sheets not configured (set SHEETS_SPREADSHEET_ID + GOOGLE_SERVICE_ACCOUNT_KEY)';
    log.warn(reason);
    return { synced: false, reason };
  }
  try {
    const sheets = await getClient();
    const spreadsheetId = config.sheets.spreadsheetId!;
    const report = buildReportTable();
    const suppression = buildSuppressionTable();
    await writeTable(sheets, spreadsheetId, config.sheets.reportTab, report);
    await writeTable(sheets, spreadsheetId, config.sheets.suppressionTab, suppression);
    log.info(`synced report(${report.rows.length}) + suppression(${suppression.rows.length}) to Sheets`);
    return { synced: true, reportRows: report.rows.length, suppressionRows: suppression.rows.length };
  } catch (e) {
    const reason = (e as Error).message;
    log.error(`Sheets sync failed: ${reason}`);
    return { synced: false, reason };
  }
}
