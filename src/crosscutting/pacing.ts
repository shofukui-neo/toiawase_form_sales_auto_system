import { config } from '../config.js';
import { sendLedger } from '../db/repositories.js';

/** Local YYYY-MM-DD for the send ledger (day bucket). */
export function todayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface PacingDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * 送信可能時間帯の判定。
 *
 * 既定は 7-23 — **深夜（23時〜翌7時）は送信しない**。フォーム送信は相手の
 * 受信箱を夜中に鳴らすわけではないが、送信時刻は問い合わせ履歴に残り、
 * 深夜の営業連絡は受け手の心証を損ねるため、既定では止める。
 *
 * 止まるのは本送信 (L4 Execute) だけ。リスト取り込み・フォーム発見・プラン
 * 作成は時間帯に関係なく走り続けるので、朝いちで送れる在庫は夜のうちに貯まる。
 *
 * - `start <= 0 && end >= 24` や `start === end` は「常時開いている」。
 *   `end = 24` を `hour >= 24` で比較すると常に false になる偶然に頼らず、
 *   ここで明示的に開けておく。
 * - `start > end`（例: 20-6）は日をまたぐ夜間帯として扱う。夜だけ送りたい、
 *   という設定を書いたつもりが 1 社も送れない、という事故を防ぐ。
 */
export function withinSendWindow(hour: number): boolean {
  const start = config.sendWindowStart;
  const end = config.sendWindowEnd;
  if (start === end) return true; // 幅ゼロ＝制限なしと解釈する
  if (start <= 0 && end >= 24) return true; // 24時間送信（明示指定したときだけ）
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // 日をまたぐ夜間帯 (例: 20-6)
}

/**
 * Pacing gate for the Execute (final send) phase only — Plan/dry-run is
 * unlimited. Enforces the daily cap and the allowed sending window (spec §4-L4
 * pacing, §9 frequency/time-of-day control).
 */
export function canSendNow(now = new Date()): PacingDecision {
  const hour = now.getHours();
  if (!withinSendWindow(hour)) {
    return {
      allowed: false,
      reason: `outside send window (${config.sendWindowStart}-${config.sendWindowEnd}h, now ${hour}h)`,
    };
  }
  const sentToday = sendLedger.countForDay(todayKey(now));
  if (sentToday >= config.dailySendLimit) {
    return { allowed: false, reason: `daily send limit reached (${sentToday}/${config.dailySendLimit})` };
  }
  return { allowed: true };
}

/** Record a completed final send against today's bucket. */
export function recordSend(companyId: number, now = new Date()): void {
  sendLedger.record(companyId, todayKey(now));
}

/** Random inter-send delay (ms) within configured bounds. */
export function nextSendDelayMs(rng: () => number = Math.random): number {
  const { sendMinIntervalMs, sendMaxIntervalMs } = config;
  return Math.floor(sendMinIntervalMs + rng() * (sendMaxIntervalMs - sendMinIntervalMs));
}
