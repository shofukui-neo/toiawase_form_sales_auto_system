import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Project root (one level up from src/). */
export const ROOT = resolve(__dirname, '..');

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

export interface SenderIdentity {
  company: string;
  product: string;
  person: string;
  kana: string;
  email: string;
  phone: string;
  /** Katakana reading of 姓/名 for split フリガナ fields (課題B). Empty = unset. */
  kanaSei: string;
  kanaMei: string;
  /** Sender company postal code, e.g. "150-0043" (課題A split郵便番号). Empty = unset. */
  postal: string;
  address: string;
  /** Department to fill when a 部署 field is required. */
  department: string;
}

export interface AppConfig {
  dbPath: string;
  artifactsDir: string;
  sender: SenderIdentity;
  anthropicApiKey: string | null;
  llmModel: string;
  dailySendLimit: number;
  sendWindowStart: number;
  sendWindowEnd: number;
  sendMinIntervalMs: number;
  sendMaxIntervalMs: number;
  headless: boolean;
  sheets: {
    spreadsheetId: string | null;
    keyFile: string | null; // service-account JSON path
    reportTab: string;
    suppressionTab: string;
  };
}

export const config: AppConfig = {
  dbPath: resolve(ROOT, envStr('DB_PATH', './data/app.db')),
  artifactsDir: resolve(ROOT, envStr('ARTIFACTS_DIR', './artifacts')),
  sender: {
    company: envStr('SENDER_COMPANY', 'ネオキャリア株式会社'),
    product: envStr('SENDER_PRODUCT', 'MOCHICA'),
    person: envStr('SENDER_PERSON', ''),
    kana: envStr('SENDER_KANA', ''),
    email: envStr('SENDER_EMAIL', ''),
    phone: envStr('SENDER_PHONE', ''),
    kanaSei: envStr('SENDER_KANA_SEI', ''),
    kanaMei: envStr('SENDER_KANA_MEI', ''),
    postal: envStr('SENDER_POSTAL', ''),
    address: envStr('SENDER_ADDRESS', ''),
    department: envStr('SENDER_DEPARTMENT', '営業部'),
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  llmModel: envStr('LLM_MODEL', 'claude-sonnet-5'),
  dailySendLimit: envInt('DAILY_SEND_LIMIT', 200),
  sendWindowStart: envInt('SEND_WINDOW_START', 9),
  sendWindowEnd: envInt('SEND_WINDOW_END', 19),
  sendMinIntervalMs: envInt('SEND_MIN_INTERVAL_MS', 45000),
  sendMaxIntervalMs: envInt('SEND_MAX_INTERVAL_MS', 120000),
  headless: envBool('HEADLESS', true),
  sheets: {
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID || null,
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
    reportTab: envStr('SHEETS_REPORT_TAB', 'report'),
    suppressionTab: envStr('SHEETS_SUPPRESSION_TAB', 'suppression'),
  },
};

export interface IcpConfig {
  employees: { min: number; max: number };
  targetIndustries: string[];
  signals: string[];
  excludeKeywords: string[];
  competitorAts: string[];
}

export function loadIcp(): IcpConfig {
  const raw = readFileSync(resolve(ROOT, 'config/icp.json'), 'utf8');
  return JSON.parse(raw) as IcpConfig;
}
