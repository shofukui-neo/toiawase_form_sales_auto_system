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
  /** 日程調整ページ URL. Empty = the scheduling paragraph is dropped entirely. */
  bookingUrl: string;
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
  /**
   * 同時に起動してよい Chromium プロセスの上限（全レイヤ横断）。
   *
   * 取り込み（L1発見/L2解析）と一斉送信（L4）が並走するため、レイヤごとの
   * 並列数を足すと実際の同時起動数になる。1プロセス 200-400MB 使うので、
   * ここで頭を押さえないと 3万件の後半でメモリを踏み抜く。
   */
  browserConcurrency: number;
  /**
   * 一斉送信 (L4 Execute) を何社同時に走らせるか。
   *
   * 1社の送信は「フォームを開く → 1文字ずつ入力 → 確認画面 → 送信」で 30-90 秒
   * かかり、その大半はネットワーク待ちなので、直列だと送信間隔より実処理時間が
   * 支配的になる。ここを上げると N 社を並行して処理する（送信間隔は
   * ワーカーごとに独立して効くので、実効スループットは約 N 倍になる）。
   * 1社 = Chromium 1プロセスなので {@link browserConcurrency} も併せて上がる。
   */
  sendConcurrency: number;
  /** リスト取り込み (L0) のバッチ／並列度チューニング。 */
  intake: {
    /** Rows committed per transaction + per progress checkpoint. */
    chunkSize: number;
    /** Companies discovered/parsed in parallel during the pipeline phase. */
    concurrency: number;
    /** Parallel HP auto-discovery lookups (each is several web requests). */
    resolveConcurrency: number;
  };
  sheets: {
    spreadsheetId: string | null;
    keyFile: string | null; // service-account JSON path
    reportTab: string;
    suppressionTab: string;
  };
}

// browserConcurrency の既定値がこの 2 つから決まるので、config より先に確定させる。
const INTAKE_CONCURRENCY = Math.max(1, envInt('INTAKE_CONCURRENCY', 3));
/** 同時送信数。上げるほど Chromium プロセスとメモリを食うので既定は控えめ。 */
const SEND_CONCURRENCY = Math.max(1, envInt('SEND_CONCURRENCY', 3));

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
    bookingUrl: envStr('SENDER_BOOKING_URL', ''),
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
  // 既定は 24 時間送信 (0-24)。フォーム送信はメールと違い相手の受信箱を夜中に
  // 鳴らさないので、時間帯で止める理由がない。絞りたい場合だけ .env で狭める。
  // 既定 7-23 = 深夜（23時〜翌7時）は送らない。設定漏れの環境が真夜中に
  // 送り始めるより、既定を安全側に倒して 24 時間送信は明示指定にする。
  sendWindowStart: envInt('SEND_WINDOW_START', 7),
  sendWindowEnd: envInt('SEND_WINDOW_END', 23),
  sendMinIntervalMs: envInt('SEND_MIN_INTERVAL_MS', 45000),
  sendMaxIntervalMs: envInt('SEND_MAX_INTERVAL_MS', 120000),
  headless: envBool('HEADLESS', true),
  // 既定 = 発見処理 (INTAKE_CONCURRENCY) + 送信 (SEND_CONCURRENCY)。取り込みと
  // 一斉送信は並走するので、両方が満載でも枠待ちで固まらない値を既定にする。
  browserConcurrency: Math.max(1, envInt('BROWSER_MAX_CONCURRENCY', INTAKE_CONCURRENCY + SEND_CONCURRENCY)),
  sendConcurrency: SEND_CONCURRENCY,
  intake: {
    chunkSize: Math.max(1, envInt('INTAKE_CHUNK_SIZE', 500)),
    concurrency: INTAKE_CONCURRENCY,
    resolveConcurrency: Math.max(1, envInt('INTAKE_RESOLVE_CONCURRENCY', 2)),
  },
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

let _icp: IcpConfig | null = null;

/**
 * ICP config, memoised. Scoring runs once per imported row, so re-reading and
 * re-parsing icp.json 3万回 is pure overhead — call {@link clearIcpCache} after
 * editing the file in a long-lived process.
 */
export function loadIcp(): IcpConfig {
  if (_icp) return _icp;
  const raw = readFileSync(resolve(ROOT, 'config/icp.json'), 'utf8');
  _icp = JSON.parse(raw) as IcpConfig;
  return _icp;
}

export function clearIcpCache(): void {
  _icp = null;
}
