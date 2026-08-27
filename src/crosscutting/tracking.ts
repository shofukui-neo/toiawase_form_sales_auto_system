import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * クリック検知・配信停止リンクのトークン。
 *
 * **リダイレクト先を URL パラメータで受け取らない。** `/t/c?u=https://…` の形は
 * 誰でも任意の URL へ飛ばせるオープンリダイレクトになり、当社ドメインを踏み台に
 * したフィッシングに使われる。ここで発行する不透明トークンを DB (`email_links`)
 * に保存し、リダイレクト時は必ず DB を引いて「自分が本文に埋めた URL」にだけ
 * 飛ばす。トークンが漏れても、飛び先はそのトークンに紐づく 1 つだけ。
 *
 * 推測不能であることも必要（他社宛の送信トークンを当てられると、配信停止を
 * 第三者に実行されたり、クリック数を汚染される）。128bit の乱数を使う。
 */

/** URL に安全な 22 文字前後の不透明トークン。 */
export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

/** トークンの形（DB を引く前の安価な足切り）。 */
export function isTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/** クリック計測 URL。公開ベース URL が未設定なら null（＝計測しない）。 */
export function clickUrl(token: string): string | null {
  return config.publicBaseUrl ? `${config.publicBaseUrl}/t/c/${token}` : null;
}

/** 配信停止 URL。公開ベース URL が未設定なら null。 */
export function unsubscribeUrl(token: string): string | null {
  return config.publicBaseUrl ? `${config.publicBaseUrl}/t/u/${token}` : null;
}

/**
 * クリック計測を実際に行える状態か。
 * `EMAIL_TRACK_CLICKS=true` でも公開 URL が無ければ計測できない。
 */
export function clickTrackingEnabled(): boolean {
  return config.email.trackClicks && !!config.publicBaseUrl;
}
