import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { companies, submissions, fieldMaps, suppression, contentOverrides, audit } from '../db/repositories.js';
import { listApproved, approve, reject, suppressCompany, excludeIneligiblePending } from '../pipeline/approval.js';
import { runExecute } from '../pipeline/pipeline.js';
import {
  STATUS_JA,
  defaultOptions,
  intakeRows,
  intakeStatus,
  resumeIntake,
  resumeUnfinishedOnBoot,
  startIntake,
  stopIntake,
  type IntakeOptions,
} from '../pipeline/intake.js';
import { startBulkSend, stopBulkSend, bulkStatus, isBulkRunning } from '../pipeline/bulkSend.js';
import { sendabilitySnapshot, assessSendReadiness } from '../pipeline/readiness.js';
import { parseCompaniesList } from '../layers/l0_list.js';
import type { ImportRowState } from '../db/repositories.js';
import { normalizeDomain } from '../utils/url.js';
import { renderContent } from '../layers/l3_content.js';
import { planSubmission } from '../layers/l4_submit.js';
import type { ContentOverride, FieldRole } from '../types.js';
import { canSendNow } from '../crosscutting/pacing.js';
import { computeCoverage } from '../layers/coverage.js';
import { classifyEligibility } from '../crosscutting/eligibility.js';
import { transition } from '../core/stateMachine.js';
import { buildReview } from './review.js';
import type { SuppressionReason } from '../types.js';
import { logger } from '../utils/logger.js';

const log = logger('web');
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A (spec §13-2): Web approval dashboard. Thin HTTP layer over the same
 * approval operations the CLI uses — screenshot preview, approve / reject /
 * suppress, and per-company Execute (respecting compliance + pacing).
 */
export function createServer() {
  const app = express();
  // 企業リストは JSON 本文としてまるごと POST される。express の既定上限 100kb は
  // 日本語 CSV でおよそ 1,000 社で超え、取り込みが 413 (HTML のスタックトレース)
  // で落ちる — 実運用のリストが通るサイズまで広げる。
  app.use(express.json({ limit: '32mb' }));

  // Serve Plan screenshots (and any artifact) read-only.
  app.use('/artifacts', express.static(config.artifactsDir));

  const html = readFileSync(resolve(__dirname, 'dashboard.html'), 'utf8');
  app.get('/', (_req, res) => res.type('html').send(html));

  app.get('/api/status', (_req, res) => {
    // GROUP BY in SQLite — the old version fetched every company row and tallied
    // in JS, which both capped at the query limit (wrong totals past 5,000社)
    // and re-serialised the whole table on every dashboard refresh.
    const counts: Record<string, number> = companies.countsByStatus();
    const pace = canSendNow();
    counts['_送信可'] = pace.allowed ? 1 : 0;
    res.json(counts);
  });

  // リスト取り込み: parse a pasted / uploaded list, SAVE it, and kick off a
  // resumable background job (L0 ingest → optional L1/L2/L4-Plan). Returns as
  // soon as the list is persisted; the dashboard polls /api/import/status.
  app.post('/api/import', (req, res) => {
    const text = String(req.body?.text ?? '');
    const { rows } = parseCompaniesList(text);
    if (rows.length === 0) {
      return res.json({ started: 0, message: '企業が見つかりません（会社名の列が必要です）' });
    }
    const opts: IntakeOptions = {
      ...defaultOptions(),
      resolve: req.body?.resolve === true,
      acceptUnverified: req.body?.acceptUnverified === true,
      pipeline: req.body?.pipeline !== false, // default on
      skipKnown: req.body?.skipKnown !== false, // default on: 一度読んだ企業は再処理しない
      // 随時送信: 取り込みと並走して、準備できた（全項目クリアの）企業から送る。
      // オプションに載せるとジョブに保存され、中断→再開・サーバ再起動でも復活する。
      autoSend: req.body?.autoSend === true,
      autoSendActor: `auto:${approver()}`,
    };
    try {
      const { jobId, total } = startIntake(rows, opts);
      log.info(`リスト取り込みを開始: job=#${jobId} ${total} 社 (resolve=${opts.resolve} pipeline=${opts.pipeline} autoSend=${opts.autoSend})`);
      return res.json({ started: total, jobId, autoSend: !!opts.autoSend && opts.pipeline });
    } catch (e) {
      return res.json({ started: 0, message: (e as Error).message, running: true });
    }
  });

  app.get('/api/import/status', (_req, res) => res.json(intakeStatus()));

  // 中断: stop at the next checkpoint. Everything processed so far is saved.
  app.post('/api/import/stop', (_req, res) => {
    const stopped = stopIntake();
    res.json({ ok: stopped, message: stopped ? '次の区切りで中断します' : '実行中の取り込みはありません' });
  });

  // 再開: continue a paused / interrupted job from where it stopped.
  app.post('/api/import/resume', (req, res) => {
    try {
      const jobId = req.body?.jobId ? Number(req.body.jobId) : undefined;
      // 再開のついでに自動送信を切り替えられる。未指定なら保存済みの設定のまま。
      const override =
        req.body?.autoSend === undefined
          ? undefined
          : { autoSend: req.body.autoSend === true, autoSendActor: `auto:${approver()}` };
      const r = resumeIntake(jobId, override);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Paged per-row detail of a job (HP未特定 / スキップ の一覧). Never returned
  // inline with the status poll — at 3万件 that payload alone kills the tab.
  app.get('/api/import/rows', (req, res) => {
    const jobId = Number(req.query.jobId ?? intakeStatus().jobId ?? 0);
    if (!jobId) return res.json({ rows: [], total: 0 });
    const state = String(req.query.state ?? 'unresolved') as ImportRowState;
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    res.json(intakeRows(jobId, state, limit, offset));
  });

  // Preview a pasted list without ingesting — how many rows parse, which columns
  // were recognised, and whether several companies would land on one domain
  // (the signature of a mis-mapped URL column). Lets the operator sanity-check
  // the mapping before committing.
  app.post('/api/import/preview', (req, res) => {
    const text = String(req.body?.text ?? '');
    // One parse for rows AND columns (it used to be three passes over the text).
    const { rows, columns } = parseCompaniesList(text);
    const byDomain = new Map<string, Set<string>>();
    let withDomain = 0;
    for (const r of rows) {
      if (!r.domain) continue;
      withDomain++;
      const d = normalizeDomain(r.domain);
      let set = byDomain.get(d);
      if (!set) byDomain.set(d, (set = new Set()));
      // Cap per-domain name collection: a mis-mapped URL column puts all 3万件
      // on one domain, and we only ever display a handful.
      if (set.size < 5) set.add(r.name);
    }
    const collisions: { domain: string; names: string[] }[] = [];
    for (const [domain, names] of byDomain) {
      if (names.size > 1 && collisions.length < 20) collisions.push({ domain, names: [...names] });
    }
    res.json({ total: rows.length, withDomain, columns, collisions, sample: rows.slice(0, 8) });
  });

  // Companies with their pipeline status — the intake tab's overview table.
  // Paged and filtered server-side: returning 3万行 of JSON on every tab switch
  // is what made the dashboard hang on a large list.
  app.get('/api/companies', (req, res) => {
    const { rows, total } = companies.page({
      q: req.query.q ? String(req.query.q) : '',
      status: req.query.status ? String(req.query.status) : undefined,
      limit: Number(req.query.limit ?? 200) || 200,
      offset: Number(req.query.offset ?? 0) || 0,
    });
    res.json({
      total,
      grandTotal: companies.count(),
      items: rows.map((c) => ({
        id: c.id, name: c.name, domain: c.domain, status: c.status,
        statusJa: STATUS_JA[c.status] ?? c.status, icpScore: c.icp_score, formUrl: c.form_url,
      })),
    });
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
          submissionId: sub?.id ?? null, fields: [], editable: [], edited: false,
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

  // Roles a human may edit from the dashboard (whitelist — never accept arbitrary keys).
  const EDITABLE_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>([
    'company', 'name', 'kana', 'email', 'phone', 'postal', 'address', 'department', 'subject', 'message',
  ]);

  // Save manual edits (role -> value). Merges with any existing override; the
  // field-matching view (and future plan/execute) picks these up immediately.
  app.put('/api/companies/:id/content', (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = companies.byId(id);
      if (!c) throw new Error(`company ${id} not found`);
      const incoming = (req.body?.values ?? {}) as Record<string, unknown>;
      const cur = contentOverrides.get(id)?.values ?? {};
      const merged: Partial<Record<FieldRole, string>> = { ...cur };
      let changed = 0;
      for (const [role, val] of Object.entries(incoming)) {
        if (!EDITABLE_ROLES.has(role as FieldRole)) continue;
        merged[role as FieldRole] = String(val ?? '');
        changed++;
      }
      if (changed === 0) throw new Error('編集可能な項目が指定されていません');
      const ov: ContentOverride = { values: merged };
      contentOverrides.set(id, ov);
      audit.log({ companyId: id, layer: 'web', action: 'content_edit', actor: approver(), detail: Object.keys(incoming).join(',') });
      res.json({ ok: true, edited: true });
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  });

  // Discard all manual edits for a company (restore the deterministic render).
  app.post('/api/companies/:id/content/reset', (req, res) => {
    try {
      const id = Number(req.params.id);
      contentOverrides.clear(id);
      audit.log({ companyId: id, layer: 'web', action: 'content_reset', actor: approver() });
      res.json({ ok: true, edited: false });
    } catch (e) {
      res.status(400).send((e as Error).message);
    }
  });

  // Re-run the Plan dry-run with current (edited) content so the preview
  // screenshot reflects the edits. Still never performs a final submit.
  app.post('/api/companies/:id/replan', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = companies.byId(id);
      if (!c) throw new Error(`company ${id} not found`);
      if (c.status !== 'PENDING_APPROVAL') throw new Error(`#${id} は ${c.status} のため再プレビューできません`);
      const schema = fieldMaps.latest(id);
      if (!schema) throw new Error(`no schema for #${id}`);
      const content = renderContent(c, schema);
      const plan = await planSubmission(c, schema, content);
      const sub = submissions.latestForCompany(id);
      if (sub) submissions.updatePlan(sub.id, { contentRendered: content.body, planScreenshotUrl: plan.screenshotPath });
      audit.log({ companyId: id, layer: 'web', action: 'replan', actor: approver(), detail: plan.strategy });
      res.json({ ok: true, screenshot: plan.screenshotPath });
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

  // 単体送信（送信タブ）。一斉送信と同じゲートを通し、全項目クリアなら承認待ちの
  // ままでも自動承認して送る。問題があれば理由を返して送らない。
  app.post('/api/companies/:id/send', async (req, res) => {
    const id = Number(req.params.id);
    try {
      const c = companies.byId(id);
      if (!c) throw new Error(`company ${id} not found`);
      const check = assessSendReadiness(c);
      if (!check.ready) {
        return res.status(400).json({
          status: 'blocked',
          detail: check.issues.map((i) => i.label).join(' / '),
        });
      }
      if (c.status === 'PENDING_APPROVAL') {
        approve(id, `auto:${approver()}`);
        audit.log({ companyId: id, layer: 'L4', action: 'auto_approve', actor: approver(), detail: '全項目クリア（単体送信）' });
      }
      await runExecute(id);
      res.json({ status: companies.byId(id)?.status, detail: '' });
    } catch (e) {
      res.status(500).json({ status: 'error', detail: (e as Error).message });
    }
  });

  // 送信可否の一覧: 「全項目に問題なし」で一斉送信の対象になる企業と、
  // 問題があって送信されない企業（理由付き）。取り込み中でも随時更新される。
  app.get('/api/sendable', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    const snap = sendabilitySnapshot(limit);
    const pace = canSendNow();
    res.json({ ...snap, paceAllowed: pace.allowed, paceReason: pace.reason ?? null, sending: isBulkRunning() });
  });

  // 一斉送信: 全項目クリアの企業だけを、承認待ちのものも含めて順に送る。
  // follow=true（既定）なら取り込み中の企業が準備でき次第そのまま送り続ける。
  // 即座に返り、進捗は /api/execute-all/status をポーリングする。
  app.post('/api/execute-all', (req, res) => {
    if (isBulkRunning()) {
      return res.json({ started: 0, message: '一斉送信はすでに実行中です', running: true });
    }
    const follow = req.body?.follow !== false;
    const limit = Number(req.body?.limit) || undefined;
    // 送信待ちが 1 社も無く、取り込みも動いていないなら押し損 — その場で伝える。
    // truncated（候補が上位 N 社で打ち切られている）場合は「0 社」と断定できないので、
    // ワーカーに全件走査させる。
    const snap = sendabilitySnapshot(200);
    if (snap.readyCount === 0 && !snap.truncated && !intakeStatus().running) {
      return res.json({
        started: 0,
        message: snap.candidateTotal
          ? `送信できる企業がありません（${snap.blockedCount} 社は項目に問題あり）`
          : '送信対象がありません',
      });
    }
    const r = startBulkSend({ follow, limit, actor: `auto:${approver()}` });
    if (!r.started) return res.json({ started: 0, message: r.message, running: true });
    log.info(`一斉送信を開始 (follow=${follow}) — 送信可能 ${snap.readyCount} 社`);
    return res.json({ started: snap.readyCount || 1, follow, message: r.message });
  });

  app.post('/api/execute-all/stop', (_req, res) => {
    const stopped = stopBulkSend();
    res.json({ ok: stopped, message: stopped ? '次の送信区切りで中断します' : '実行中の一斉送信はありません' });
  });

  app.get('/api/execute-all/status', (_req, res) => {
    res.json(bulkStatus());
  });

  // Body-parser failures (oversized list, truncated JSON) otherwise answer with an
  // HTML stack trace, which the dashboard shows verbatim in a toast. Answer JSON
  // with a message that says what to do about it.
  app.use((err: Error & { type?: string; status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.too.large') {
      log.error('リストが大きすぎます (413)');
      return res.status(413).json({ error: 'リストが大きすぎます（1回あたり32MBまで）。分割して取り込んでください。' });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'リクエストの形式が不正です。' });
    }
    log.error(`unhandled: ${err?.message ?? err}`);
    return res.status(err?.status ?? 500).json({ error: err?.message ?? 'サーバーエラー' });
  });

  return app;
}

export function serve(port = 4599): void {
  const app = createServer();
  app.listen(port, () => {
    log.info(`承認ダッシュボード: http://localhost:${port}`);
    console.log(`\n  📮 承認ダッシュボードを起動しました → http://localhost:${port}\n`);
    // A list of 3万件 outlives any single process run. If the previous one was
    // killed mid-import, pick it up from the last checkpoint instead of asking
    // the operator to paste (and re-process) the whole list again.
    const resumed = resumeUnfinishedOnBoot(true);
    if (resumed) {
      console.log(`  ↻ 未完了の取り込み #${resumed.id} を再開しました（続きから処理します）\n`);
    }
  });
}
