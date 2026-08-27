import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { config } from '../src/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'email-track-'));
config.dbPath = join(tmp, 'test.db');
// 受信者から到達できる URL があるときだけクリック計測が働く。
config.publicBaseUrl = 'https://track.example.test';
config.email.trackClicks = true;

const { closeDb } = await import('../src/db/db.js');
const { companies, suppression } = await import('../src/db/repositories.js');
const { emailSends, emailLinks, emailEvents } = await import('../src/db/emailRepositories.js');
const { renderEmail } = await import('../src/layers/m3_email_content.js');
const { preSendCheck } = await import('../src/crosscutting/compliance.js');
const { registerTrackingRoutes } = await import('../src/web/tracking.js');

/**
 * メールのクリック検知・配信停止のテスト。
 *
 * 受信者のブラウザから直接叩かれる公開エンドポイントなので、壊れ方が外に出る:
 * リンクが死ねば商談機会を落とし、オープンリダイレクトを許せば当社ドメインが
 * フィッシングの踏み台になる。実際に HTTP を往復させて確かめる。
 *
 * 送信ワーカー全体ではなく `registerTrackingRoutes` だけを載せた最小の express
 * を使う。受け口はクローラや SMTP に依存しない、という設計上の境界の確認も兼ねる。
 */

function makeApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  registerTrackingRoutes(app);
  return app;
}

let server: Server;
let base: string;

test('サーバー起動', async () => {
  server = makeApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

/** 1社分のメールを作り、送信済みの状態を DB に用意する（SMTP は使わない）。 */
function seedSentMail(name: string, domain: string) {
  const company = companies.upsert({ name, domain, icpScore: 0.7 });
  const mail = renderEmail(company);
  const sendId = emailSends.queue({
    campaignId: null,
    companyId: company.id,
    email: `info@${domain}`,
    subject: mail.subject,
    body: mail.text,
    token: mail.sendToken,
  });
  for (const l of mail.links) {
    emailLinks.create({ token: l.token, sendId, url: l.url, label: l.label });
  }
  emailSends.markSent(sendId, '<test@local>');
  return { company, mail, sendId };
}

/* ------------------------------- 本文生成 ------------------------------- */

test('本文に宛名・署名・配信停止リンクが入る', () => {
  const company = companies.upsert({ name: 'テスト商事株式会社', domain: 'body.test', icpScore: 0.5 });
  const mail = renderEmail(company);

  assert.ok(mail.text.includes(company.name), '宛名がない');
  assert.ok(mail.text.includes(config.sender.person.replace(/[\s　]+/g, '')), '署名に氏名がない');
  assert.ok(mail.text.includes(config.sender.phone), '署名に電話番号がない');
  assert.ok(mail.text.includes('/t/u/'), '配信停止リンクがない');
  assert.ok(!/\{\{\s*\w+\s*\}\}/.test(mail.text), `未置換の差し込みが残っている: ${mail.text.slice(0, 200)}`);
  assert.ok(!/<!--\s*\/?\s*(?:optional|if)\b/.test(mail.text), 'テンプレートの制御タグが残っている');
});

test('日程調整URLはテキストに実URL、HTMLでは計測URLになる', () => {
  const booking = config.sender.bookingUrl;
  assert.ok(booking, 'SENDER_BOOKING_URL が未設定だとこのテストは意味を持たない');

  const company = companies.upsert({ name: '日程テスト株式会社', domain: 'booking.test', icpScore: 0.5 });
  const mail = renderEmail(company);

  // テキストは実 URL のまま。飛び先が隠れていないことが受信者の判断材料になる。
  assert.ok(mail.text.includes(booking), 'テキストに実URLが無い');
  // HTML は計測 URL に差し替わっているが、表示文字列は実 URL のまま。
  assert.ok(mail.html.includes('/t/c/'), 'HTMLが計測URLになっていない');
  assert.ok(!mail.html.includes(`href="${booking}"`), 'HTMLのhrefが実URLのまま');
  assert.ok(mail.html.includes(booking), 'HTMLの表示文字列が実URLでない（飛び先が隠れている）');
  assert.ok(mail.links.some((l) => l.url === booking && l.label === '日程調整'));
});

test('配信停止リンク自体はクリック計測の対象にしない', () => {
  const company = companies.upsert({ name: '停止テスト株式会社', domain: 'nounsub.test', icpScore: 0.5 });
  const mail = renderEmail(company);
  // 「もう送るな」の意思表示をクリック実績として数えるのは誤り。
  assert.ok(!mail.links.some((l) => l.url.includes('/t/u/')), '配信停止リンクが計測対象になっている');
});

test('公開URLが未設定なら計測せず、返信での停止を案内する', () => {
  const saved = config.publicBaseUrl;
  config.publicBaseUrl = null;
  try {
    const company = companies.upsert({ name: '無計測株式会社', domain: 'notrack.test', icpScore: 0.5 });
    const mail = renderEmail(company);
    assert.equal(mail.links.length, 0, '計測できないのにリンクを作っている');
    assert.ok(!mail.text.includes('/t/u/'), '届かない配信停止リンクを載せている');
    // 停止手段がまったく無い本文は送ってはいけない。
    assert.ok(mail.text.includes(config.sender.email), '返信での停止案内が無い');
  } finally {
    config.publicBaseUrl = saved;
  }
});

/* ------------------------------ クリック検知 ------------------------------ */

test('クリックすると 302 で元の URL に戻り、記録が残る', async () => {
  const { mail } = seedSentMail('クリック株式会社', 'click.test');
  const link = mail.links[0];
  assert.ok(link, '計測リンクが生成されていない');

  const before = emailEvents.countByKind('click');
  const res = await fetch(`${base}/t/c/${link.token}`, { redirect: 'manual' });
  assert.equal(res.status, 302, `HTTP ${res.status}`);
  assert.equal(res.headers.get('location'), link.url);
  assert.equal(emailEvents.countByKind('click'), before + 1);
});

test('2回目のクリックも数える（301 でキャッシュさせない）', async () => {
  const { mail } = seedSentMail('再クリック株式会社', 'click2.test');
  const link = mail.links[0];
  const before = emailEvents.countByKind('click');
  await fetch(`${base}/t/c/${link.token}`, { redirect: 'manual' });
  await fetch(`${base}/t/c/${link.token}`, { redirect: 'manual' });
  assert.equal(emailEvents.countByKind('click'), before + 2);
});

test('クリックした企業が特定できる', async () => {
  const { company, mail } = seedSentMail('特定株式会社', 'identify.test');
  await fetch(`${base}/t/c/${mail.links[0].token}`, { redirect: 'manual' });
  const hit = emailEvents.recentClicks(50).find((c) => c.company_id === company.id);
  assert.ok(hit, 'クリックが企業に紐づいていない');
  assert.equal(hit.email, 'info@identify.test');
  assert.equal(hit.label, '日程調整');
});

/* --------------------------- オープンリダイレクト --------------------------- */

test('クエリで飛び先を書き換えられない（オープンリダイレクト対策）', async () => {
  const { mail } = seedSentMail('攻撃耐性株式会社', 'evil.test');
  const link = mail.links[0];
  const res = await fetch(`${base}/t/c/${link.token}?u=https://evil.example/phish`, { redirect: 'manual' });
  // 飛び先は DB の値だけ。クエリは一切見ない。
  assert.equal(res.headers.get('location'), link.url);
});

test('未知のトークンは 404（存在するトークンとの差分を作らない）', async () => {
  const res = await fetch(`${base}/t/c/aaaaaaaaaaaaaaaaaaaa`, { redirect: 'manual' });
  assert.equal(res.status, 404);
});

test('トークンの形をしていない入力も 404', async () => {
  for (const bad of ['..%2F..%2Fetc', 'short', 'a'.repeat(200)]) {
    const res = await fetch(`${base}/t/c/${bad}`, { redirect: 'manual' });
    assert.equal(res.status, 404, `${bad} が 404 でない`);
  }
});

/* ------------------------------- 配信停止 ------------------------------- */

test('配信停止でフォーム送信からも除外される', async () => {
  const { mail } = seedSentMail('停止希望株式会社', 'unsub.test');

  assert.equal(preSendCheck('unsub.test').allowed, true, '停止前から送信できない状態になっている');

  const res = await fetch(`${base}/t/u/${mail.sendToken}`, { redirect: 'manual' });
  assert.equal(res.status, 200, `HTTP ${res.status}`);

  assert.equal(suppression.has('unsub.test')?.reason, 'opt_out');
  // チャネルをまたいだ抑制。メールで断った相手にフォームから送っては意味がない。
  assert.equal(preSendCheck('unsub.test').allowed, false, 'フォーム送信から除外されていない');
  assert.equal(emailEvents.countByKind('unsubscribe') >= 1, true);
});

test('ワンクリック配信停止 (RFC 8058) の POST も受ける', async () => {
  const { mail } = seedSentMail('ワンクリック株式会社', 'oneclick.test');
  const res = await fetch(`${base}/t/u/${mail.sendToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.equal(res.status, 200);
  assert.equal(suppression.has('oneclick.test')?.reason, 'opt_out');
});

test('配信停止は二度押しても壊れない（冪等）', async () => {
  const { mail } = seedSentMail('二度押し株式会社', 'twice.test');
  const a = await fetch(`${base}/t/u/${mail.sendToken}`, { redirect: 'manual' });
  const b = await fetch(`${base}/t/u/${mail.sendToken}`, { redirect: 'manual' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(suppression.has('twice.test')?.reason, 'opt_out');
});

test('未知のトークンでの配信停止は 404', async () => {
  const res = await fetch(`${base}/t/u/bbbbbbbbbbbbbbbbbbbb`, { redirect: 'manual' });
  assert.equal(res.status, 404);
});

/* ------------------------------ 宛先の選び方 ------------------------------ */

test('推測アドレスは既定では宛先にならない（掲載の裏づけが無いため）', async () => {
  const { contacts } = await import('../src/db/emailRepositories.js');
  const c = companies.upsert({ name: '推測テスト株式会社', domain: 'guess.test', icpScore: 0.5 });
  contacts.upsert({
    companyId: c.id, email: 'info@guess.test', source: 'guessed',
    roleKind: 'info', confidence: 0.25, mxOk: true,
  });

  // 特定電子メール法のオプトイン例外は「アドレスを公開している」ことが前提。
  assert.equal(contacts.bestForCompany(c.id, false), undefined, '推測アドレスが選ばれている');
  // 明示的に許可したときだけ使える。
  assert.equal(contacts.bestForCompany(c.id, true)?.email, 'info@guess.test');
});

test('MX が引けないアドレスは宛先にしない（ハードバウンスを避ける）', async () => {
  const { contacts } = await import('../src/db/emailRepositories.js');
  const c = companies.upsert({ name: 'MXテスト株式会社', domain: 'mx.test', icpScore: 0.5 });
  contacts.upsert({
    companyId: c.id, email: 'info@mx.test', source: 'published',
    roleKind: 'info', confidence: 0.9, mxOk: false,
  });
  assert.equal(contacts.bestForCompany(c.id, false), undefined);
});

test('掲載アドレスが複数あるときは確度の高い方を選ぶ', async () => {
  const { contacts } = await import('../src/db/emailRepositories.js');
  const c = companies.upsert({ name: '優先テスト株式会社', domain: 'pick.test', icpScore: 0.5 });
  contacts.upsert({ companyId: c.id, email: 'sales@pick.test', source: 'published', roleKind: 'sales', confidence: 0.5, mxOk: true });
  contacts.upsert({ companyId: c.id, email: 'recruit@pick.test', source: 'published', roleKind: 'recruit', confidence: 1.0, mxOk: true });
  assert.equal(contacts.bestForCompany(c.id, false)?.email, 'recruit@pick.test');
});

test('同じアドレスを再登録しても確度は下がらない', async () => {
  const { contacts } = await import('../src/db/emailRepositories.js');
  const c = companies.upsert({ name: '再登録株式会社', domain: 'reupsert.test', icpScore: 0.5 });
  contacts.upsert({ companyId: c.id, email: 'info@reupsert.test', source: 'published', confidence: 0.9, mxOk: true });
  // 別ページで低い確度で再検出されても、一度確認した MX や確度は保つ。
  contacts.upsert({ companyId: c.id, email: 'info@reupsert.test', source: 'published', confidence: 0.3, mxOk: false });
  const rows = contacts.byCompany(c.id);
  assert.equal(rows.length, 1, '重複して登録されている');
  assert.equal(rows[0].confidence, 0.9);
  assert.equal(rows[0].mx_ok, 1);
});

test.after(() => {
  server?.close();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});
