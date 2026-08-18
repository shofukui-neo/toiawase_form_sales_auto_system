import { config, loadIcp } from '../config.js';
import { tx } from '../db/db.js';
import {
  audit,
  companies,
  importJobs,
  importRows,
  type ImportJobRow,
  type ImportRowRecord,
} from '../db/repositories.js';
import { ingestOne, resolveHomepageCached, type IngestRow } from '../layers/l0_list.js';
import { normalizeDomain } from '../utils/url.js';
import { discoverAndParse, buildPlan } from './pipeline.js';
import { logger } from '../utils/logger.js';

const log = logger('intake');

/**
 * リスト取り込み (L0) — 再開可能なジョブ。
 *
 * 3万件規模のリストを 1 リクエストで処理すると、終わる前にブラウザ／接続が切れ、
 * 途中まで進んだ結果がどこにも残らない。ここでは
 *
 *   1. 貼り付けられたリストを **最初に丸ごと DB へ保存** し (import_rows)、
 *   2. チャンク単位（既定 500 行 = 1 トランザクション）で処理して都度チェックポイントし、
 *   3. 各行の結果を state として残す
 *
 * ため、接続が切れてもサーバが落ちても「続きから」再開できる。すでに読み込んだ
 * 企業 (companies に存在するドメイン) は再処理しない。
 */

export interface IntakeOptions {
  /** ドメイン未指定の行を Web 検索で補完する。 */
  resolve: boolean;
  acceptUnverified: boolean;
  /** 取り込み後に L1 発見 → L2 解析 → L4 プランまで走らせる。 */
  pipeline: boolean;
  /** すでに取り込み済みの企業をスキップする（既定 ON）。 */
  skipKnown: boolean;
  /** パイプライン処理の並列数。既定は config.intake.concurrency。 */
  concurrency?: number;
}

export interface IntakeCounters {
  // --- L0 ---
  ingested: number;
  alreadyKnown: number;
  suppressed: number;
  skipped: number; // ドメイン無し
  requeued: number;
  hadDomain: number;
  resolved: number;
  resolvedFromCache: number;
  unresolved: number;
  // --- pipeline ---
  pipelineTotal: number;
  done: number;
  pendingApproval: number;
  notFound: number;
  failed: number;
  excluded: number;
  errors: number;
}

export interface IntakeLog {
  company: string;
  status: string;
  detail?: string;
}

export interface IntakeSnapshot extends IntakeCounters {
  jobId: number | null;
  running: boolean;
  status: ImportJobRow['status'] | 'none';
  phase: ImportJobRow['phase'];
  message: string;
  pipeline: boolean;
  /** リストの総行数。 */
  total: number;
  /** L0 で処理し終えた行数（進捗バーの分子）。 */
  ingestDone: number;
  current: string | null;
  /** 直近のログのみ（全件は /api/import/rows で取得）。 */
  logs: IntakeLog[];
  collisions: { domain: string; names: string[] }[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

const emptyCounters = (): IntakeCounters => ({
  ingested: 0, alreadyKnown: 0, suppressed: 0, skipped: 0, requeued: 0,
  hadDomain: 0, resolved: 0, resolvedFromCache: 0, unresolved: 0,
  pipelineTotal: 0, done: 0, pendingApproval: 0, notFound: 0, failed: 0,
  excluded: 0, errors: 0,
});

/** Human label for a company's pipeline status (shared with the dashboard). */
export const STATUS_JA: Record<string, string> = {
  NEW: '新規', DISCOVERING: '発見中', FORM_FOUND: 'フォーム発見', PARSING: '解析中',
  PARSED: '解析済み', PLAN_READY: 'プラン作成中', PENDING_APPROVAL: '承認待ち',
  APPROVED: '承認済み', SUBMITTING: '送信準備', SUBMITTED_SUCCESS: '送信成功',
  SUBMITTED_FAILED: '送信失敗', FORM_NOT_FOUND: 'フォーム未発見', PARSE_FAILED: '解析失敗',
  CAPTCHA_BLOCKED: 'CAPTCHA', NEEDS_REVIEW: '要確認', REJECTED: '却下', SUPPRESSED: '除外',
};

/* --------------------------- in-memory run state -------------------------- */

/** Bounded log ring — 3万件分のログを溜めると status API の応答がそれだけで数MBになる。 */
const MAX_LOGS = 200;

interface RunState {
  jobId: number;
  opts: IntakeOptions;
  counters: IntakeCounters;
  logs: IntakeLog[];
  current: string | null;
  message: string;
  ingestDone: number;
  total: number;
  phase: ImportJobRow['phase'];
  startedAt: string;
  stopRequested: boolean;
  finished: boolean;
  /** Computed once the list has been fully read; static from then on. */
  collisions: { domain: string; names: string[] }[] | null;
  promise: Promise<void> | null;
}

let run: RunState | null = null;

function pushLog(state: RunState, entry: IntakeLog): void {
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
}

/** Hand the event loop back so HTTP polls keep answering during a long ingest. */
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/* ------------------------------ job creation ------------------------------ */

export interface StartResult {
  jobId: number;
  total: number;
}

/**
 * Save the pasted list and start (or queue) processing. Returns as soon as the
 * rows are persisted — the caller's HTTP request never waits for the work.
 */
export function startIntake(rows: IngestRow[], opts: IntakeOptions): StartResult {
  if (run && !run.stopRequested && run.promise) {
    throw new Error('取り込みはすでに実行中です');
  }
  const jobId = importJobs.create({
    total: rows.length,
    options: opts,
    phase: opts.resolve ? 'resolve' : 'ingest',
  });

  // 保存はチャンクに分けて 1 トランザクションずつ。3万行を一括で 1 トランザクション
  // にしても動くが、途中でメモリを掴んだままになるのを避ける。
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    importRows.insertMany(
      jobId,
      slice.map((r, j) => ({
        seq: i + j,
        name: r.name.trim(),
        // 正規化して保存する。以降のドメイン比較・重複検出がすべてこの値で済む。
        domain: r.domain ? normalizeDomain(r.domain) || null : null,
        industry: r.industry ?? null,
        employees: r.employees ?? null,
        prefecture: r.prefecture ?? null,
        source: r.source ?? null,
      })),
    );
  }
  log.info(`ジョブ #${jobId} を作成: ${rows.length} 行を保存 (resolve=${opts.resolve} pipeline=${opts.pipeline})`);
  audit.log({ layer: 'L0', action: 'intake_start', detail: `job=${jobId} rows=${rows.length}` });

  launch(jobId, opts, rows.length);
  return { jobId, total: rows.length };
}

/** Resume a saved job (after a disconnect, a restart, or a manual 中断). */
export function resumeIntake(jobId?: number): StartResult {
  if (run && !run.stopRequested && run.promise) {
    throw new Error('取り込みはすでに実行中です');
  }
  const job = jobId ? importJobs.byId(jobId) : importJobs.unfinished()[0] ?? importJobs.latest();
  if (!job) throw new Error('再開できる取り込みジョブがありません');
  if (job.status === 'done') throw new Error(`ジョブ #${job.id} は完了済みです`);

  const opts = { ...defaultOptions(), ...(JSON.parse(job.options_json || '{}') as Partial<IntakeOptions>) };
  log.info(`ジョブ #${job.id} を再開します`);
  audit.log({ layer: 'L0', action: 'intake_resume', detail: `job=${job.id}` });
  launch(job.id, opts as IntakeOptions, job.total, job);
  return { jobId: job.id, total: job.total };
}

export function defaultOptions(): IntakeOptions {
  return {
    resolve: false,
    acceptUnverified: false,
    pipeline: true,
    skipKnown: true,
    concurrency: config.intake.concurrency,
  };
}

/** Ask the running job to stop at the next checkpoint (progress is kept). */
export function stopIntake(): boolean {
  if (!run || !run.promise) return false;
  run.stopRequested = true;
  run.message = '中断しています…';
  return true;
}

/**
 * On boot: any job still marked `running` was killed mid-flight. Mark it paused
 * and (optionally) pick it back up where it left off.
 */
export function resumeUnfinishedOnBoot(autoResume = true): ImportJobRow | null {
  importJobs.pauseAllRunning();
  const pending = importJobs.unfinished()[0];
  if (!pending) return null;
  const opts = JSON.parse(pending.options_json || '{}') as Partial<IntakeOptions>;
  // Rows left to read, plus (only when the pipeline is on) the ones ingested but
  // not yet discovered.
  const counts = importRows.countsByState(pending.id);
  const remaining = (counts.pending ?? 0) + (opts.pipeline === false ? 0 : counts.ingested ?? 0);
  if (remaining === 0) {
    importJobs.save(pending.id, { status: 'done', phase: 'done', finished: true });
    return null;
  }
  log.info(`未完了の取り込みジョブ #${pending.id} を検出（残り ${remaining} 件）`);
  if (autoResume) {
    try {
      resumeIntake(pending.id);
    } catch (e) {
      log.error(`自動再開に失敗: ${(e as Error).message}`);
    }
  }
  return pending;
}

/* -------------------------------- the worker ------------------------------ */

function launch(jobId: number, opts: IntakeOptions, total: number, job?: ImportJobRow): void {
  const saved = job ? (JSON.parse(job.counters_json || '{}') as Partial<IntakeCounters>) : {};
  const state: RunState = {
    jobId,
    opts,
    counters: { ...emptyCounters(), ...saved },
    logs: [],
    current: null,
    message: opts.resolve ? 'HPを探索しながら取り込み中…' : '取り込み中…',
    ingestDone: 0,
    total,
    phase: job?.phase ?? (opts.resolve ? 'resolve' : 'ingest'),
    startedAt: job?.created_at ?? new Date().toISOString(),
    stopRequested: false,
    finished: false,
    collisions: null,
    promise: null,
  };
  run = state;
  importJobs.save(jobId, { status: 'running' });
  state.promise = worker(state).catch((e) => {
    const msg = (e as Error).message;
    log.error(`intake job #${jobId} failed: ${msg}`);
    importJobs.save(jobId, { status: 'failed', error: msg, finished: true });
    state.message = `失敗: ${msg}`;
    state.finished = true;
  });
}

async function worker(state: RunState): Promise<void> {
  try {
    await ingestPhase(state);
    if (!state.stopRequested && state.opts.pipeline) await pipelinePhase(state);

    if (state.stopRequested) {
      state.message = '中断しました（「再開」で続きから処理します）';
      importJobs.save(state.jobId, { status: 'paused', phase: state.phase, counters: state.counters });
      log.info(`ジョブ #${state.jobId} を中断（再開可能）`);
    } else {
      state.phase = 'done';
      state.message = '完了';
      state.current = null;
      state.finished = true;
      importJobs.save(state.jobId, {
        status: 'done', phase: 'done', counters: state.counters, finished: true,
      });
      log.info(
        `ジョブ #${state.jobId} 完了: 取り込み=${state.counters.ingested} 既存=${state.counters.alreadyKnown} ` +
          `除外=${state.counters.suppressed} スキップ=${state.counters.skipped}`,
      );
    }
  } finally {
    state.promise = null;
  }
}

/** Checkpoint the counters + phase. Called once per chunk, never per row. */
function checkpoint(state: RunState): void {
  importJobs.save(state.jobId, { phase: state.phase, counters: state.counters });
}

/* ------------------------------ phase: ingest ----------------------------- */

async function ingestPhase(state: RunState): Promise<void> {
  const { opts } = state;
  const icp = loadIcp();
  const chunkSize = config.intake.chunkSize;
  state.phase = opts.resolve ? 'resolve' : 'ingest';

  // Rows already processed by an earlier (interrupted) run.
  const before = importRows.countsByState(state.jobId);
  state.ingestDone = state.total - (before.pending ?? 0);

  let lastSeq = -1;
  for (;;) {
    if (state.stopRequested) return;
    const batch = importRows.nextBatch(state.jobId, 'pending', chunkSize);
    if (batch.length === 0) break;
    // Every branch below moves a row out of `pending`; if one ever didn't, this
    // loop would spin on the same chunk forever. Fail loudly instead.
    if (batch[0].seq === lastSeq) {
      throw new Error(`取り込みが進みません (job=${state.jobId} seq=${lastSeq})`);
    }
    lastSeq = batch[0].seq;

    // --- (a) async work first: HP auto-discovery for rows without a domain ---
    // Transactions must stay synchronous, so anything awaiting happens here.
    const resolvedDomains = new Map<number, string | null>();
    if (opts.resolve) {
      const needResolve = batch.filter((r) => !r.domain);
      await mapLimit(needResolve, config.intake.resolveConcurrency, async (r) => {
        if (state.stopRequested) return;
        state.current = r.name;
        state.message = `HP探索中: ${r.name}`;
        const { hp, cached } = await resolveHomepageCached(r.name, {
          industry: r.industry ?? undefined,
          prefecture: r.prefecture ?? undefined,
        });
        const usable = hp && (hp.method === 'search+verified' || opts.acceptUnverified);
        if (usable && hp) {
          resolvedDomains.set(r.seq, hp.domain);
          if (cached) state.counters.resolvedFromCache++;
          else state.counters.resolved++;
        } else {
          resolvedDomains.set(r.seq, null);
          if (hp) {
            pushLog(state, { company: r.name, status: 'HP未確定', detail: `候補: ${hp.domain}` });
          }
        }
      });
    }

    // --- (b) one transaction for the whole chunk ---
    if (state.stopRequested) return;
    tx(() => {
      for (const r of batch) {
        const resolvedDomain = resolvedDomains.has(r.seq) ? resolvedDomains.get(r.seq) : r.domain;
        if (!resolvedDomain) {
          const noHp = opts.resolve && !r.domain;
          if (noHp) state.counters.unresolved++;
          state.counters.skipped++;
          importRows.setState(state.jobId, r.seq, noHp ? 'unresolved' : 'nodomain', {
            detail: noHp ? 'HPを特定できませんでした' : 'ドメイン列が空です',
          });
          continue;
        }
        if (r.domain) state.counters.hadDomain++;

        const row: IngestRow = {
          name: r.name,
          domain: resolvedDomain,
          industry: r.industry ?? undefined,
          employees: r.employees ?? undefined,
          prefecture: r.prefecture ?? undefined,
          source: r.source ?? (r.domain ? undefined : 'hp_auto'),
        };
        const res = ingestOne(row, { icp, skipKnown: opts.skipKnown });
        if (res.requeued) state.counters.requeued++;
        switch (res.outcome) {
          case 'ingested':
            state.counters.ingested++;
            importRows.setState(state.jobId, r.seq, 'ingested', {
              companyId: res.companyId, domain: res.domain, detail: res.detail,
            });
            break;
          case 'known':
            state.counters.alreadyKnown++;
            importRows.setState(state.jobId, r.seq, 'known', {
              companyId: res.companyId, domain: res.domain, detail: res.detail,
            });
            break;
          case 'suppressed':
            state.counters.suppressed++;
            importRows.setState(state.jobId, r.seq, 'suppressed', {
              companyId: res.companyId, domain: res.domain, detail: res.detail,
            });
            break;
          default:
            state.counters.skipped++;
            importRows.setState(state.jobId, r.seq, 'nodomain', { detail: res.detail });
        }
      }
    });

    state.ingestDone += batch.length;
    state.message = `取り込み中… ${state.ingestDone}/${state.total} 件`;
    checkpoint(state);
    await yieldToLoop();
  }

  state.current = null;
  state.message = state.opts.pipeline ? 'フォームを発見して確認プランを作成中…' : '取り込み完了';
  // The whole list has been read, so the mis-mapped-column check is final now.
  // Computing it here (once) keeps it off the 3s status poll.
  state.collisions = importRows.collisions(state.jobId, 20);
}

/* ----------------------------- phase: pipeline ---------------------------- */

async function pipelinePhase(state: RunState): Promise<void> {
  state.phase = 'pipeline';
  const counts = importRows.countsByState(state.jobId);
  state.counters.pipelineTotal = (counts.ingested ?? 0) + state.counters.done;
  checkpoint(state);

  const concurrency = Math.max(1, state.opts.concurrency ?? config.intake.concurrency);
  const chunkSize = Math.max(concurrency * 4, 32);

  let lastSeq = -1;
  for (;;) {
    if (state.stopRequested) return;
    const batch = importRows.nextBatch(state.jobId, 'ingested', chunkSize);
    if (batch.length === 0) break;
    if (batch[0].seq === lastSeq) {
      throw new Error(`フォーム発見処理が進みません (job=${state.jobId} seq=${lastSeq})`);
    }
    lastSeq = batch[0].seq;

    await mapLimit(batch, concurrency, async (r) => {
      if (state.stopRequested) return;
      try {
        await processOne(state, r);
      } catch (e) {
        // One company must never take the job down — record it and move on,
        // otherwise a single bad site costs the remaining 2万件.
        const msg = (e as Error).message;
        state.counters.errors++;
        state.counters.done++;
        pushLog(state, { company: r.name, status: 'error', detail: msg });
        importRows.setState(state.jobId, r.seq, 'error', { detail: msg });
      }
    });
    checkpoint(state);
    await yieldToLoop();
  }
  state.current = null;
}

/** L1 discover → L2 parse → L4 plan for one already-ingested company. */
async function processOne(state: RunState, r: ImportRowRecord): Promise<void> {
  const c = r.company_id ? companies.byId(r.company_id) : undefined;
  if (!c) {
    importRows.setState(state.jobId, r.seq, 'error', { detail: '企業レコードが見つかりません' });
    state.counters.done++;
    state.counters.errors++;
    return;
  }

  // Already past discovery from an earlier import/run — leave it where it is.
  if (c.status !== 'NEW') {
    if (c.status === 'PENDING_APPROVAL' || c.status === 'SUBMITTING') state.counters.pendingApproval++;
    pushLog(state, {
      company: `#${c.id} ${c.name}`,
      status: `${STATUS_JA[c.status] ?? c.status}（処理済み・スキップ）`,
    });
    importRows.setState(state.jobId, r.seq, 'done', { detail: c.status });
    state.counters.done++;
    return;
  }

  state.current = `#${c.id} ${c.name}`;
  let errorDetail: string | undefined;
  try {
    await discoverAndParse(c.id);
    if (companies.byId(c.id)?.status === 'PARSED') await buildPlan(c.id, { autoHighGate: true });
  } catch (e) {
    errorDetail = (e as Error).message;
    state.counters.errors++;
    pushLog(state, { company: `#${c.id} ${c.name}`, status: 'error', detail: errorDetail });
  }

  const st = companies.byId(c.id)?.status ?? 'unknown';
  if (st === 'PENDING_APPROVAL' || st === 'SUBMITTING') state.counters.pendingApproval++;
  else if (st === 'FORM_NOT_FOUND') state.counters.notFound++;
  else if (st === 'PARSE_FAILED') state.counters.failed++;
  else if (st === 'SUPPRESSED') state.counters.excluded++;

  if (!errorDetail) pushLog(state, { company: `#${c.id} ${c.name}`, status: STATUS_JA[st] ?? st });
  importRows.setState(state.jobId, r.seq, errorDetail ? 'error' : 'done', {
    detail: errorDetail ?? st,
  });
  state.counters.done++;
  state.message = `フォーム発見中… ${state.counters.done}/${state.counters.pipelineTotal} 社`;
}

/* -------------------------------- utilities ------------------------------- */

/**
 * Run `fn` over `items` with at most `limit` in flight. The pipeline phase is
 * network/browser-bound: at 3万社 a strictly sequential loop is the difference
 * between days and hours.
 */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/* --------------------------------- status --------------------------------- */

/** Bounded status snapshot for the dashboard poll. Never dumps per-row detail. */
export function intakeStatus(): IntakeSnapshot {
  if (run) {
    const job = importJobs.byId(run.jobId);
    const running = run.promise !== null;
    return {
      ...run.counters,
      jobId: run.jobId,
      running,
      status: running ? 'running' : (job?.status ?? 'paused'),
      phase: run.phase,
      message: run.message,
      pipeline: run.opts.pipeline,
      total: run.total,
      ingestDone: run.ingestDone,
      current: run.current,
      logs: run.logs.slice(-MAX_LOGS),
      // Computed once, when the ingest phase ends — never on the poll path.
      collisions: run.collisions ?? [],
      error: job?.error ?? null,
      startedAt: run.startedAt,
      finishedAt: job?.finished_at ?? null,
    };
  }

  // No job in this process — report the last saved one so a page reload after a
  // restart still shows where the import got to.
  const job = importJobs.latest();
  if (!job) {
    return {
      ...emptyCounters(), jobId: null, running: false, status: 'none', phase: 'done',
      message: '', pipeline: false, total: 0, ingestDone: 0, current: null, logs: [],
      collisions: [], error: null, startedAt: null, finishedAt: null,
    };
  }
  const counters = { ...emptyCounters(), ...(JSON.parse(job.counters_json || '{}') as Partial<IntakeCounters>) };
  const counts = importRows.countsByState(job.id);
  const opts = JSON.parse(job.options_json || '{}') as Partial<IntakeOptions>;
  return {
    ...counters,
    jobId: job.id,
    running: false,
    status: job.status,
    phase: job.phase,
    message:
      job.status === 'paused'
        ? '中断中（「再開」で続きから処理します）'
        : job.status === 'failed'
          ? `失敗: ${job.error ?? ''}`
          : '完了',
    pipeline: opts.pipeline !== false,
    total: job.total,
    ingestDone: job.total - (counts.pending ?? 0),
    current: null,
    logs: [],
    collisions: importRows.collisions(job.id, 20),
    error: job.error,
    startedAt: job.created_at,
    finishedAt: job.finished_at,
  };
}

/** Paged per-row detail for a job (未特定 / スキップ の一覧など). */
export function intakeRows(
  jobId: number,
  state: ImportRowRecord['state'],
  limit = 200,
  offset = 0,
): { rows: { name: string; domain: string | null; detail: string | null }[]; total: number } {
  const counts = importRows.countsByState(jobId);
  const rows = importRows.listByState(jobId, state, limit, offset).map((r) => ({
    name: r.name,
    domain: r.domain,
    detail: r.detail,
  }));
  return { rows, total: counts[state] ?? 0 };
}
