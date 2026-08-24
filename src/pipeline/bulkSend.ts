import type { CompanyRow } from '../types.js';
import { config } from '../config.js';
import { companies, audit } from '../db/repositories.js';
import { canSendNow, nextSendDelayMs } from '../crosscutting/pacing.js';
import { runExecute } from './pipeline.js';
import { approve } from './approval.js';
import { assessSendReadiness, SENDABLE_STATUSES, type SendReadiness } from './readiness.js';
import { intakeStatus } from './intake.js';
import { sleepInterruptible } from '../utils/sleep.js';
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
 *  3. **並列送信** — 送信ワーカーを `config.sendConcurrency` 本立てる。1社の
 *     送信は 30-90 秒（大半がネットワーク待ち）かかるので、直列だとマシンが
 *     ほぼ遊ぶ。候補キューは共有し、`claimed` で一度掴んだ企業を二重に掴まない
 *     ようにする（同じ会社に二重送信しないための一次防壁。最終的な二重送信
 *     防止は送信直前の readiness 再評価と compliance の already_sent）。
 *
 * 送信間隔・日次上限・送信可能時間帯（§9 pacing）は従来どおり全て通す。
 * 送信間隔はワーカーごとに独立して効くので、実効スループットは約 N 倍になる。
 */

export interface BulkSendOptions {
  /** 取り込み中の企業が準備できるのを待ちながら送り続ける（既定 ON）。 */
  follow?: boolean;
  /** この実行での最大送信数（既定は無制限＝日次上限まで）。 */
  limit?: number;
  /** 同時送信数（既定 `config.sendConcurrency`）。 */
  concurrency?: number;
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
  /** 同時送信数（このランの設定値）。 */
  concurrency: number;
  /** いま送信中の企業（並列なので複数ありうる）。 */
  active: string[];
  current: string | null;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  stopReason: string | null;
  /** 直近の結果（最大 200 件）。 */
  results: BulkResult[];
}

/** 候補を取り直す単位（1回の走査で DB から読む件数）。 */
const PAGE = 100;
/** 取り込み待ちの空回りを避ける間隔。 */
const IDLE_WAIT_MS = 5000;
/** 送信時間外・日次上限に当たったときの再確認間隔。 */
const PACE_WAIT_MS = 60_000;
/**
 * ワーカーの立ち上がりをずらす幅（本数 × この値）。全ワーカーが同時に走り出すと
 * 最初の N 件が同一時刻に飛び、§9 が避けたいバーストになる。
 */
const WORKER_STAGGER_MS = 2000;
const MAX_RESULTS = 200;

interface BulkState extends BulkSnapshot {
  stopRequested: boolean;
  limit: number;
  actor: string;
  /** 一度「問題あり」と判定した企業（同じ判定を毎周回さないためのキャッシュ）。 */
  blockedIds: Set<number>;
  /** 判定済みの送信待ち行列。全ワーカーで共有する。 */
  queue: CompanyRow[];
  /** どれかのワーカーが掴んだ企業 ID（二重に掴まないための印）。 */
  claimed: Set<number>;
  /** 走査中の refill。重複走査を避けるため、他のワーカーはこれを待つ。 */
  refilling: Promise<void> | null;
  /** ワーカーに渡した件数（`limit` の判定は成功数ではなくこちらで行う）。 */
  dispatched: number;
  /** 送信中の企業 id -> 表示名。 */
  inFlight: Map<number, string>;
  promise: Promise<void> | null;
}

let state: BulkState | null = null;

function emptyState(
  opts: Required<Pick<BulkSendOptions, 'follow' | 'actor'>> & { limit: number; concurrency: number },
): BulkState {
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
    concurrency: opts.concurrency,
    active: [],
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
    queue: [],
    claimed: new Set(),
    refilling: null,
    dispatched: 0,
    inFlight: new Map(),
    promise: null,
  };
}

/** 中断要求に即座に反応できる待機。 */
const sleep = (ms: number, s: BulkState): Promise<void> =>
  sleepInterruptible(ms, () => s.stopRequested);

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
      skipped: 0, scanned: 0, blocked: 0, concurrency: config.sendConcurrency, active: [],
      current: null, message: '', startedAt: null,
      finishedAt: null, stopReason: null, results: [],
    };
  }
  const {
    stopRequested: _s, limit: _l, actor: _a, blockedIds: _b, queue: _q, claimed: _c,
    refilling: _r, dispatched: _d, inFlight: _i, promise: _p, ...pub
  } = state;
  const active = [...state.inFlight.values()];
  return { ...pub, blocked: state.blockedIds.size, active, current: describeActive(state) };
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
    concurrency: Math.max(1, opts.concurrency ?? config.sendConcurrency),
  });
  state = s;
  audit.log({
    layer: 'L4', action: 'bulk_send_start', actor: s.actor,
    detail: `follow=${s.follow} concurrency=${s.concurrency}`,
  });
  s.promise = runWorkers(s)
    .catch((e) => {
      log.error(`一斉送信が異常終了: ${(e as Error).message}`);
      s.stopReason = `エラー: ${(e as Error).message}`;
    })
    .finally(() => {
      s.running = false;
      s.stopping = false;
      s.inFlight.clear();
      s.current = null;
      s.active = [];
      s.finishedAt = new Date().toISOString();
      s.message = s.stopReason ?? '完了';
      s.promise = null;
      log.info(`一斉送信 終了: 成功=${s.success} 失敗=${s.failed} スキップ=${s.skipped}（${s.stopReason ?? ''}）`);
      audit.log({
        layer: 'L4', action: 'bulk_send_end', actor: s.actor,
        detail: `success=${s.success} failed=${s.failed} skipped=${s.skipped} ${s.stopReason ?? ''}`,
      });
    });
  const par = s.concurrency > 1 ? `${s.concurrency} 並列で` : '';
  return {
    started: true,
    message: s.follow
      ? `一斉送信を開始しました（${par}取り込み中の企業も随時送信します）`
      : `一斉送信を開始しました（${par || '順に'}送信します）`,
  };
}

/** 進捗表示用: いま送信中の企業を 1 行にまとめる。 */
function describeActive(s: BulkState): string | null {
  const names = [...s.inFlight.values()];
  if (names.length === 0) return null;
  return names.length === 1 ? names[0] : `${names[0]} ほか ${names.length - 1} 社`;
}

/**
 * 送信ワーカーを N 本立てて、全部が終わるまで待つ。
 *
 * ワーカーはどれも同じことをする（候補を 1 社取って送る）。候補の取り出しと
 * DB 走査は {@link nextTarget} に集約してあるので、ワーカー同士が同じ企業を
 * 掴んだり、同じページを N 回走査したりはしない。
 */
async function runWorkers(s: BulkState): Promise<void> {
  const n = Math.max(1, Math.min(s.concurrency, 32));
  await Promise.all(Array.from({ length: n }, (_, i) => workerLoop(s, i)));
}

async function workerLoop(s: BulkState, index: number): Promise<void> {
  // 立ち上がりだけずらす（以降は各自の送信間隔で自然にばらける）。
  if (index > 0) await sleep(index * WORKER_STAGGER_MS, s);
  for (;;) {
    const target = await nextTarget(s);
    if (!target) return;
    const sent = await sendOne(s, target);
    // 送信間隔（§9 anti-burst）。ワーカーごとに独立して効くので、全体の送信
    // レートは 概ね concurrency / 平均間隔 になる。中断要求には即応する。
    if (sent) await sleep(nextSendDelayMs(), s);
    if (s.stopRequested) return;
  }
}

/**
 * 次に送る 1 社を返す。無ければ null（＝このワーカーは終了）。
 *
 * ここが「ペーシング待ち」「候補の走査」「取り込み待ちの空回り防止」を全部
 * 引き受ける。ワーカー側は返ってきた 1 社を送ることだけ考えればよい。
 */
async function nextTarget(s: BulkState): Promise<CompanyRow | null> {
  for (;;) {
    if (s.stopRequested) {
      s.stopReason ??= '中断しました';
      return null;
    }
    if (s.dispatched >= s.limit) {
      s.stopReason ??= `上限 ${s.limit} 社に到達しました`;
      return null;
    }

    // ペーシング（送信時間帯・日次上限）。follow 中は窓が開くのを待つ — 取り込みと
    // 並走させる運用では、時間外に押した一斉送信が黙って終わる方が事故になる。
    const pace = canSendNow();
    if (!pace.allowed) {
      if (!s.follow) {
        s.stopReason ??= `送信できません: ${pace.reason}`;
        return null;
      }
      s.message = `送信待機中（${pace.reason}）`;
      // 時間が経てば状況が変わる。判定キャッシュを捨てて全候補を見直す。
      s.blockedIds.clear();
      await sleep(PACE_WAIT_MS, s);
      continue;
    }

    const queued = s.queue.shift();
    if (queued) {
      s.claimed.add(queued.id);
      s.dispatched++;
      return queued;
    }

    // 行列が空。誰か 1 人が走査し、他はその結果を待つ。
    await refill(s);
    if (s.queue.length > 0) continue;

    if (s.follow && intakeStillProducing()) {
      // 取り込み側がまだ企業を作っている。判定キャッシュを捨てて次の周回で
      // 全候補を見直す（② で手直しされた企業もここで拾い直される）。
      s.blockedIds.clear();
      s.message = '取り込み中 — 準備できた企業から順に送信します';
      await sleep(IDLE_WAIT_MS, s);
      continue;
    }
    if (s.inFlight.size > 0) {
      // 他のワーカーがまだ送信中。その結果で状態が変わる（＝候補が増える）ことは
      // ないが、先に終わったワーカーが「対象なし」と結論して停止理由を書き込むと
      // 実態とずれる。送信中の間は待って、本当に打ち止めか見届ける。
      await sleep(IDLE_WAIT_MS, s);
      continue;
    }
    s.stopReason ??= s.done > 0 ? '送信対象がなくなりました' : '送信できる企業がありませんでした';
    return null;
  }
}

/** 走査は同時に 1 本だけ。先客がいればその完了を待つ（DB を N 重に舐めない）。 */
async function refill(s: BulkState): Promise<void> {
  if (s.refilling) {
    await s.refilling;
    return;
  }
  const task = scanForTargets(s);
  s.refilling = task.finally(() => {
    s.refilling = null;
  });
  await s.refilling;
}

/**
 * 送信可能な企業を見つけて `queue` に積む。1社でも積めたら即座に戻る
 * （待っているワーカーを遊ばせないため）。全ページ走査して 0 社なら、
 * 本当に候補が尽きている。
 */
async function scanForTargets(s: BulkState): Promise<void> {
  let offset = 0;
  for (;;) {
    if (s.stopRequested) return;
    const page = companies.byStatuses(SENDABLE_STATUSES, PAGE, offset);
    if (page.length === 0) return;

    let added = 0;
    for (const c of page) {
      // 掴み済み・送信中・判定済みで問題ありの企業は飛ばす。
      if (s.blockedIds.has(c.id) || s.claimed.has(c.id)) continue;
      const r = assessSendReadiness(c);
      s.scanned++;
      if (r.ready) {
        s.queue.push(c);
        added++;
      } else {
        s.blockedIds.add(c.id);
      }
    }
    if (added > 0) return;

    // このページは全て対象外。次のページへ（送信済みで詰まらないよう前進する）。
    offset += page.length;
    s.message = `送信対象を確認中… ${offset} 社を判定`;
  }
}

/**
 * 1社送信。直前に readiness を取り直し、通ったものだけ送る。
 *
 * 並列実行されるので、ここで見る状態は「掴んだ時点」ではなく「いまの DB の値」
 * でなければならない（別のワーカーや ② の操作が間に入りうる）。
 */
async function sendOne(s: BulkState, target: CompanyRow): Promise<boolean> {
  const c = companies.byId(target.id);
  if (!c) return false;

  // 判定から送信までの間に編集・却下・抑制が入りうるので、必ず取り直す。
  const check: SendReadiness = assessSendReadiness(c);
  if (!check.ready) {
    s.blockedIds.add(c.id);
    return false;
  }

  s.inFlight.set(c.id, `#${c.id} ${c.name}`);
  s.current = describeActive(s);
  s.message = `送信中: ${describeActive(s)}`;
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
  } finally {
    s.inFlight.delete(c.id);
    s.current = describeActive(s);
  }
  s.done++;
  return true;
}
