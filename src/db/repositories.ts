import { db } from './db.js';
import type {
  CompanyRow,
  CompanyStatus,
  ContentOverride,
  FormSchema,
  SubmissionStatus,
  SuppressionReason,
} from '../types.js';

/* ------------------------------- companies ------------------------------- */

export const companies = {
  /** Insert or ignore by domain. Returns the row (existing or new). */
  upsert(input: { name: string; domain: string; source?: string; icpScore?: number }): CompanyRow {
    const d = db();
    d.prepare(
      `INSERT INTO companies (name, domain, source, icp_score)
       VALUES (@name, @domain, @source, @icpScore)
       ON CONFLICT(domain) DO UPDATE SET
         name = excluded.name,
         source = COALESCE(excluded.source, companies.source),
         icp_score = COALESCE(excluded.icp_score, companies.icp_score),
         updated_at = datetime('now')`,
    ).run({
      name: input.name,
      domain: input.domain,
      source: input.source ?? null,
      icpScore: input.icpScore ?? null,
    });
    return this.byDomain(input.domain)!;
  },

  byId(id: number): CompanyRow | undefined {
    return db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRow | undefined;
  },

  byDomain(domain: string): CompanyRow | undefined {
    return db().prepare('SELECT * FROM companies WHERE domain = ?').get(domain) as
      | CompanyRow
      | undefined;
  },

  byStatus(status: CompanyStatus, limit = 1000): CompanyRow[] {
    return db()
      .prepare('SELECT * FROM companies WHERE status = ? ORDER BY icp_score DESC, id ASC LIMIT ?')
      .all(status, limit) as CompanyRow[];
  },

  setStatus(id: number, status: CompanyStatus): void {
    db()
      .prepare(`UPDATE companies SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id);
  },

  setForm(id: number, formUrl: string, confidence: number): void {
    db()
      .prepare(
        `UPDATE companies SET form_url = ?, form_confidence = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(formUrl, confidence, id);
  },

  all(limit = 5000): CompanyRow[] {
    return db().prepare('SELECT * FROM companies ORDER BY id ASC LIMIT ?').all(limit) as CompanyRow[];
  },
};

/* ------------------------------ field_maps ------------------------------- */

export const fieldMaps = {
  save(companyId: number, schema: FormSchema): number {
    const info = db()
      .prepare(
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
    const row = db()
      .prepare('SELECT schema_json FROM field_maps WHERE company_id = ? ORDER BY id DESC LIMIT 1')
      .get(companyId) as { schema_json: string } | undefined;
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
    const info = db()
      .prepare(
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
    return db().prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  },

  latestForCompany(companyId: number): any {
    return db()
      .prepare('SELECT * FROM submissions WHERE company_id = ? ORDER BY id DESC LIMIT 1')
      .get(companyId);
  },

  approve(id: number, approvedBy: string): void {
    db()
      .prepare(`UPDATE submissions SET approved_by = ?, approved_at = datetime('now') WHERE id = ?`)
      .run(approvedBy, id);
  },

  /** Refresh an existing plan row after a manual edit + re-preview (§13-2 edit). */
  updatePlan(id: number, input: { contentRendered: string; planScreenshotUrl: string | null }): void {
    db()
      .prepare(`UPDATE submissions SET content_rendered = ?, plan_screenshot_url = ? WHERE id = ?`)
      .run(input.contentRendered, input.planScreenshotUrl, id);
  },

  setResult(id: number, status: SubmissionStatus, detail: string): void {
    db()
      .prepare(
        `UPDATE submissions SET status = ?, result_detail = ?, submitted_at = datetime('now') WHERE id = ?`,
      )
      .run(status, detail, id);
  },

  all(limit = 5000): any[] {
    return db().prepare('SELECT * FROM submissions ORDER BY id ASC LIMIT ?').all(limit);
  },
};

/* ------------------------------ suppression ------------------------------ */

export const suppression = {
  add(domain: string, reason: SuppressionReason): void {
    db()
      .prepare(
        `INSERT INTO suppression (domain, reason) VALUES (?, ?)
         ON CONFLICT(domain) DO NOTHING`,
      )
      .run(domain.toLowerCase(), reason);
  },

  has(domain: string): { domain: string; reason: string } | undefined {
    return db().prepare('SELECT * FROM suppression WHERE domain = ?').get(domain.toLowerCase()) as
      | { domain: string; reason: string }
      | undefined;
  },

  remove(domain: string): void {
    db().prepare('DELETE FROM suppression WHERE domain = ?').run(domain.toLowerCase());
  },

  all(): { domain: string; reason: string; created_at: string }[] {
    return db().prepare('SELECT * FROM suppression ORDER BY created_at DESC').all() as any[];
  },
};

/* --------------------------- content_overrides --------------------------- */

export const contentOverrides = {
  /** Manual dashboard edits for a company, or undefined if none. */
  get(companyId: number): ContentOverride | undefined {
    const row = db()
      .prepare('SELECT overrides_json FROM content_overrides WHERE company_id = ?')
      .get(companyId) as { overrides_json: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.overrides_json) as ContentOverride;
      return parsed && parsed.values ? parsed : { values: {} };
    } catch {
      return { values: {} };
    }
  },

  set(companyId: number, ov: ContentOverride): void {
    db()
      .prepare(
        `INSERT INTO content_overrides (company_id, overrides_json, updated_at)
         VALUES (@companyId, @json, datetime('now'))
         ON CONFLICT(company_id) DO UPDATE SET
           overrides_json = excluded.overrides_json,
           updated_at = datetime('now')`,
      )
      .run({ companyId, json: JSON.stringify(ov) });
  },

  clear(companyId: number): void {
    db().prepare('DELETE FROM content_overrides WHERE company_id = ?').run(companyId);
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
    db()
      .prepare(
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
    return db()
      .prepare('SELECT * FROM audit_log WHERE company_id = ? ORDER BY id ASC')
      .all(companyId);
  },
};

/* ------------------------------ send_ledger ------------------------------ */

export const sendLedger = {
  countForDay(day: string): number {
    const row = db().prepare('SELECT COUNT(*) AS n FROM send_ledger WHERE day = ?').get(day) as {
      n: number;
    };
    return row.n;
  },
  record(companyId: number, day: string): void {
    db().prepare('INSERT INTO send_ledger (company_id, day) VALUES (?, ?)').run(companyId, day);
  },
};
