import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { companies, submissions, fieldMaps, suppression } from '../db/repositories.js';
import { listApproved, approve, reject, suppressCompany, excludeIneligiblePending } from '../pipeline/approval.js';
import { runExecute } from '../pipeline/pipeline.js';
import { canSendNow, nextSendDelayMs } from '../crosscutting/pacing.js';
import { computeCoverage } from '../layers/coverage.js';
import { classifyEligibility } from '../crosscutting/eligibility.js';
import { transition } from '../core/stateMachine.js';
import { buildReview } from './review.js';
import type { CompanyRow, SuppressionReason } from '../types.js';
import { logger } from '../utils/logger.js';

const log = logger('web');
const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bulk-send ("一斉送信") job state. A single click executes every APPROVED /
 * SUBMITTING company (the ones whose form is filled AND human-approved), reusing
 * the same per-send compliance + pacing gates as the CLI `execute` batch. The
 * job runs in the background so the request returns immediately and the
 * dashboard polls `/api/execute-all/status` for live progress.
 */
interface BulkResult {
  companyId: number;
  name: string;
  status: string;
  detail: string;
}
interface BulkState {
  running: boolean;
  total: number;
  done: number;
  success: number;
  failed: number;
  skipped: number;
  current: string | null;
  startedAt: string;
  finishedAt: string | null;
  results: BulkResult[];
}
let bulk: BulkState | null = null;

/** Sequentially execute a batch with pacing between sends; updates `bulk`. */
async function runBulk(batch: CompanyRow[]): Promise<void> {
  bulk = {
    running: true,
    total: batch.length,
    done: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    current: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };
  for (let i = 0; i < batch.length; i++) {
    const c = companies.byId(batch[i].id);
    // Skip anything no longer sendable (rejected/suppressed/already sent between clicks).
    if (!c || !['APPROVED', 'SUBMITTING'].includes(c.status)) {
      bulk.done++;
      continue;
    }
    // Stop early if the send window closed or the daily cap filled mid-run —
    // mark the rest as skipped rather than looping through no-op sends.
    const pace = canSendNow();
    if (!pace.allowed) {
      for (let j = i; j < batch.length; j++) {
        const rest = companies.byId(batch[j].id);
        bulk.results.push({
          companyId: batch[j].id,
          name: rest?.name ?? String(batch[j].id),
          status: 'skipped',
          detail: pace.reason ?? '',
        });
      }
      bulk.skipped += batch.length - i;
      bulk.done = batch.length;
      break;
    }
    bulk.current = `#${c.id} ${c.name}`;
    try {
      await runExecute(c.id);
      const after = companies.byId(c.id);
      const st = after?.status ?? 'unknown';
      bulk.results.push({ companyId: c.id, name: c.name, status: st, detail: '' });
      if (st === 'SUBMITTED_SUCCESS') bulk.success++;
      else if (st === 'APPROVED' || st === 'SUBMITTING') bulk.skipped++; // pacing/no-op, retry next run
      else bulk.failed++;
    } catch (e) {
      bulk.results.push({ companyId: c.id, name: c.name, status: 'error', detail: (e as Error).message });
      bulk.failed++;
    }
    bulk.done++;
    // Pacing: random inter-send delay, but not after the last one (§9 anti-burst).
    if (i < batch.length - 1) await sleep(nextSendDelayMs());
  }
  bulk.current = null;
  bulk.running = false;
  bulk.finishedAt = new Date().toISOString();
}

/**
 * A (spec §13-2): Web approval dashboard. Thin HTTP layer over the same
 * approval operations the CLI uses — screenshot preview, approve / reject /
 * suppress, and per-company Execute (respecting compliance + pacing).
 */
export function createServer() {
  const app = express();
  app.use(express.json());

  // Serve Plan screenshots (and any artifact) read-only.
  app.use('/artifacts', express.static(config.artifactsDir));

  const html = readFileSync(resolve(__dirname, 'dashboard.html'), 'utf8');
  app.get('/', (_req, res) => res.type('html').send(html));

  app.get('/api/status', (_req, res) => {
    const counts: Record<string, number> = {};
    for (const c of companies.all()) counts[c.status] = (counts[c.status] ?? 0) + 1;
    const pace = canSendNow();
    counts['_送信可'] = pace.allowed ? 1 : 0;
    res.json(counts);
  });

  // Field-by-field review for each pending plan: what value goes into each
  // blank the form actually asks for, with mis-mapping / coverage flags.
  app.get('/api/pending', (_req, res) => {
    const items = companies.byStatus('PENDING_APPROVAL', 100).map((c) => {
      const schema = fieldMaps.latest(c.id);
      const sub = submissions.latestForCompany(c.id);
      if (!schema) {
        return {
          companyId: c.id, name: c.name, domain: c.domain, formUrl: c.form_url,
          gate: 'unknown', mappingConfidence: 0, hasConfirmScreen: false, hasCaptcha: 'none',
          screenshot: sub?.plan_screenshot_url ?? null, subject: '', body: sub?.content_rendered ?? '',
          submissionId: sub?.id ?? null, fields: [],
          coverage: { requiredTotal: 0, requiredFilled: 0, missing: 0, suspect: 0, honeypots: 0 },
        };
      }
      return buildReview(c, schema, sub);
    });
    res.json(items);
  });
  app.get('/api/approved', (_req, res) => res.json(listApproved()));

  // Auto-excluded (non-B2B / CAPTCHA / un-fillable) forms, with the reason.
  app.get('/api/excluded', (_req, res) => {
    const items = suppression
      .all()
      .filter((s) => s.reason === 'ineligible_form')
      .map((s) => {
        const c = companies.byDomain(s.domain);
        if (!c) return null;
        const schema = fieldMaps.latest(c.id);
        const elig = schema ? classifyEligibility(schema, computeCoverage(c, schema)) : undefined;
        return { companyId: c.id, name: c.name, domain: c.domain, reason: elig?.reason ?? 'ineligible', detail: elig?.detail ?? '' };
      })
      .filter(Boolean);
    res.json(items);
  });

  // Run the eligibility sweep on demand (mirror of the pipeline gate).
  app.post('/api/sweep', (_req, res) => {
    const excluded = excludeIneligiblePending();
    res.json({ excluded: excluded.length, items: excluded });
  });

  const approver = () => process.env.USER_EMAIL || 'dashboard';

  app.post('/api/companies/:id/approve', (req, res) => {
    try {
      approve(Number(req.params.id), approver());
      res.json({ ok: true });
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  });

  app.post('/api/companies/:id/reject', (req, res) => {
    try {
      reject(Number(req.params.id), approver(), req.body?.note ?? '');
      res.json({ ok: true });
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  });

  app.post('/api/companies/:id/suppress', (req, res) => {
    try {
      const reason = (req.body?.reason ?? 'opt_out') as SuppressionReason;
      suppressCompany(Number(req.params.id), reason, approver());
      res.json({ ok: true });
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  });

  // Put an auto-excluded company back into the approval queue (override).
  app.post('/api/companies/:id/requeue', (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = companies.byId(id);
      if (!c) throw new Error(`company ${id} not found`);
      suppression.remove(c.domain);
      transition(id, 'PENDING_APPROVAL', { force: true, actor: approver(), detail: 'manual requeue' });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  });

  // Execute a single company's final submission now (still gated by pacing/compliance).
  app.post('/api/companies/:id/execute', async (req, res) => {
    const id = Number(req.params.id);
    try {
      await runExecute(id);
      const c = companies.byId(id);
      res.json({ status: c?.status, detail: '' });
    } catch (e) {
      res.status(500).json({ status: 'error', detail: (e as Error).message });
    }
  });

  // 一斉送信: fire-and-forget bulk send of every APPROVED/SUBMITTING company.
  // Returns immediately; progress is polled from /api/execute-all/status.
  app.post('/api/execute-all', (_req, res) => {
    if (bulk?.running) {
      return res.json({ started: 0, message: '一斉送信はすでに実行中です', running: true });
    }
    const batch = [...companies.byStatus('APPROVED'), ...companies.byStatus('SUBMITTING')];
    if (batch.length === 0) {
      return res.json({ started: 0, message: '送信対象（承認済み）がありません' });
    }
    const pace = canSendNow();
    if (!pace.allowed) {
      return res.json({ started: 0, message: `送信できません: ${pace.reason}` });
    }
    void runBulk(batch).catch((e) => log.error(`bulk send failed: ${(e as Error).message}`));
    log.info(`一斉送信を開始: ${batch.length} 社`);
    return res.json({ started: batch.length });
  });

  app.get('/api/execute-all/status', (_req, res) => {
    res.json(bulk ?? { running: false });
  });

  return app;
}

export function serve(port = 4599): void {
  const app = createServer();
  app.listen(port, () => {
    log.info(`承認ダッシュボード: http://localhost:${port}`);
    console.log(`\n  📮 承認ダッシュボードを起動しました → http://localhost:${port}\n`);
  });
}
