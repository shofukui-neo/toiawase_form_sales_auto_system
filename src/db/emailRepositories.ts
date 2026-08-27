import { prep } from './db.js';

/**
 * 一斉メール送信 (M) の永続化層。
 *
 * フォーム送信側の `repositories.ts` とは別ファイルにしている。テーブル群が
 * まとまって増えるうえ、フォーム送信を触る人がメール側を読む必要はないため。
 * 抑制リスト (suppression) だけは両チャネルで共有する — メールで配信停止した
 * 企業にフォームから接触しては意味がない。
 */

export interface ContactRow {
  id: number;
  company_id: number;
  email: string;
  /** published = サイト上に掲載を確認 / list = 取り込みリストの列 / guessed = 推測 */
  source: 'published' | 'list' | 'guessed';
  role_kind: string | null;
  confidence: number;
  mx_ok: number;
  page_url: string | null;
  created_at: string;
}

export const contacts = {
  /** 同じ (company, email) は確度・MX が上がったときだけ更新する。 */
  upsert(input: {
    companyId: number;
    email: string;
    source: ContactRow['source'];
    roleKind?: string | null;
    confidence?: number;
    mxOk?: boolean;
    pageUrl?: string | null;
  }): void {
    prep(
      `INSERT INTO contacts (company_id, email, source, role_kind, confidence, mx_ok, page_url)
       VALUES (@companyId, @email, @source, @roleKind, @confidence, @mxOk, @pageUrl)
       ON CONFLICT(company_id, email) DO UPDATE SET
         source     = excluded.source,
         role_kind  = COALESCE(excluded.role_kind, contacts.role_kind),
         confidence = MAX(excluded.confidence, contacts.confidence),
         mx_ok      = MAX(excluded.mx_ok, contacts.mx_ok),
         page_url   = COALESCE(excluded.page_url, contacts.page_url)`,
    ).run({
      companyId: input.companyId,
      email: input.email.toLowerCase(),
      source: input.source,
      roleKind: input.roleKind ?? null,
      confidence: input.confidence ?? 0.5,
      mxOk: input.mxOk ? 1 : 0,
      pageUrl: input.pageUrl ?? null,
    });
  },

  byCompany(companyId: number): ContactRow[] {
    return prep(
      'SELECT * FROM contacts WHERE company_id = ? ORDER BY confidence DESC, id ASC',
    ).all(companyId) as ContactRow[];
  },

  /**
   * 送信に使う宛先を 1 件だけ返す。MX が引けるものに限り、確度の高い順。
   * `allowGuessed=false`（既定）では推測アドレスを除外する。
   */
  bestForCompany(companyId: number, allowGuessed: boolean): ContactRow | undefined {
    return prep(
      `SELECT * FROM contacts
        WHERE company_id = @companyId AND mx_ok = 1
          AND (@allowGuessed = 1 OR source <> 'guessed')
        ORDER BY confidence DESC, id ASC LIMIT 1`,
    ).get({ companyId, allowGuessed: allowGuessed ? 1 : 0 }) as ContactRow | undefined;
  },

  /** 送信可能な宛先を持つ企業の数。 */
  countCompaniesWithUsable(allowGuessed: boolean): number {
    return (
      prep(
        `SELECT COUNT(DISTINCT company_id) AS n FROM contacts
          WHERE mx_ok = 1 AND (@allowGuessed = 1 OR source <> 'guessed')`,
      ).get({ allowGuessed: allowGuessed ? 1 : 0 }) as { n: number }
    ).n;
  },

  countAll(): number {
    return (prep('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
  },
};

export const emailResolutions = {
  get(domain: string): { found: number; detail: string | null } | undefined {
    return prep('SELECT found, detail FROM email_resolutions WHERE domain = ?').get(domain) as
      | { found: number; detail: string | null }
      | undefined;
  },
  set(domain: string, found: boolean, detail?: string | null): void {
    prep(
      `INSERT INTO email_resolutions (domain, found, detail) VALUES (@domain, @found, @detail)
       ON CONFLICT(domain) DO UPDATE SET
         found = excluded.found, detail = excluded.detail, created_at = datetime('now')`,
    ).run({ domain, found: found ? 1 : 0, detail: detail ?? null });
  },
  count(): number {
    return (prep('SELECT COUNT(*) AS n FROM email_resolutions').get() as { n: number }).n;
  },
};

export interface EmailCampaignRow {
  id: number;
  name: string;
  template: string;
  status: 'running' | 'paused' | 'done' | 'failed';
  options_json: string;
  counters_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export const emailCampaigns = {
  create(input: { name: string; template: string; options: object }): number {
    const info = prep(
      'INSERT INTO email_campaigns (name, template, options_json) VALUES (@name, @template, @options)',
    ).run({ name: input.name, template: input.template, options: JSON.stringify(input.options) });
    return Number(info.lastInsertRowid);
  },

  byId(id: number): EmailCampaignRow | undefined {
    return prep('SELECT * FROM email_campaigns WHERE id = ?').get(id) as EmailCampaignRow | undefined;
  },

  latest(): EmailCampaignRow | undefined {
    return prep('SELECT * FROM email_campaigns ORDER BY id DESC LIMIT 1').get() as
      | EmailCampaignRow
      | undefined;
  },

  unfinished(): EmailCampaignRow[] {
    return prep(
      "SELECT * FROM email_campaigns WHERE status IN ('running','paused') ORDER BY id ASC",
    ).all() as EmailCampaignRow[];
  },

  save(
    id: number,
    patch: {
      status?: EmailCampaignRow['status'];
      counters?: object;
      error?: string | null;
      /** `error: null` は COALESCE で「触らない」の意味になるのでこちらを使う。 */
      clearError?: boolean;
      finished?: boolean;
    },
  ): void {
    prep(
      `UPDATE email_campaigns SET
         status        = COALESCE(@status, status),
         counters_json = COALESCE(@counters, counters_json),
         error         = CASE WHEN @clearError = 1 THEN NULL ELSE COALESCE(@error, error) END,
         finished_at   = CASE WHEN @finished = 1 THEN datetime('now') ELSE finished_at END,
         updated_at    = datetime('now')
       WHERE id = @id`,
    ).run({
      id,
      status: patch.status ?? null,
      counters: patch.counters ? JSON.stringify(patch.counters) : null,
      error: patch.error ?? null,
      clearError: patch.clearError ? 1 : 0,
      finished: patch.finished ? 1 : 0,
    });
  },

  pauseAllRunning(): number {
    return prep("UPDATE email_campaigns SET status = 'paused' WHERE status = 'running'").run().changes;
  },
};

export interface EmailSendRow {
  id: number;
  campaign_id: number | null;
  company_id: number;
  email: string;
  subject: string;
  body: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  detail: string | null;
  message_id: string | null;
  token: string;
  sent_at: string | null;
  created_at: string;
}

export const emailSends = {
  /**
   * 送信前に `queued` で作る。SMTP に投げてからレコードを作ると、その間に
   * 落ちたときに「送ったのに記録が無い」= 二重送信の元になる。
   */
  queue(input: {
    campaignId: number | null;
    companyId: number;
    email: string;
    subject: string;
    body: string;
    token: string;
  }): number {
    const info = prep(
      `INSERT INTO email_sends (campaign_id, company_id, email, subject, body, token)
       VALUES (@campaignId, @companyId, @email, @subject, @body, @token)`,
    ).run({ ...input, email: input.email.toLowerCase() });
    return Number(info.lastInsertRowid);
  },

  markSent(id: number, messageId: string | null): void {
    prep(
      "UPDATE email_sends SET status = 'sent', message_id = @messageId, sent_at = datetime('now') WHERE id = @id",
    ).run({ id, messageId });
  },

  markFailed(id: number, detail: string, status: 'failed' | 'skipped' = 'failed'): void {
    prep('UPDATE email_sends SET status = @status, detail = @detail WHERE id = @id').run({
      id,
      status,
      detail: detail.slice(0, 500),
    });
  },

  byId(id: number): EmailSendRow | undefined {
    return prep('SELECT * FROM email_sends WHERE id = ?').get(id) as EmailSendRow | undefined;
  },

  byToken(token: string): EmailSendRow | undefined {
    return prep('SELECT * FROM email_sends WHERE token = ?').get(token) as EmailSendRow | undefined;
  },

  /** その企業に既にメールを送ったか（二重送信の防止）。 */
  hasSentTo(companyId: number): boolean {
    const r = prep(
      "SELECT 1 AS x FROM email_sends WHERE company_id = ? AND status = 'sent' LIMIT 1",
    ).get(companyId) as { x: number } | undefined;
    return !!r;
  },

  /** 起動時に残っていた queued 行（送信中にプロセスが落ちた分）。 */
  staleQueued(): EmailSendRow[] {
    return prep("SELECT * FROM email_sends WHERE status = 'queued'").all() as EmailSendRow[];
  },

  /** 当日の送信数。日次上限の判定に使う。 */
  countSentOnDay(day: string): number {
    return (
      prep("SELECT COUNT(*) AS n FROM email_sends WHERE status = 'sent' AND date(sent_at) = ?").get(
        day,
      ) as { n: number }
    ).n;
  },

  countsByStatus(campaignId: number): Record<string, number> {
    const rows = prep(
      'SELECT status, COUNT(*) AS n FROM email_sends WHERE campaign_id = ? GROUP BY status',
    ).all(campaignId) as { status: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  },

  recent(limit = 100): (EmailSendRow & { name: string; clicks: number })[] {
    return prep(
      `SELECT s.*, c.name,
              (SELECT COUNT(*) FROM email_events e WHERE e.send_id = s.id AND e.kind = 'click') AS clicks
         FROM email_sends s JOIN companies c ON c.id = s.company_id
        ORDER BY s.id DESC LIMIT ?`,
    ).all(limit) as (EmailSendRow & { name: string; clicks: number })[];
  },
};

export interface EmailLinkRow {
  token: string;
  send_id: number;
  url: string;
  label: string | null;
  created_at: string;
}

export const emailLinks = {
  create(input: { token: string; sendId: number; url: string; label?: string | null }): void {
    prep(
      'INSERT INTO email_links (token, send_id, url, label) VALUES (@token, @sendId, @url, @label)',
    ).run({
      token: input.token,
      sendId: input.sendId,
      url: input.url,
      label: input.label ?? null,
    });
  },

  byToken(token: string): EmailLinkRow | undefined {
    return prep('SELECT * FROM email_links WHERE token = ?').get(token) as EmailLinkRow | undefined;
  },
};

export interface EmailEventRow {
  id: number;
  send_id: number;
  company_id: number | null;
  kind: 'click' | 'unsubscribe';
  url: string | null;
  label: string | null;
  user_agent: string | null;
  ts: string;
}

export const emailEvents = {
  record(input: {
    sendId: number;
    companyId: number | null;
    kind: EmailEventRow['kind'];
    url?: string | null;
    label?: string | null;
    userAgent?: string | null;
  }): void {
    prep(
      `INSERT INTO email_events (send_id, company_id, kind, url, label, user_agent)
       VALUES (@sendId, @companyId, @kind, @url, @label, @userAgent)`,
    ).run({
      sendId: input.sendId,
      companyId: input.companyId ?? null,
      kind: input.kind,
      url: input.url ?? null,
      label: input.label ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
    });
  },

  countByKind(kind: EmailEventRow['kind']): number {
    return (prep('SELECT COUNT(*) AS n FROM email_events WHERE kind = ?').get(kind) as { n: number }).n;
  },

  /** クリックした企業数（延べクリック数ではなくユニーク社数）。 */
  uniqueClickedCompanies(): number {
    return (
      prep("SELECT COUNT(DISTINCT company_id) AS n FROM email_events WHERE kind = 'click'").get() as {
        n: number;
      }
    ).n;
  },

  /** 同一送信・同一URLの初クリックか（重複クリックを除いた集計に使う）。 */
  isFirstClick(sendId: number, url: string): boolean {
    const r = prep(
      "SELECT 1 AS x FROM email_events WHERE send_id = ? AND kind = 'click' AND url = ? LIMIT 1",
    ).get(sendId, url) as { x: number } | undefined;
    return !r;
  },

  recentClicks(limit = 100): {
    id: number;
    ts: string;
    url: string | null;
    label: string | null;
    company_id: number | null;
    name: string | null;
    email: string;
  }[] {
    return prep(
      `SELECT e.id, e.ts, e.url, e.label, e.company_id, c.name, s.email
         FROM email_events e
         JOIN email_sends s ON s.id = e.send_id
         LEFT JOIN companies c ON c.id = e.company_id
        WHERE e.kind = 'click'
        ORDER BY e.id DESC LIMIT ?`,
    ).all(limit) as {
      id: number;
      ts: string;
      url: string | null;
      label: string | null;
      company_id: number | null;
      name: string | null;
      email: string;
    }[];
  },
};
