import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const log = logger('browser');

// Register stealth once at module load (spec §4-L4 anti-bot).
let stealthRegistered = false;
function ensureStealth(): void {
  if (stealthRegistered) return;
  // playwright-extra accepts puppeteer-extra plugins.
  (chromium as any).use(StealthPlugin());
  stealthRegistered = true;
}

/* ------------------------- ブラウザ枠（全レイヤ横断） ------------------------ */

/**
 * 同時に生きている Chromium プロセスの数を `config.browserConcurrency` で抑える。
 *
 * 取り込み（L1発見 / L2解析、既定 3 並列）と一斉送信（L4、1 並列）が**同時に**
 * 走るようになったため、レイヤごとの並列数だけでは実際の同時起動数を制御できない。
 * `BrowserSession` は毎回 `chromium.launch()` する（プロセスを共有しない）ので、
 * 上限を設けないと 3万件の後半でメモリを踏み抜く。
 */
interface Waiter {
  resolve: () => void;
  priority: boolean;
}

let inFlight = 0;
const waiters: Waiter[] = [];

function acquireSlot(priority: boolean): Promise<void> {
  if (inFlight < config.browserConcurrency) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const w: Waiter = { resolve, priority };
    if (!priority) {
      waiters.push(w);
      return;
    }
    // 優先枠は待ち行列の先頭へ。ただし先に待っている優先枠は追い越さない。
    const i = waiters.findIndex((x) => !x.priority);
    if (i < 0) waiters.push(w);
    else waiters.splice(i, 0, w);
  });
}

function releaseSlot(): void {
  // 待ち行列があれば枠を直接引き継ぐ（inFlight は据え置き）。いったん減らして
  // から起こすと、その隙に別の呼び出しが割り込んで待機側が飢える。
  const next = waiters.shift();
  if (next) next.resolve();
  else inFlight--;
}

export interface BrowserSlotOptions {
  /**
   * 枠の空きを待つ列の先頭に入る。送信 (L4 Execute) 用。
   * 取り込みは何時間走ってもよいが、送信は送信可能時間帯と日次上限の中でしか
   * 動けないので、発見処理の後ろに並ばせてはいけない。
   */
  priority?: boolean;
}

/** ブラウザ枠を 1 つ確保して `fn` を実行する。空くまで待つ。 */
export async function withBrowserSlot<T>(
  fn: () => Promise<T>,
  opts: BrowserSlotOptions = {},
): Promise<T> {
  await acquireSlot(opts.priority === true);
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

/** 診断用（ダッシュボード／ログ）。 */
export function browserSlotStats(): { inFlight: number; waiting: number; max: number } {
  return { inFlight, waiting: waiters.length, max: config.browserConcurrency };
}

/**
 * Deterministic PRNG so "human" jitter is reproducible per run (avoids the
 * Math.random ban and keeps Plan/Execute comparable). Seed varies per session.
 */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export interface SessionOptions {
  /** Seed for humanized jitter. Pass a stable value for reproducibility. */
  seed?: number;
  headless?: boolean;
}

/**
 * A single browser session. L4's Plan and Execute phases each create a *fresh*
 * session (spec §4-L4: never hold a session waiting for a human).
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  readonly rng: () => number;
  private readonly headless: boolean;

  constructor(opts: SessionOptions = {}) {
    this.rng = makeRng(opts.seed ?? 1);
    this.headless = opts.headless ?? config.headless;
  }

  async open(): Promise<Page> {
    ensureStealth();
    this.browser = await chromium.launch({
      headless: this.headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    // Real-machine-ish fingerprint (spec §4-L4).
    this.context = await this.browser.newContext({
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1366, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    // esbuild/tsx `keepNames` rewrites named functions inside page.evaluate()
    // bodies to call a `__name` helper that only exists in Node. Shim it into
    // every browser document so those evaluated helpers resolve.
    await this.context.addInitScript(() => {
      const g = globalThis as any;
      if (!g.__name) g.__name = (fn: any) => fn;
    });
    const page = await this.context.newPage();
    page.setDefaultTimeout(20000);
    return page;
  }

  /** Random delay within [min, max] using the seeded RNG. */
  async humanDelay(min = 150, max = 600): Promise<void> {
    const ms = Math.floor(min + this.rng() * (max - min));
    await new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Type text one char at a time with per-char jitter (bot-safe; §4-L4:
   * "type() 1 char at a time; bulk value-set is bot-smelling").
   */
  async humanType(page: Page, selector: string, text: string): Promise<void> {
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 8000 }).catch(() => {});
    // Clear any existing/auto-populated value (e.g. a 住所 pre-filled by the
    // form's 郵便番号→住所 lookup) so we replace rather than append to it.
    await el.fill('').catch(() => {});
    await this.humanDelay(80, 250);
    for (const ch of text) {
      await el.type(ch, { delay: 15 + Math.floor(this.rng() * 60) });
    }
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
      await this.browser?.close();
    } catch (e) {
      log.debug(`close error: ${(e as Error).message}`);
    } finally {
      this.context = null;
      this.browser = null;
    }
  }
}
