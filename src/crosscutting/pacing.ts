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
 * 既定は 0-24（＝24時間送信）。フォーム送信は相手の受信箱を鳴らさないので、
 * 夜間・営業時間外でも送って構わない、というのが運用上の既定方針。
 *
 * - `start <= 0 && end >= 24`（既定）や `start === end` は「常時開いている」。
 *   `end = 24` を `hour >= 24` で比較すると常に false になる偶然に頼らず、
 *   ここで明示的に開けておく。
 * - `start > end`（例: 20-6）は日をまたぐ夜間帯として扱う。夜だけ送りたい、
 *   という設定を書いたつもりが 1 社も送れない、という事故を防ぐ。
 */
export function withinSendWindow(hour: number): boolean {
  const start = config.sendWindowStart;
  const end = config.sendWindowEnd;
  if (start === end) return true; // 幅ゼロ＝制限なしと解釈する
  if (start <= 0 && end >= 24) return true; // 24時間送信（既定）
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
