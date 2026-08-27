import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const log = logger('M1');

/**
 * M1 — SMTP 送信基盤。
 *
 * 特定の ESP に縛らず SMTP で話す。Google Workspace / SendGrid / Amazon SES /
 * Resend いずれも SMTP を提供しているので、`.env` の 4 行を変えるだけで乗り換え
 * られる。API SDK を選ぶと、その 1 社に実装が固定される。
 *
 * 接続は 1 本を使い回す (`pool`)。1 通ごとに TCP+TLS+認証をやり直すと、送信間隔
 * より接続確立の方が高くつくうえ、短時間の連続接続は迷惑メール判定の材料になる。
 */

let transporter: Transporter | null = null;

function build(): Transporter {
  const e = config.email;
  if (!e.enabled) {
    throw new Error(
      'SMTP が未設定です（SMTP_HOST / SMTP_USER / SMTP_PASS を .env に設定してください）',
    );
  }
  return nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.secure,
    auth: { user: e.user, pass: e.pass },
    pool: true,
    maxConnections: Math.max(1, e.concurrency),
    // 1 接続あたりの送信数。多くの ESP が接続ごとの上限を持つので控えめに。
    maxMessages: 100,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export function mailer(): Transporter {
  if (!transporter) transporter = build();
  return transporter;
}

/** 接続を閉じる（テスト・シャットダウン用）。 */
export function closeMailer(): void {
  transporter?.close();
  transporter = null;
}

/**
 * 送信前の接続確認。認証エラーを 1 通目の送信ではなくキャンペーン開始時点で
 * 出すためのもの（3,000 通のキューを作ってから落ちるのが一番痛い）。
 */
export async function verifyTransport(): Promise<{ ok: boolean; detail: string }> {
  if (!config.email.enabled) {
    return { ok: false, detail: 'SMTP が未設定です（SMTP_HOST / SMTP_USER / SMTP_PASS）' };
  }
  try {
    await mailer().verify();
    return { ok: true, detail: `${config.email.host}:${config.email.port} に接続できました` };
  } catch (e) {
    const detail = (e as Error).message;
    log.error(`SMTP 接続確認に失敗: ${detail}`);
    return { ok: false, detail };
  }
}

export interface OutgoingMail {
  to: string;
  subject: string;
  /** プレーンテキスト本文。実 URL をそのまま載せる（読み手が飛び先を確認できる）。 */
  text: string;
  /** HTML 本文。クリック計測リンクはこちらに入る。 */
  html?: string;
  /**
   * List-Unsubscribe ヘッダ用の URL。受信者のメールクライアントが出す
   * 「配信停止」ボタンから直接叩かれる。Gmail の一括送信者要件でもある。
   */
  unsubscribeUrl?: string | null;
}

export interface SendResult {
  messageId: string | null;
  accepted: string[];
  rejected: string[];
}

/** 1 通送る。失敗は例外で返す（呼び出し側が queued 行を failed にする）。 */
export async function sendMail(mail: OutgoingMail): Promise<SendResult> {
  const e = config.email;
  const headers: Record<string, string> = {};
  if (mail.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${mail.unsubscribeUrl}>`;
    // ワンクリック配信停止 (RFC 8058)。これがあるとクライアントは確認画面を
    // 挟まずに POST し、受信者は 1 タップで止められる。
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const info = await mailer().sendMail({
    from: e.from,
    replyTo: e.replyTo || undefined,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    headers,
  });

  return {
    messageId: (info.messageId as string | undefined) ?? null,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}
