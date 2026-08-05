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
  /** Romaji reading shown in the signature block ("Sho Fukui"). Empty = omitted. */
  personRomaji: string;
  kana: string;
  email: string;
  /** 連絡先番号 — what goes into a form's 電話番号 field and the signature contact line. */
  phone: string;
  /** 本社代表番号 — signature office block only; never typed into a form. */
  officePhone: string;
  fax: string;
  url: string;
  /** Katakana reading of 姓/名 for split フリガナ fields (課題B). Empty = unset. */
  kanaSei: string;
  kanaMei: string;
  /** Sender company postal code, e.g. "160-0023" (課題A split郵便番号). Empty = unset. */
  postal: string;
  address: string;
  /** Office name shown in the signature block ("新宿本社"). Empty = omitted. */
  office: string;
  /** Department to fill when a 部署 field is required. */
  department: string;
}

/** 住所を 都道府県 / 市区町村 / 番地・建物名 に分解した結果 (課題: 住所分割欄). */
export interface AddressParts {
  prefecture: string;
  city: string;
  /** 番地・マンション名など — 市区町村より後ろの全て。 */
  street: string;
}

const PREFECTURE_RE = /^(東京都|北海道|(?:京都|大阪)府|(?:.{2,3})県)/;

/**
 * Split a Japanese address into 都道府県 / 市区町村 / 番地・建物名.
 *
 * Forms that split the address (genma: 都道府県+市区町村+番地・マンション名, lassic:
 * streetaddress01/02/03) reject a whole address pasted into the first box, so each
 * part must be typed separately. The 市区町村 boundary is the first 市/区/町/村/郡
 * after the prefecture — with 政令市 handled by preferring the LAST 区 in a
 * "…市…区" run so 横浜市青葉区 stays together.
 */
export function splitAddress(address: string): AddressParts {
  const full = (address || '').trim();
  if (!full) return { prefecture: '', city: '', street: '' };

  const pm = full.match(PREFECTURE_RE);
  const prefecture = pm ? pm[1] : '';
  const rest = prefecture ? full.slice(prefecture.length).trim() : full;

  // 「○○市△△区」は政令指定都市 — 区までを市区町村とする。それ以外は最初の 市/区/町/村/郡 まで。
  const ward = rest.match(/^(.{1,8}?市.{1,8}?区)/);
  const cm = ward ?? rest.match(/^(.{1,10}?(?:市|区|町|村|郡))/);
  const city = cm ? cm[1] : '';
  const street = (city ? rest.slice(city.length) : rest).trim();

  return { prefecture, city, street };
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
    company: envStr('SENDER_COMPANY', '株式会社ネオキャリア'),
    product: envStr('SENDER_PRODUCT', 'MOCHICA'),
    person: envStr('SENDER_PERSON', ''),
    personRomaji: envStr('SENDER_PERSON_ROMAJI', ''),
    kana: envStr('SENDER_KANA', ''),
    email: envStr('SENDER_EMAIL', ''),
    phone: envStr('SENDER_PHONE', ''),
    officePhone: envStr('SENDER_OFFICE_PHONE', ''),
    fax: envStr('SENDER_FAX', ''),
    url: envStr('SENDER_URL', ''),
    kanaSei: envStr('SENDER_KANA_SEI', ''),
    kanaMei: envStr('SENDER_KANA_MEI', ''),
    postal: envStr('SENDER_POSTAL', ''),
    address: envStr('SENDER_ADDRESS', ''),
    office: envStr('SENDER_OFFICE', ''),
    department: envStr('SENDER_DEPARTMENT', ''),
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
  /** Bonus band inside [min,max] where conversion peaks (ICP v2: 300–500名). */
  employeesSweet?: { min: number; max: number };
  targetIndustries: string[];
  signals: string[];
  /** Hard excludes: presence -> score 0 -> SUPPRESSED (competitor / policy). */
  excludeKeywords: string[];
  /** Soft excludes (ICP v2 減点): low-conversion labels — penalized, not dropped. */
  penalizeKeywords?: string[];
  competitorAts: string[];
}

export function loadIcp(): IcpConfig {
  const raw = readFileSync(resolve(ROOT, 'config/icp.json'), 'utf8');
  return JSON.parse(raw) as IcpConfig;
}
