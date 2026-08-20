import { prep, tx } from './db.js';
import type {
  CompanyRow,
  CompanyStatus,
  ContentOverride,
  FormSchema,
  SubmissionStatus,
  SuppressionReason,
} from '../types.js';

/* ------------------------------- companies ------------------------------- */

/** Minimal identity of an already-known company — enough to decide "skip". */
export interface CompanyRef {
  id: number;
  status: CompanyStatus;
  name: string;
}

export const companies = {
  /** Insert or ignore by domain. Returns the row (existing or new). */
  upsert(input: { name: string; domain: string; source?: string; icpScore?: number }): CompanyRow {
    // RETURNING gives us the row from the write itself — the old code followed
    // every upsert with a second SELECT, doubling the query count of an ingest.
    return prep(
      `INSERT INTO companies (name, domain, source, icp_score)
       VALUES (@name, @domain, @source, @icpScore)
       ON CONFLICT(domain) DO UPDATE SET
         name = excluded.name,
         source = COALESCE(excluded.source, companies.source),
         icp_score = COALESCE(excluded.icp_score, companies.icp_score),
         updated_at = datetime('now')
       RETURNING *`,
    ).get({
      name: input.name,
      domain: input.domain,
      source: input.source ?? null,
      icpScore: input.icpScore ?? null,
    }) as CompanyRow;
  },

  byId(id: number): CompanyRow | undefined {
    return prep('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRow | undefined;
  },

  byDomain(domain: string): CompanyRow | undefined {
    return prep('SELECT * FROM companies WHERE domain = ?').get(domain) as CompanyRow | undefined;
  },

  /**
   * Identity-only lookup by domain (index hit, no row materialisation). The
   * "already read this company" check on the ingest hot path.
   */
  refByDomain(domain: string): CompanyRef | undefined {
    return prep('SELECT id, status, name FROM companies WHERE domain = ?').get(domain) as
      | CompanyRef
      | undefined;
  },

  byStatus(status: CompanyStatus, limit = 1000): CompanyRow[] {
    return prep(
      'SELECT * FROM companies WHERE status = ? ORDER BY icp_score DESC, id ASC LIMIT ?',
    ).all(status, limit) as CompanyRow[];
  },

  /**
   * Paged listing across several statuses at once — the 一斉送信 candidate scan
   * (承認待ち + 承認済み + 送信中). Ordered best-first so a capped run sends the
   * highest-ICP companies, with OFFSET so the worker can walk past companies it
   * has already judged un-sendable.
   */
  byStatuses(statuses: CompanyStatus[], limit = 200, offset = 0): CompanyRow[] {
    if (statuses.length === 0) return [];
    const ph = statuses.map(() => '?').join(',');
    return prep(
      `SELECT * FROM companies WHERE status IN (${ph}) ORDER BY icp_score DESC, id ASC LIMIT ? OFFSET ?`,
    ).all(...statuses, limit, offset) as CompanyRow[];
  },

  countByStatuses(statuses: CompanyStatus[]): number {
    if (statuses.length === 0) return 0;
    const ph = statuses.map(() => '?').join(',');
    return (
      prep(`SELECT COUNT(*) AS n FROM companies WHERE status IN (${ph})`).get(...statuses) as {
        n: number;
      }
    ).n;
  },

  setStatus(id: number, status: CompanyStatus): void {
    prep(`UPDATE companies SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  },

  setForm(id: number, formUrl: string, confidence: number): void {
    prep(
      `UPDATE companies SET form_url = ?, form_confidence = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(formUrl, confidence, id);
  },

  all(limit = 5000): CompanyRow[] {
    return prep('SELECT * FROM companies ORDER BY id ASC LIMIT ?').all(limit) as CompanyRow[];
  },

  count(): number {
    return (prep('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n;
  },

  /**
   * Status histogram straight from SQLite. The dashboard used to fetch every
   * company and tally in JS — which both capped out at the row limit (wrong
   * numbers past 5,000社) and shipped megabytes on every 15s refresh.
   */
  countsByStatus(): Record<string, number> {
    const rows = prep('SELECT status, COUNT(*) AS n FROM companies GROUP BY status').all() as {
      status: string;
      n: number;
    }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  },

  /** Server-side paged + filtered listing for the intake overview table. */
  page(opts: { q?: string; status?: string; limit?: number; offset?: number } = {}): {
    rows: CompanyRow[];
    total: number;
  } {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const q = (opts.q ?? '').trim().toLowerCase();
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const status = opts.status?.trim() || null;

    const where =
      `WHERE (@q = '' OR lower(name) LIKE @like ESCAPE '\\' OR lower(domain) LIKE @like ESCAPE '\\')` +
      ` AND (@status IS NULL OR status = @status)`;
    const total = (
      prep(`SELECT COUNT(*) AS n FROM companies ${where}`).get({ q, like, status }) as { n: number }
    ).n;
    const rows = prep(
      `SELECT * FROM companies ${where} ORDER BY id ASC LIMIT @limit OFFSET @offset`,
    ).all({ q, like, status, limit, offset }) as CompanyRow[];
    return { rows, total };
  },
};

/* ------------------------------ field_maps ------------------------------- */

export const fieldMaps = {
  save(companyId: number, schema: FormSchema): number {
    const info = prep(
      `INSERT INTO field_maps
           (company_id, schema_json, has_confirm_screen, has_captcha, mapping_confidence, gate)
         VALUES (@companyId, @schemaJson, @hasConfirm, @hasCaptcha, @conf, @gate)`,
    )
      .run({
        companyId,
        schemaJson: JSON.stringify(schema),
        hasConfirm: schema.hasConfirmScreen ? 1 : 0,
        hasCaptcha: schema.hasCaptcha,
        conf: schema.mappingConfidence,
        gate: schema.gate,
      });
    return Number(info.lastInsertRowid);
  },

  latest(companyId: number): FormSchema | undefined {
    const row = prep(
      'SELECT schema_json FROM field_maps WHERE company_id = ? ORDER BY id DESC LIMIT 1',
    ).get(companyId) as { schema_json: string } | undefined;
    return row ? (JSON.parse(row.schema_json) as FormSchema) : undefined;
  },
};

/* ------------------------------ submissions ------------------------------ */

export const submissions = {
  createPlan(input: {
    companyId: number;
    contentRendered: string;
    planScreenshotUrl: string | null;
  }): number {
    const info = prep(
      `INSERT INTO submissions (company_id, content_rendered, plan_screenshot_url, status)
         VALUES (@companyId, @content, @shot, 'plan_ready')`,
    )
      .run({
        companyId: input.companyId,
        content: input.contentRendered,
        shot: input.planScreenshotUrl,
      });
    return Number(info.lastInsertRowid);
  },

  byId(id: number): any {
    return prep('SELECT * FROM submissions WHERE id = ?').get(id);
  },

  latestForCompany(companyId: number): any {
    return prep('SELECT * FROM submissions WHERE company_id = ? ORDER BY id DESC LIMIT 1').get(
      companyId,
    );
  },

  approve(id: number, approvedBy: string): void {
    prep(`UPDATE submissions SET approved_by = ?, approved_at = datetime('now') WHERE id = ?`).run(
      approvedBy,
      id,
    );
  },

  /** Refresh an existing plan row after a manual edit + re-preview (§13-2 edit). */
  updatePlan(id: number, input: { contentRendered: string; planScreenshotUrl: string | null }): void {
    prep(`UPDATE submissions SET content_rendered = ?, plan_screenshot_url = ? WHERE id = ?`).run(
      input.contentRendered,
      input.planScreenshotUrl,
      id,
    );
  },

  setResult(id: number, status: SubmissionStatus, detail: string): void {
    prep(
      `UPDATE submissions SET status = ?, result_detail = ?, submitted_at = datetime('now') WHERE id = ?`,
    ).run(status, detail, id);
  },

  all(limit = 5000): any[] {
    return prep('SELECT * FROM submissions ORDER BY id ASC LIMIT ?').all(limit);
  },
};

/* ------------------------------ suppression ------------------------------ */

export const suppression = {
  add(domain: string, reason: SuppressionReason): void {
    prep(
      `INSERT INTO suppression (domain, reason) VALUES (?, ?)
         ON CONFLICT(domain) DO NOTHING`,
    ).run(domain.toLowerCase(), reason);
  },

  has(domain: string): { domain: string; reason: string } | undefined {
    return prep('SELECT * FROM suppression WHERE domain = ?').get(domain.toLowerCase()) as
      | { domain: string; reason: string }
      | undefined;
  },

  remove(domain: string): void {
    prep('DELETE FROM suppression WHERE domain = ?').run(domain.toLowerCase());
  },

  all(): { domain: string; reason: string; created_at: string }[] {
    return prep('SELECT * FROM suppression ORDER BY created_at DESC').all() as any[];
  },
};

/* --------------------------- content_overrides --------------------------- */

export const contentOverrides = {
  /** Manual dashboard edits for a company, or undefined if none. */
  get(companyId: number): ContentOverride | undefined {
    const row = prep('SELECT overrides_json FROM content_overrides WHERE company_id = ?').get(
      companyId,
    ) as { overrides_json: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.overrides_json) as ContentOverride;
      return parsed && parsed.values ? parsed : { values: {} };
    } catch {
      return { values: {} };
    }
  },

  set(companyId: number, ov: ContentOverride): void {
    prep(
      `INSERT INTO content_overrides (company_id, overrides_json, updated_at)
         VALUES (@companyId, @json, datetime('now'))
         ON CONFLICT(company_id) DO UPDATE SET
           overrides_json = excluded.overrides_json,
           updated_at = datetime('now')`,
    ).run({ companyId, json: JSON.stringify(ov) });
  },

  clear(companyId: number): void {
    prep('DELETE FROM content_overrides WHERE company_id = ?').run(companyId);
  },
};

/* ------------------------------- audit_log ------------------------------- */

export const audit = {
  log(entry: {
    companyId?: number | null;
    layer?: string;
    action: string;
    actor?: string;
    detail?: string | object;
  }): void {
    prep(
      `INSERT INTO audit_log (company_id, layer, action, actor, detail)
         VALUES (@companyId, @layer, @action, @actor, @detail)`,
    )
      .run({
        companyId: entry.companyId ?? null,
        layer: entry.layer ?? null,
        action: entry.action,
        actor: entry.actor ?? 'system',
        detail:
          entry.detail === undefined
            ? null
            : typeof entry.detail === 'string'
              ? entry.detail
              : JSON.stringify(entry.detail),
      });
  },

  forCompany(companyId: number): any[] {
    return prep('SELECT * FROM audit_log WHERE company_id = ? ORDER BY id ASC').all(companyId);
  },
};

/* ------------------------------ send_ledger ------------------------------ */

export const sendLedger = {
  countForDay(day: string): number {
    const row = prep('SELECT COUNT(*) AS n FROM send_ledger WHERE day = ?').get(day) as {
      n: number;
    };
    return row.n;
  },
  record(companyId: number, day: string): void {
    prep('INSERT INTO send_ledger (company_id, day) VALUES (?, ?)').run(companyId, day);
  },
};

/* --------------------------- import_jobs / rows --------------------------- */

export type ImportRowState =
  | 'pending'
  | 'ingested'
  | 'known'
  | 'suppressed'
  | 'nodomain'
  | 'unresolved'
  | 'done'
  | 'error';

export interface ImportJobRow {
  id: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  phase: 'ingest' | 'resolve' | 'pipeline' | 'done';
  options_json: string;
  total: number;
  counters_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface ImportRowRecord {
  job_id: number;
  seq: number;
  name: string;
  domain: string | null;
  industry: string | null;
  employees: number | null;
  prefecture: string | null;
  source: string | null;
  state: ImportRowState;
  company_id: number | null;
  detail: string | null;
}

export const importJobs = {
  create(input: { total: number; options: object; phase: ImportJobRow['phase'] }): number {
    const info = prep(
      `INSERT INTO import_jobs (status, phase, options_json, total, counters_json)
       VALUES ('running', @phase, @options, @total, '{}')`,
    ).run({ phase: input.phase, options: JSON.stringify(input.options), total: input.total });
    return Number(info.lastInsertRowid);
  },

  byId(id: number): ImportJobRow | undefined {
    return prep('SELECT * FROM import_jobs WHERE id = ?').get(id) as ImportJobRow | undefined;
  },

  latest(): ImportJobRow | undefined {
    return prep('SELECT * FROM import_jobs ORDER BY id DESC LIMIT 1').get() as
      | ImportJobRow
      | undefined;
  },

  /** Jobs interrupted mid-flight (process killed, machine rebooted). */
  unfinished(): ImportJobRow[] {
    return prep(
      `SELECT * FROM import_jobs WHERE status IN ('running','paused') ORDER BY id ASC`,
    ).all() as ImportJobRow[];
  },

  /** Checkpoint: phase + running counters. Called once per chunk, not per row. */
  save(
    id: number,
    patch: {
      status?: ImportJobRow['status'];
      phase?: ImportJobRow['phase'];
      counters?: object;
      /** 再開時にオプションを変更した場合（例: 自動送信の ON/OFF）に上書きする。 */
      options?: object;
      error?: string | null;
      /**
       * 記録済みのエラーを消す。`error: null` は COALESCE で「触らない」の意味に
       * なるため、再開時に前回の失敗理由を消すにはこちらを使う（そうしないと
       * ダッシュボードに古い失敗が残り続ける）。
       */
      clearError?: boolean;
      finished?: boolean;
    },
  ): void {
    prep(
      `UPDATE import_jobs SET
         status        = COALESCE(@status, status),
         phase         = COALESCE(@phase, phase),
         counters_json = COALESCE(@counters, counters_json),
         options_json  = COALESCE(@options, options_json),
         error         = CASE WHEN @clearError = 1 THEN NULL ELSE COALESCE(@error, error) END,
         finished_at   = CASE WHEN @finished = 1 THEN datetime('now') ELSE finished_at END,
         updated_at    = datetime('now')
       WHERE id = @id`,
    ).run({
      id,
      status: patch.status ?? null,
      phase: patch.phase ?? null,
      counters: patch.counters ? JSON.stringify(patch.counters) : null,
      options: patch.options ? JSON.stringify(patch.options) : null,
      error: patch.error ?? null,
      clearError: patch.clearError ? 1 : 0,
      finished: patch.finished ? 1 : 0,
    });
  },

  /** Mark every still-"running" job as paused — used on boot before resuming. */
  pauseAllRunning(): number {
    return prep(`UPDATE import_jobs SET status = 'paused' WHERE status = 'running'`).run().changes;
  },
};

export const importRows = {
  /**
   * Persist the whole pasted list up-front, in ONE transaction. This is the
   * "セーブ": after it returns, the request body can be dropped and the job
   * survives a disconnect, a browser close, or a server restart.
   */
  insertMany(jobId: number, rows: readonly (Omit<ImportRowRecord, 'job_id' | 'seq' | 'state' | 'company_id' | 'detail'> & { seq: number })[]): void {
    const stmt = prep(
      `INSERT INTO import_rows (job_id, seq, name, domain, industry, employees, prefecture, source)
       VALUES (@jobId, @seq, @name, @domain, @industry, @employees, @prefecture, @source)
       ON CONFLICT(job_id, seq) DO NOTHING`,
    );
    tx(() => {
      for (const r of rows) {
        stmt.run({
          jobId,
          seq: r.seq,
          name: r.name,
          domain: r.domain ?? null,
          industry: r.industry ?? null,
          employees: r.employees ?? null,
          prefecture: r.prefecture ?? null,
          source: r.source ?? null,
        });
      }
    });
  },

  /** Next chunk of rows in a given state, ordered by seq (the resume cursor). */
  nextBatch(jobId: number, state: ImportRowState, limit: number): ImportRowRecord[] {
    return prep(
      'SELECT * FROM import_rows WHERE job_id = ? AND state = ? ORDER BY seq ASC LIMIT ?',
    ).all(jobId, state, limit) as ImportRowRecord[];
  },

  setState(
    jobId: number,
    seq: number,
    state: ImportRowState,
    extra: { companyId?: number | null; detail?: string | null; domain?: string | null } = {},
  ): void {
    prep(
      `UPDATE import_rows SET
         state = @state,
         company_id = COALESCE(@companyId, company_id),
         detail = COALESCE(@detail, detail),
         domain = COALESCE(@domain, domain)
       WHERE job_id = @jobId AND seq = @seq`,
    ).run({
      jobId,
      seq,
      state,
      companyId: extra.companyId ?? null,
      detail: extra.detail ?? null,
      domain: extra.domain ?? null,
    });
  },

  /**
   * One domain claimed by several differently-named rows in the same import —
   * the signature of a mis-mapped URL column. Computed in SQL over the saved
   * list so it still works when the job is processed in chunks.
   */
  collisions(jobId: number, limit = 50): { domain: string; names: string[] }[] {
    const rows = prep(
      `SELECT domain, COUNT(DISTINCT name) AS n, GROUP_CONCAT(DISTINCT name) AS names
         FROM import_rows
        WHERE job_id = ? AND domain IS NOT NULL AND domain <> ''
        GROUP BY domain HAVING n > 1
        LIMIT ?`,
    ).all(jobId, limit) as { domain: string; n: number; names: string }[];
    return rows.map((r) => ({ domain: r.domain, names: (r.names ?? '').split(',') }));
  },

  countsByState(jobId: number): Record<string, number> {
    const rows = prep(
      'SELECT state, COUNT(*) AS n FROM import_rows WHERE job_id = ? GROUP BY state',
    ).all(jobId) as { state: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.n;
    return out;
  },

  /** Paged detail listing (未特定/スキップ の一覧) — never dumped wholesale. */
  listByState(
    jobId: number,
    state: ImportRowState,
    limit = 200,
    offset = 0,
  ): ImportRowRecord[] {
    return prep(
      'SELECT * FROM import_rows WHERE job_id = ? AND state = ? ORDER BY seq ASC LIMIT ? OFFSET ?',
    ).all(jobId, state, limit, offset) as ImportRowRecord[];
  },
};

/* ------------------------------ hp_resolutions ---------------------------- */

export interface HpResolution {
  domain: string | null;
  method: string | null;
  confidence: number | null;
}

/**
 * Cache of 会社名 → 公式HP lookups. Each miss costs several web requests, so a
 * re-import of the same list must never pay for them twice — misses are cached
 * too (domain = NULL).
 */
export const hpCache = {
  get(key: string): HpResolution | undefined {
    return prep('SELECT domain, method, confidence FROM hp_resolutions WHERE name_key = ?').get(
      key,
    ) as HpResolution | undefined;
  },

  set(key: string, r: HpResolution): void {
    prep(
      `INSERT INTO hp_resolutions (name_key, domain, method, confidence)
       VALUES (@key, @domain, @method, @confidence)
       ON CONFLICT(name_key) DO UPDATE SET
         domain = excluded.domain, method = excluded.method,
         confidence = excluded.confidence, created_at = datetime('now')`,
    ).run({ key, domain: r.domain, method: r.method, confidence: r.confidence });
  },
};
