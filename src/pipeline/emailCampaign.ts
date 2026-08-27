import { config } from '../config.js';
import type { CompanyRow } from '../types.js';
import { companies, suppression, audit } from '../db/repositories.js';
import {
  contacts,
  emailCampaigns,
  emailSends,
  emailLinks,
  type EmailCampaignRow,
} from '../db/emailRepositories.js';
import { preSendCheck, markSent } from '../crosscutting/compliance.js';
import { canSendNow, todayKey } from '../crosscutting/pacing.js';
import { clickTrackingEnabled } from '../crosscutting/tracking.js';
import { renderEmail, unsubscribeUrlFor } from '../layers/m3_email_content.js';
import { sendMail, verifyTransport } from '../layers/m1_transport.js';
import { discoverEmailsForCompany } from './emailDiscovery.js';
import { intakeStatus } from './intake.js';
import { sleepInterruptible } from '../utils/sleep.js';
import { logger } from '../utils/logger.js';

const log = logger('email-campaign');

/**
 * 一斉メール送信（第2チャネル）。
 *
 * フォーム送信 (`bulkSend`) と対になる作り: 候補をページングで取り直しながら
 * 送り、中断・再開でき、ペーシング（送信時間帯・日次上限・送信間隔）を守る。
 * 違うのは 3 点:
 *
 *  1. **宛先が要る。** アドレスが無い企業はその場で探索する（`discover: true`）。
 *     取り込みと同じで、探索と送信が並走する。
 *  2. **抑制リストを共有する。** メールで配信停止された企業はフォームからも
 *     二度と接触しない（逆も同じ）。チャネルごとに分けると、断った相手に
 *     別ルートで届いてしまう。
 *  3. **ブラウザを使わない。** SMTP だけなので、フォーム送信と並走させても
 *     ブラウザ枠を奪い合わない。
 */

export interface EmailCampaignOptions {
  name?: string;
  template?: string;
  /**
   * 対象の絞り込み。
   *  - `form_unreachable`（既定）: フォームで到達できなかった企業だけ。
   *    フォーム送信と二重に当たらないので、初期運用はこれが安全。
   *  - `all`: 抑制されていない全企業。
   */
  target?: 'form_unreachable' | 'all';
  /** 宛先が無い企業をその場で探索する（既定 ON）。 */
  discover?: boolean;
  /** 送信数の上限（既定は日次上限まで）。 */
  limit?: number;
  /** 候補が尽きても、探索が続く限り待ち続ける。 */
  follow?: boolean;
  actor?: string;
}

export interface EmailCampaignCounters {
  /** 判定した企業数。 */
  scanned: number;
  /** 送信できた通数。 */
  sent: number;
  failed: number;
  /** 宛先が無くて送れなかった企業。 */
  noContact: number;
  /** 抑制・送信済みで対象外だった企業。 */
  skipped: number;
  /** その場で探索して宛先が見つかった企業。 */
  discovered: number;
}

export interface EmailCampaignSnapshot extends EmailCampaignCounters {
  campaignId: number | null;
  running: boolean;
  status: EmailCampaignRow['status'] | 'none';
  stopping: boolean;
  message: string;
  current: string | null;
  target: EmailCampaignOptions['target'];
  trackingEnabled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  stopReason: string | null;
  recent: { companyId: number; name: string; email: string; status: string; detail: string; at: string }[];
}

/** 取り込みがまだ新しい送信候補を生み出しうるか（follow 時の待機判定）。 */
function intakeStillProducing(): boolean {
  const s = intakeStatus();
  return s.running && s.pipeline;
}

/** フォームで到達できなかった＝メールで当てる価値がある状態。 */
const FORM_UNREACHABLE_STATUSES = ['FORM_NOT_FOUND', 'PARSE_FAILED', 'CAPTCHA_BLOCKED', 'SUBMITTED_FAILED'];

const PAGE = 100;
/** 候補待ちの空回りを避ける間隔。 */
const IDLE_WAIT_MS = 5000;
/** 送信時間外・日次上限に当たったときの再確認間隔。 */
const PACE_WAIT_MS = 60_000;
const MAX_RECENT = 200;

interface RunState extends EmailCampaignSnapshot {
  campaignId: number;
  stopRequested: boolean;
  limit: number;
  actor: string;
  template: string;
  discover: boolean;
  follow: boolean;
  /** 一度「対象外」と判定した企業（毎周回で再判定しないため）。 */
  blockedIds: Set<number>;
  promise: Promise<void> | null;
}

let state: RunState | null = null;

const emptyCounters = (): EmailCampaignCounters => ({
  scanned: 0, sent: 0, failed: 0, noContact: 0, skipped: 0, discovered: 0,
});

export function emailCampaignStatus(): EmailCampaignSnapshot {
  if (state) {
    const { stopRequested: _s, limit: _l, actor: _a, template: _t, discover: _d,
      blockedIds: _b, promise: _p, ...pub } = state;
    return { ...pub };
  }
  const last = emailCampaigns.latest();
  if (!last) {
    return {
      ...emptyCounters(), campaignId: null, running: false, status: 'none', stopping: false,
      message: '', current: null, target: 'form_unreachable',
      trackingEnabled: clickTrackingEnabled(), startedAt: null, finishedAt: null,
      stopReason: null, recent: [],
    };
  }
  const counters = { ...emptyCounters(), ...(JSON.parse(last.counters_json || '{}') as Partial<EmailCampaignCounters>) };
  const opts = JSON.parse(last.options_json || '{}') as EmailCampaignOptions;
  return {
    ...counters,
    campaignId: last.id,
    running: false,
    status: last.status,
    stopping: false,
    message: last.status === 'paused' ? '中断中' : last.status === 'failed' ? `失敗: ${last.error ?? ''}` : '完了',
    current: null,
    target: opts.target ?? 'form_unreachable',
    trackingEnabled: clickTrackingEnabled(),
    startedAt: last.created_at,
    finishedAt: last.finished_at,
    stopReason: last.error,
    recent: [],
  };
}

export function isCampaignRunning(): boolean {
  return !!state?.running;
}

/** 次の区切りで停止する（送信中の 1 通は送り切る）。 */
export function stopEmailCampaign(): boolean {
  if (!state?.running) return false;
  state.stopRequested = true;
  state.stopping = true;
  state.message = '中断しています…';
  return true;
}

export async function startEmailCampaign(
  opts: EmailCampaignOptions = {},
): Promise<{ started: boolean; message: string; campaignId?: number }> {
  if (state?.running) return { started: false, message: '一斉メール送信はすでに実行中です' };

  // 認証エラーは 1 通目ではなく開始時点で出す。3,000 社分のキューを作ってから
  // 「SMTP に繋がりません」では、どこまで送ったのか分からなくなる。
  const check = await verifyTransport();
  if (!check.ok) return { started: false, message: `SMTP に接続できません: ${check.detail}` };

  const target = opts.target ?? 'form_unreachable';
  const template = opts.template ?? 'mochica_email';
  const campaignId = emailCampaigns.create({
    name: opts.name ?? `メール一斉送信 ${todayKey()}`,
    template,
    options: { ...opts, target, template },
  });

  const s: RunState = {
    ...emptyCounters(),
    campaignId,
    running: true,
    status: 'running',
    stopping: false,
    message: '送信対象を確認しています…',
    current: null,
    target,
    trackingEnabled: clickTrackingEnabled(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stopReason: null,
    recent: [],
    stopRequested: false,
    limit: opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY,
    actor: opts.actor ?? 'auto:email',
    template,
    discover: opts.discover !== false,
    follow: opts.follow !== false,
    blockedIds: new Set(),
    promise: null,
  };
  state = s;

  audit.log({
    layer: 'M4', action: 'email_campaign_start', actor: s.actor,
    detail: `campaign=${campaignId} target=${target} tracking=${s.trackingEnabled}`,
  });

  s.promise = worker(s)
    .catch((e) => {
      log.error(`一斉メール送信が異常終了: ${(e as Error).message}`);
      s.stopReason = `エラー: ${(e as Error).message}`;
      emailCampaigns.save(campaignId, { status: 'failed', error: (e as Error).message, finished: true });
    })
    .finally(() => {
      s.running = false;
      s.stopping = false;
      s.current = null;
      s.finishedAt = new Date().toISOString();
      s.message = s.stopReason ?? '完了';
      s.promise = null;
      if (emailCampaigns.byId(campaignId)?.status === 'running') {
        emailCampaigns.save(campaignId, {
          status: s.stopRequested ? 'paused' : 'done',
          counters: counters(s),
          finished: !s.stopRequested,
        });
      }
      log.info(`一斉メール送信 終了: 送信=${s.sent} 失敗=${s.failed} 宛先なし=${s.noContact}`);
      audit.log({
        layer: 'M4', action: 'email_campaign_end', actor: s.actor,
        detail: `sent=${s.sent} failed=${s.failed} noContact=${s.noContact} ${s.stopReason ?? ''}`,
      });
    });

  return {
    started: true,
    campaignId,
    message: s.trackingEnabled
      ? '一斉メール送信を開始しました（クリック検知あり）'
      : '一斉メール送信を開始しました（PUBLIC_BASE_URL 未設定のためクリック検知は無効）',
  };
}

const counters = (s: RunState): EmailCampaignCounters => ({
  scanned: s.scanned, sent: s.sent, failed: s.failed,
  noContact: s.noContact, skipped: s.skipped, discovered: s.discovered,
});

const sleep = (ms: number, s: RunState): Promise<void> =>
  sleepInterruptible(ms, () => s.stopRequested);

function pushRecent(s: RunState, r: Omit<RunState['recent'][number], 'at'>): void {
  s.recent.push({ ...r, at: new Date().toISOString() });
  if (s.recent.length > MAX_RECENT) s.recent.splice(0, s.recent.length - MAX_RECENT);
}

/** 送信対象になりうる企業を 1 ページ取る。 */
function candidatePage(s: RunState, offset: number): CompanyRow[] {
  return s.target === 'all'
    ? companies.byStatuses(SENDABLE_ALL, PAGE, offset)
    : companies.byStatuses(FORM_UNREACHABLE_STATUSES as CompanyRow['status'][], PAGE, offset);
}

/** target='all' のときの対象。送信済み・却下・抑制は companies 側で除く。 */
const SENDABLE_ALL: CompanyRow['status'][] = [
  'NEW', 'FORM_NOT_FOUND', 'PARSE_FAILED', 'CAPTCHA_BLOCKED', 'SUBMITTED_FAILED',
  'PENDING_APPROVAL', 'NEEDS_REVIEW',
];

async function worker(s: RunState): Promise<void> {
  let offset = 0;
  for (;;) {
    if (s.stopRequested) { s.stopReason ??= '中断しました'; return; }
    if (s.sent >= s.limit) { s.stopReason ??= `上限 ${s.limit} 通に到達しました`; return; }

    // ペーシング。時間外は待つ（フォーム送信と同じ窓・同じ考え方）。
    const pace = canSendNow();
    if (!pace.allowed) {
      if (!s.follow) { s.stopReason ??= `送信できません: ${pace.reason}`; return; }
      s.current = null;
      s.message = `送信待機中（${pace.reason}）`;
      s.blockedIds.clear();
      offset = 0;
      await sleep(PACE_WAIT_MS, s);
      continue;
    }
    // メール固有の日次上限（SMTP 側の上限に合わせる）。
    const sentToday = emailSends.countSentOnDay(todayKey());
    if (sentToday >= config.email.dailyLimit) {
      if (!s.follow) { s.stopReason ??= `本日の送信上限 ${config.email.dailyLimit} 通に達しました`; return; }
      s.message = `本日の送信上限に到達（${sentToday}/${config.email.dailyLimit}）— 日付が変わるまで待機します`;
      await sleep(PACE_WAIT_MS, s);
      continue;
    }

    const page = candidatePage(s, offset);
    if (page.length === 0) {
      // 末尾まで見た。判定キャッシュを捨てて先頭から見直す（②で手直しされた
      // 企業や、取り込みが新しく作った企業をここで拾い直す）。
      if (offset > 0) { offset = 0; s.blockedIds.clear(); continue; }

      // follow 中は、取り込みがまだ企業を作っているなら待つ。フォーム発見に
      // 失敗した企業がこれから増えるので、そこで止めると取りこぼす。
      if (s.follow && intakeStillProducing()) {
        s.current = null;
        s.message = '取り込み中 — 対象が増え次第、続けて送信します';
        s.blockedIds.clear();
        await sleep(IDLE_WAIT_MS, s);
        continue;
      }
      s.stopReason ??= s.sent > 0 ? '送信対象がなくなりました' : '送信できる企業がありませんでした';
      return;
    }

    let sentInPage = 0;
    for (const c of page) {
      if (s.stopRequested || s.sent >= s.limit) break;
      if (s.blockedIds.has(c.id)) continue;
      const did = await sendToCompany(s, c);
      if (did) {
        sentInPage++;
        // 送信間隔（連続送信は迷惑メール判定を招く）。中断には即応する。
        const { minIntervalMs: min, maxIntervalMs: max } = config.email;
        await sleep(min + Math.floor((max - min) * 0.5), s);
      }
    }

    // このページから 1 通も出なければ次のページへ進む（同じページで詰まらない）。
    offset = sentInPage === 0 ? offset + page.length : 0;
  }
}

/**
 * 1 社に 1 通送る。送れたら true。
 *
 * 送信レコードは **SMTP に投げる前** に queued で作る。順序を逆にすると、
 * 送信直後にプロセスが落ちたときに記録が残らず、再開時に同じ相手へ二重送信する。
 */
async function sendToCompany(s: RunState, company: CompanyRow): Promise<boolean> {
  s.scanned++;

  // 抑制（送信済み・配信停止・競合・営業お断り）。フォームと共有。
  const compliance = preSendCheck(company.domain);
  if (!compliance.allowed) {
    s.skipped++;
    s.blockedIds.add(company.id);
    return false;
  }
  // 同じ企業に二度メールを送らない。
  if (emailSends.hasSentTo(company.id)) {
    s.skipped++;
    s.blockedIds.add(company.id);
    return false;
  }

  // 宛先。無ければその場で探す。
  let contact = contacts.bestForCompany(company.id, config.email.allowGuessed);
  if (!contact && s.discover) {
    s.current = `${company.name}（アドレス探索中）`;
    s.message = `アドレスを探索中: ${company.name}`;
    const r = await discoverEmailsForCompany(company.id);
    if (r.outcome === 'found') s.discovered++;
    if (r.outcome === 'suppressed') {
      s.skipped++;
      s.blockedIds.add(company.id);
      return false;
    }
    contact = contacts.bestForCompany(company.id, config.email.allowGuessed);
  }
  if (!contact) {
    s.noContact++;
    s.blockedIds.add(company.id);
    return false;
  }

  const mail = renderEmail(company, s.template);
  const sendId = emailSends.queue({
    campaignId: s.campaignId,
    companyId: company.id,
    email: contact.email,
    subject: mail.subject,
    body: mail.text,
    token: mail.sendToken,
  });
  // 計測リンクは送信前に保存する。送信後だと、届いたメールのリンクを
  // 押されたときに DB に無い、という取りこぼしが起きる。
  for (const l of mail.links) {
    emailLinks.create({ token: l.token, sendId, url: l.url, label: l.label });
  }

  s.current = `#${company.id} ${company.name} <${contact.email}>`;
  s.message = `送信中: ${company.name}`;
  try {
    const res = await sendMail({
      to: contact.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      unsubscribeUrl: unsubscribeUrlFor(mail.sendToken),
    });
    if (res.rejected.length > 0) {
      emailSends.markFailed(sendId, `受信拒否: ${res.rejected.join(', ')}`);
      s.failed++;
      pushRecent(s, { companyId: company.id, name: company.name, email: contact.email, status: 'rejected', detail: res.rejected.join(', ') });
      return true;
    }
    emailSends.markSent(sendId, res.messageId);
    // 二重接触の防止はチャネル横断。メールを送った企業にフォームからも送らない。
    markSent(company.domain);
    s.sent++;
    pushRecent(s, { companyId: company.id, name: company.name, email: contact.email, status: 'sent', detail: '' });
    audit.log({ companyId: company.id, layer: 'M4', action: 'email_sent', detail: contact.email });
    return true;
  } catch (e) {
    const detail = (e as Error).message;
    emailSends.markFailed(sendId, detail);
    s.failed++;
    s.blockedIds.add(company.id);
    pushRecent(s, { companyId: company.id, name: company.name, email: contact.email, status: 'error', detail });
    log.error(`送信失敗 company=${company.id}: ${detail}`);
    return true;
  } finally {
    s.current = null;
    emailCampaigns.save(s.campaignId, { counters: counters(s) });
  }
}

/**
 * 起動時のクリーンアップ。`queued` のまま残った行は「SMTP に投げた直後に
 * 落ちた」可能性があり、送ったかどうか分からない。二重送信を避けるため
 * 送信済み扱いにはせず、`skipped` として人が確認できる形で残す。
 */
export function reconcileOnBoot(): number {
  emailCampaigns.pauseAllRunning();
  const stale = emailSends.staleQueued();
  for (const row of stale) {
    emailSends.markFailed(row.id, '送信中にプロセスが停止（送達不明）', 'skipped');
  }
  if (stale.length) log.warn(`送達不明のメール ${stale.length} 件を skipped にしました`);
  return stale.length;
}
