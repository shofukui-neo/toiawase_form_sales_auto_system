import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMail, matchCompany, normalizeDomain, normalizeName, type CompanyKey } from '../src/pipeline/replyMatch.js';

/**
 * 受信メールの分類。
 *
 * ここで一番大事なのは自動返信を返信に数えないこと。日本企業の問い合わせ
 * フォームはほぼ必ず自動応答を返すので、これを返信として数えると返信率は
 * 100% 近くになり、文面を比べる意味が無くなる。水増しした返信率は、
 * 水増しした送信成功件数と同じ害がある。
 */

const mail = (o: Partial<Parameters<typeof classifyMail>[0]>) =>
  classifyMail({ from: 'someone@example.co.jp', subject: '', body: '', ...o });

test('自動返信ヘッダが付いていれば返信に数えない', () => {
  const r = mail({
    subject: 'お問い合わせを受け付けました',
    body: 'お問い合わせありがとうございます。担当者より改めてご連絡いたします。',
    headers: { 'Auto-Submitted': 'auto-replied' },
  });
  assert.equal(r.kind, 'auto_reply');
});

test('件名に「自動返信」とあれば返信に数えない', () => {
  assert.equal(mail({ subject: '【自動返信】お問い合わせありがとうございました', body: 'x' }).kind, 'auto_reply');
});

test('本文が自動送信だと述べていれば返信に数えない', () => {
  const r = mail({
    subject: 'お問い合わせを承りました',
    body: 'このメールは自動的に送信されています。ご返信いただいてもお答えできません。',
  });
  assert.equal(r.kind, 'auto_reply');
});

test('「お問い合わせありがとうございます」だけでは自動返信と決めつけない', () => {
  // 人が書いた返信の書き出しにも普通に出る言い回し。これで切ると
  // 本物の返信まで捨ててしまう。
  const r = mail({
    subject: 'Re: 新卒採用のご担当者様へ',
    body: 'お問い合わせありがとうございます。弊社人事の田中と申します。詳しくお伺いできればと存じます。',
  });
  assert.equal(r.kind, 'reply');
});

test('配達エラーは返信ではなく bounce', () => {
  assert.equal(
    classifyMail({ from: 'MAILER-DAEMON@example.com', subject: 'Undelivered Mail Returned to Sender', body: '' }).kind,
    'bounce',
  );
  assert.equal(mail({ subject: 'メールが送信できませんでした', body: '' }).kind, 'bounce');
});

test('営業お断りは refusal、配信停止は optout', () => {
  assert.equal(mail({ subject: 'Re: ご提案', body: '営業目的のご連絡はご遠慮ください。' }).kind, 'refusal');
  assert.equal(mail({ subject: 'Re: ご提案', body: '配信停止をお願いします。' }).kind, 'optout');
});

test('自動応答の定型文に「営業はご遠慮ください」が入っていても自動返信を優先する', () => {
  const r = mail({
    subject: '【自動返信】お問い合わせを受け付けました',
    body: 'なお、営業目的のお問い合わせはご遠慮いただいております。',
  });
  assert.equal(r.kind, 'auto_reply');
});

test('日程が具体的に動いていればアポ', () => {
  const r = mail({
    subject: 'Re: 新卒採用のご担当者様へ',
    body: 'ご連絡ありがとうございます。9月10日 14時からでしたらお打ち合わせ可能です。',
  });
  assert.equal(r.kind, 'appointment');
});

test('予約システムの通知はアポ', () => {
  const r = mail({
    subject: '予約が完了しました',
    body: 'https://booking.receptionist.jp/mochicasales2025/30min のご予約を受け付けました。',
  });
  assert.equal(r.kind, 'appointment');
});

test('「検討します」はアポに数えない（数えると改善を判断できなくなる）', () => {
  const r = mail({ subject: 'Re: ご提案', body: 'ありがとうございます。社内で検討させていただきます。' });
  assert.equal(r.kind, 'reply');
});

/* ------------------------------ 企業の照合 ------------------------------ */

const list: CompanyKey[] = [
  { id: 1, name: '株式会社サンプル製作所', domain: 'sample-ss.co.jp' },
  { id: 2, name: 'トヨタ紡織株式会社', domain: 'toyota-boshoku.co.jp' },
  { id: 3, name: 'トヨタ車体株式会社', domain: 'toyota-body.co.jp' },
];

test('送信元ドメインが一致すればその企業に対応づける', () => {
  const m = matchCompany({ from: 'jinji@sample-ss.co.jp', subject: '', body: '' }, list);
  assert.equal(m?.company.id, 1);
  assert.equal(m?.how, 'domain');
});

test('サブドメインから返ってきても、一意に決まれば対応づける', () => {
  const m = matchCompany({ from: 'recruit@saiyo.sample-ss.co.jp', subject: '', body: '' }, list);
  assert.equal(m?.company.id, 1);
  assert.equal(m?.how, 'domain-suffix');
});

test('社名が複数社に当たるときは対応づけない（別会社に成果を付けない）', () => {
  // 「トヨタ」を含む会社が 2 社あるので、名前だけでは決められない。
  const m = matchCompany({ from: 'info@unknown-host.jp', subject: 'トヨタについて', body: 'トヨタ' }, list);
  assert.equal(m, null);
});

test('ドメインで当たらず社名が一意ならその企業に対応づける', () => {
  const m = matchCompany(
    { from: 'tanaka@gmail.com', subject: 'Re: ご提案', body: 'サンプル製作所の田中です。' },
    list,
  );
  assert.equal(m?.company.id, 1);
  assert.equal(m?.how, 'name');
});

test('法人格や記号の違いを吸収する', () => {
  assert.equal(normalizeName('株式会社サンプル製作所'), normalizeName('サンプル製作所'));
  assert.equal(normalizeDomain('WWW.Sample-SS.co.jp'), 'sample-ss.co.jp');
  assert.equal(normalizeDomain('jinji@sample-ss.co.jp>'), 'sample-ss.co.jp');
});
