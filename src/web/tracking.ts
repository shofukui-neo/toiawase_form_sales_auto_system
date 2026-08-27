import type express from 'express';
import { emailSends, emailLinks, emailEvents } from '../db/emailRepositories.js';
import { isTokenShaped } from '../crosscutting/tracking.js';
import { applyUnsubscribe } from '../crosscutting/emailOptOut.js';
import { logger } from '../utils/logger.js';

const log = logger('tracking');

/**
 * M5 — クリック検知・配信停止の受け口。
 *
 * 受信者のブラウザから直接叩かれる **唯一の公開面** なので、他の API とは
 * 前提が違う:
 *
 *  - 認証が無い。トークンを知っている＝そのメールを受け取った人、とみなす。
 *  - リダイレクト先は必ず DB (`email_links`) から引く。クエリの URL に飛ばすと
 *    オープンリダイレクトになり、当社ドメインがフィッシングの踏み台になる。
 *  - 不正・未知のトークンでも 404 の素っ気ない応答にする。トークンの当たり外れが
 *    分かる差分（応答時間・文言）を作らない。
 *  - 何があっても例外を投げない。計測の失敗でリンクが死ぬのは本末転倒なので、
 *    記録に失敗してもリダイレクトは通す。
 */

/** 受信者に見せる最小限のページ。ブランドを名乗る以上、白紙は返さない。 */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  body{font-family:-apple-system,'Hiragino Kaku Gothic ProN',Meiryo,sans-serif;
       background:#f6f7f9;color:#1a1a1a;display:flex;min-height:100vh;
       align-items:center;justify-content:center;margin:0;padding:24px}
  .card{background:#fff;border:1px solid #e3e6ea;border-radius:14px;
        padding:28px 32px;max-width:520px;line-height:1.9;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  h1{font-size:17px;margin:0 0 12px}
  p{font-size:14px;margin:0 0 8px;color:#444}
</style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
}

export function registerTrackingRoutes(app: express.Express): void {
  /**
   * クリック計測 → 元の URL へ 302。
   * 記録に失敗してもリダイレクトは必ず行う（リンクを壊さない）。
   */
  app.get('/t/c/:token', (req, res) => {
    const token = req.params.token;
    if (!isTokenShaped(token)) return res.status(404).send(page('リンクが見つかりません', '<p>このリンクは無効です。</p>'));

    const link = emailLinks.byToken(token);
    if (!link) return res.status(404).send(page('リンクが見つかりません', '<p>このリンクは無効です。</p>'));

    try {
      const send = emailSends.byId(link.send_id);
      emailEvents.record({
        sendId: link.send_id,
        companyId: send?.company_id ?? null,
        kind: 'click',
        url: link.url,
        label: link.label,
        userAgent: req.get('user-agent') ?? null,
      });
      log.info(`クリック: send=${link.send_id} ${link.label ?? ''} ${link.url}`);
    } catch (e) {
      log.error(`クリック記録に失敗: ${(e as Error).message}`);
    }
    // 302（永続化しない）。301 だとブラウザがキャッシュして 2 回目以降が
    // 計測できなくなる。
    return res.redirect(302, link.url);
  });

  /**
   * 配信停止。メールクライアントのワンクリック配信停止 (RFC 8058) は POST で
   * 来るので、GET と POST の両方を受ける。
   */
  const unsubscribe = (req: express.Request, res: express.Response) => {
    const token = req.params.token;
    if (!isTokenShaped(token)) {
      return res.status(404).send(page('リンクが見つかりません', '<p>このリンクは無効です。</p>'));
    }
    const send = emailSends.byToken(token);
    if (!send) {
      return res.status(404).send(page('リンクが見つかりません', '<p>このリンクは無効です。</p>'));
    }

    try {
      // 二重クリックでも冪等。抑制リストは PRIMARY KEY(domain) で自然に重複しない。
      applyUnsubscribe(send.id, send.company_id);
      emailEvents.record({
        sendId: send.id,
        companyId: send.company_id,
        kind: 'unsubscribe',
        userAgent: req.get('user-agent') ?? null,
      });
    } catch (e) {
      log.error(`配信停止の記録に失敗: ${(e as Error).message}`);
      return res
        .status(500)
        .send(page('処理できませんでした', '<p>お手数ですが、本メールへのご返信にてお知らせください。</p>'));
    }

    // ワンクリック配信停止の POST には本文を期待しないクライアントが多い。
    if (req.method === 'POST') return res.status(200).end();
    return res.send(
      page(
        '配信を停止しました',
        `<p>${escapeHtml(send.email)} 宛の配信を停止いたしました。</p>
         <p>以後、当社からのご案内をお送りすることはありません。</p>
         <p>お手数をおかけし、申し訳ありませんでした。</p>`,
      ),
    );
  };

  app.get('/t/u/:token', unsubscribe);
  app.post('/t/u/:token', unsubscribe);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
