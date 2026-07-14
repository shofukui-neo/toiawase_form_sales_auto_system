import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { companies, submissions, fieldMaps, suppression } from '../db/repositories.js';
import { listApproved, approve, reject, suppressCompany, excludeIneligiblePending } from '../pipeline/approval.js';
import { runExecute } from '../pipeline/pipeline.js';
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

  return app;
}

export function serve(port = 4599): void {
  const app = createServer();
  app.listen(port, () => {
    log.info(`承認ダッシュボード: http://localhost:${port}`);
    console.log(`\n  📮 承認ダッシュボードを起動しました → http://localhost:${port}\n`);
  });
}
