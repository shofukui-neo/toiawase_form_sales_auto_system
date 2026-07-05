import { createServer, type Server } from 'node:http';
import { parse as parseQs } from 'node:querystring';

/**
 * Local test form server for P0 E2E (spec §12 P0). Serves:
 *   /contact          -> a realistic 2-step JP contact form (confirm screen),
 *                        including a honeypot field and a consent checkbox.
 *   /contact/confirm  -> confirmation screen with a final 送信する button.
 *   /contact/complete -> validates (honeypot MUST be empty) and returns thanks.
 *   /simple           -> a 1-step form (submit directly, no confirm screen).
 *   /simple/complete  -> thanks.
 * No external network involved — safe to run in CI.
 */

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

const contactForm = page(
  'お問い合わせ',
  `<h1>お問い合わせフォーム</h1>
  <p>お気軽にご連絡ください。</p>
  <form method="POST" action="/contact/confirm">
    <table>
      <tr><th><label for="company">会社名</label></th><td><input id="company" name="company" type="text" required></td></tr>
      <tr><th><label for="name">お名前</label></th><td><input id="name" name="name" type="text" required></td></tr>
      <tr><th><label for="kana">フリガナ</label></th><td><input id="kana" name="kana" type="text"></td></tr>
      <tr><th><label for="email">メールアドレス</label></th><td><input id="email" name="email" type="email" required></td></tr>
      <tr><th><label for="tel">電話番号</label></th><td><input id="tel" name="tel" type="tel"></td></tr>
      <tr><th><label for="message">お問い合わせ内容</label></th><td><textarea id="message" name="message" required></textarea></td></tr>
    </table>
    <div style="display:none"><label>URL(記入不要)<input type="text" name="url_check"></label></div>
    <label><input type="checkbox" name="agree" required> 個人情報の取扱いに同意する</label>
    <button type="submit">確認画面へ</button>
  </form>`,
);

function confirmPage(data: Record<string, string>): string {
  const hidden = Object.entries(data)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('');
  const rows = Object.entries(data)
    .filter(([k]) => k !== 'url_check')
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  return page(
    '入力内容の確認',
    `<h1>入力内容の確認</h1>
    <p>以下の内容で送信します。よろしければ「送信する」を押してください。</p>
    <table>${rows}</table>
    <form method="POST" action="/contact/complete">
      ${hidden}
      <button type="submit" name="back" value="1" formaction="/contact">戻る</button>
      <button type="submit">送信する</button>
    </form>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function readBody(req: any): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => resolve(parseQs(raw) as Record<string, string>));
  });
}

export function startServer(port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const url = req.url || '/';
    const send = (code: number, html: string) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };

    if (req.method === 'GET' && url.startsWith('/contact') && url !== '/contact/confirm') {
      return send(200, contactForm);
    }
    if (req.method === 'POST' && url === '/contact/confirm') {
      const data = await readBody(req);
      return send(200, confirmPage(data));
    }
    if (req.method === 'POST' && url === '/contact/complete') {
      const data = await readBody(req);
      // Honeypot MUST be empty. If a bot filled it, treat as spam -> error.
      if (data.url_check && data.url_check.trim() !== '') {
        return send(200, page('エラー', '<h1>エラー</h1><p>不正な送信です。入力してください。</p>'));
      }
      if (!data.company || !data.email || !data.message || !data.agree) {
        return send(200, page('エラー', '<h1>入力エラー</h1><p>必須項目が未入力です。</p>'));
      }
      return send(200, page('送信完了', '<h1>送信が完了しました</h1><p>お問い合わせありがとうございました。</p>'));
    }

    if (req.method === 'GET' && url.startsWith('/simple')) {
      return send(
        200,
        page(
          '簡易フォーム',
          `<h1>1ステップフォーム</h1>
          <form method="POST" action="/simple/complete">
            <label>会社名<input name="company" required></label>
            <label>お名前<input name="name" required></label>
            <label>メール<input name="email" type="email" required></label>
            <label>内容<textarea name="message" required></textarea></label>
            <button type="submit">送信</button>
          </form>`,
        ),
      );
    }
    if (req.method === 'POST' && url === '/simple/complete') {
      const data = await readBody(req);
      if (!data.company || !data.message) return send(200, page('エラー', '<h1>エラー</h1><p>必須です</p>'));
      return send(200, page('完了', '<h1>ありがとうございました</h1><p>送信完了しました。</p>'));
    }

    send(404, page('404', '<h1>Not Found</h1>'));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, url: `http://127.0.0.1:${p}` });
    });
  });
}

// Allow running standalone: `npm run testform`
const isMain = process.argv[1] && process.argv[1].endsWith('test_form_server.ts');
if (isMain) {
  startServer(8787).then(({ url }) => console.log(`test form server: ${url}/contact`));
}
