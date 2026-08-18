import type { CompanyRow } from '../types.js';
import { companies, audit } from '../db/repositories.js';
import { canSendNow, nextSendDelayMs } from '../crosscutting/pacing.js';
import { runExecute } from './pipeline.js';
import { approve } from './approval.js';
import { assessSendReadiness, SENDABLE_STATUSES, type SendReadiness } from './readiness.js';
import { intakeStatus } from './intake.js';
import { logger } from '../utils/logger.js';

const log = logger('bulk');

/**
 * 一斉送信ワーカー（随時送信）。
 *
 * 二つの運用要件を満たす:
 *
 *  1. **全項目クリアのみ送信** — 送信直前に readiness ゲート
 *     ({@link assessSendReadiness}) を再評価し、必須の未入力・誤り疑い・非適格・
 *     抑制のいずれかがある企業は 1社も送らない。承認待ちのままでも「全項目
 *     問題なし」なら自動承認して送る（承認の実体をこのゲートが担う）。
 *  2. **随時送信** — `follow` モードでは対象を起動時にスナップショットせず、
 *     送るたびに候補を取り直す。リスト取り込み（L0→L1→L2→Plan）が走っている
 *     間も、準備できた企業から順に送信されていく。取り込みが終わり候補が尽きた
 *     時点で自然に終了する。
 *
 * 送信間隔・日次上限・送信可能時間帯（§9 pacing）は従来どおり全て通す。
 */

export interface BulkSendOptions {
  /** 取り込み中の企業が準備できるのを待ちながら送り続ける（既定 ON）。 */
  follow?: boolean;
  /** この実行での最大送信数（既定は無制限＝日次上限まで）。 */
  limit?: number;
  actor?: string;
}

export interface BulkResult {
  companyId: number;
  name: string;
  status: string;
  detail: string;
  at: string;
}

export interface BulkSnapshot {
  running: boolean;
  follow: boolean;
  stopping: boolean;
  /** 送信を試みた件数。 */
  done: number;
  success: number;
  failed: number;
  skipped: number;
  /** 判定した候補の延べ件数。 */
  scanned: number;
  /** 問題ありで送信対象外と判定された企業数。 */
  blocked: number;
  current: string | null;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  stopReason: string | null;
  /** 直近の結果（最大 200 件）。 */
  results: BulkResult[];
}

/** 候補を取り直す単位。 */
const PAGE = 100;
/** 取り込み待ちの空回りを避ける間隔。 */
const IDLE_WAIT_MS = 5000;
/** 送信時間外・日次上限に当たったときの再確認間隔。 */
const PACE_WAIT_MS = 60_000;
const MAX_RESULTS = 200;

interface BulkState extends BulkSnapshot {
  stopRequested: boolean;
  limit: number;
  actor: string;
  /** 一度「問題あり」と判定した企業（同じ判定を毎周回さないためのキャッシュ）。 */
  blockedIds: Set<number>;
  promise: Promise<void> | null;
}

let state: BulkState | null = null;

function emptyState(opts: Required<Pick<BulkSendOptions, 'follow' | 'actor'>> & { limit: number }): BulkState {
  return {
    running: true,
    follow: opts.follow,
    stopping: false,
    done: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    scanned: 0,
    blocked: 0,
    current: null,
    message: '送信対象を確認しています…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stopReason: null,
    results: [],
    stopRequested: false,
    limit: opts.limit,
    actor: opts.actor,
    blockedIds: new Set(),
    promise: null,
  };
}

/** 中断要求に即座に反応できる待機。 */
async function sleep(ms: number, s: BulkState): Promise<void> {
  const step = 500;
  for (let waited = 0; waited < ms; waited += step) {
    if (s.stopRequested) return;
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
}

function pushResult(s: BulkState, r: Omit<BulkResult, 'at'>): void {
  s.results.push({ ...r, at: new Date().toISOString() });
  if (s.results.length > MAX_RESULTS) s.results.splice(0, s.results.length - MAX_RESULTS);
}

/** 実行中の取り込みジョブがまだ新しい送信候補を生み出しうるか。 */
function intakeStillProducing(): boolean {
  const s = intakeStatus();
  return s.running && s.pipeline;
}

export function bulkStatus(): BulkSnapshot {
  if (!state) {
    return {
      running: false, follow: false, stopping: false, done: 0, success: 0, failed: 0,
      skipped: 0, scanned: 0, blocked: 0, current: null, message: '', startedAt: null,
      finishedAt: null, stopReason: null, results: [],
    };
  }
  const { stopRequested: _s, limit: _l, actor: _a, blockedIds: _b, promise: _p, ...pub } = state;
  return { ...pub, blocked: state.blockedIds.size };
}

export function isBulkRunning(): boolean {
  return !!state?.running;
}

/** 次の区切りで停止する（送信中の1社は最後まで完了させる）。 */
export function stopBulkSend(): boolean {
  if (!state?.running) return false;
  state.stopRequested = true;
  state.stopping = true;
  state.message = '中断しています…';
  return true;
}

export function startBulkSend(opts: BulkSendOptions = {}): { started: boolean; message: string } {
  if (state?.running) return { started: false, message: '一斉送信はすでに実行中です' };
  const s = emptyState({
    follow: opts.follow !== false,
    actor: opts.actor ?? 'auto:all-clean',
    limit: opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY,
  });
  state = s;
  audit.log({ layer: 'L4', action: 'bulk_send_start', actor: s.actor, detail: `follow=${s.follow}` });
  s.promise = worker(s)
    .catch((e) => {
      log.error(`一斉送信が異常終了: ${(e as Error).message}`);
      s.stopReason = `エラー: ${(e as Error).message}`;
    })
    .finally(() => {
      s.running = false;
      s.stopping = false;
      s.current = null;
      s.finishedAt = new Date().toISOString();
      s.message = s.stopReason ?? '完了';
      s.promise = null;
      log.info(`一斉送信 終了: 成功=${s.success} 失敗=${s.failed} スキップ=${s.skipped}（${s.stopReason ?? ''}）`);
      audit.log({
        layer: 'L4', action: 'bulk_send_end', actor: s.actor,
        detail: `success=${s.success} failed=${s.failed} skipped=${s.skipped} ${s.stopReason ?? ''}`,
      });
    });
  return { started: true, message: s.follow ? '一斉送信を開始しました（取り込み中の企業も随時送信します）' : '一斉送信を開始しました' };
}

async function worker(s: BulkState): Promise<void> {
  let offset = 0;
  for (;;) {
    if (s.stopRequested) {
      s.stopReason = '中断しました';
      return;
    }
    if (s.success >= s.limit) {
      s.stopReason = `上限 ${s.limit} 社に到達しました`;
      return;
    }

    // ペーシング（送信時間帯・日次上限）。follow 中は窓が開くのを待つ — 取り込みと
    // 並走させる運用では、時間外に押した一斉送信が黙って終わる方が事故になる。
    const pace = canSendNow();
    if (!pace.allowed) {
      if (!s.follow) {
        s.stopReason = `送信できません: ${pace.reason}`;
        return;
      }
      s.current = null;
      s.message = `送信待機中（${pace.reason}）`;
      // 時間が経てば状況が変わる。判定キャッシュを捨てて全候補を見直す。
      s.blockedIds.clear();
      offset = 0;
      await sleep(PACE_WAIT_MS, s);
      continue;
    }

    const page = companies.byStatuses(SENDABLE_STATUSES, PAGE, offset);
    if (page.length === 0) {
      if (s.follow && intakeStillProducing()) {
        // 取り込み側がまだ企業を作っている。判定キャッシュを捨てて次の周回で
        // 全候補を見直す（② で手直しされた企業もここで拾い直される）。
        s.blockedIds.clear();
        offset = 0;
        s.current = null;
        s.message = '取り込み中 — 準備できた企業から順に送信します';
        await sleep(IDLE_WAIT_MS, s);
        continue;
      }
      s.stopReason = s.done > 0 ? '送信対象がなくなりました' : '送信できる企業がありませんでした';
      return;
    }

    const ready: CompanyRow[] = [];
    for (const c of page) {
      if (s.blockedIds.has(c.id)) continue;
      const r = assessSendReadiness(c);
      s.scanned++;
      if (r.ready) ready.push(c);
      else s.blockedIds.add(c.id);
    }

    if (ready.length === 0) {
      // このページは全て対象外。次のページへ（送信済みで詰まらないよう前進する）。
      offset += page.length;
      s.message = `送信対象を確認中… ${offset} 社を判定`;
      continue;
    }

    // 1社でも送ると候補集合が変わるので、次の周回は必ず先頭（ICP上位）から。
    offset = 0;
    for (const c of ready) {
      if (s.stopRequested || s.success >= s.limit) break;
      const sent = await sendOne(s, c);
      // 送信間隔（§9 anti-burst）。中断要求には即応する。
      if (sent) await sleep(nextSendDelayMs(), s);
    }
  }
}

/** 1社送信。直前に readiness を取り直し、通ったものだけ送る。 */
async function sendOne(s: BulkState, target: CompanyRow): Promise<boolean> {
  const c = companies.byId(target.id);
  if (!c) return false;

  // 判定から送信までの間に編集・却下・抑制が入りうるので、必ず取り直す。
  const check: SendReadiness = assessSendReadiness(c);
  if (!check.ready) {
    s.blockedIds.add(c.id);
    return false;
  }

  s.current = `#${c.id} ${c.name}`;
  s.message = `送信中: ${c.name}`;
  try {
    // 「全項目に問題なし」を根拠とした自動承認。誰の判断で送ったのかが監査に残る。
    if (c.status === 'PENDING_APPROVAL') {
      approve(c.id, s.actor);
      audit.log({
        companyId: c.id, layer: 'L4', action: 'auto_approve', actor: s.actor,
        detail: '全項目クリア（必須充足・誤り疑いなし・適格）',
      });
    }
    await runExecute(c.id);
    const st = companies.byId(c.id)?.status ?? 'unknown';
    if (st === 'SUBMITTED_SUCCESS') {
      s.success++;
      pushResult(s, { companyId: c.id, name: c.name, status: st, detail: '' });
    } else if (st === 'APPROVED' || st === 'SUBMITTING') {
      // runExecute が pacing で送らずに戻ったケース（判定と送信の間に窓が閉じた／
      // 上限に達した）。ブロック扱いにはしない — ループ先頭の pacing 待ちを経て
      // 同じ企業に再挑戦する。
      s.skipped++;
      pushResult(s, { companyId: c.id, name: c.name, status: 'skipped', detail: '送信条件により保留' });
    } else {
      s.failed++;
      pushResult(s, { companyId: c.id, name: c.name, status: st, detail: '' });
    }
  } catch (e) {
    s.failed++;
    s.blockedIds.add(c.id);
    pushResult(s, { companyId: c.id, name: c.name, status: 'error', detail: (e as Error).message });
    log.error(`送信失敗 company=${c.id}: ${(e as Error).message}`);
  }
  s.done++;
  s.current = null;
  return true;
}
