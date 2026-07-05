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
 * Pacing gate for the Execute (final send) phase only — Plan/dry-run is
 * unlimited. Enforces the daily cap and the allowed sending window (spec §4-L4
 * pacing, §9 frequency/time-of-day control).
 */
export function canSendNow(now = new Date()): PacingDecision {
  const hour = now.getHours();
  if (hour < config.sendWindowStart || hour >= config.sendWindowEnd) {
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
