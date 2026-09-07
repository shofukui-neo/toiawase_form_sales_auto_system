import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEml, parseMailCsv } from '../src/pipeline/replyImport.js';

/**
 * 受信メールの読み取り。
 *
 * 日本語のメールは件名が MIME エンコードされ、本文が base64 や
 * quoted-printable になっていることが普通なので、そのまま文字列一致に
 * かけても何も当たらない。ここを取りこぼすと「返信 0 件」に見えてしまい、
 * 誤った結論（文面が悪い）に進むことになる。
 */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('MIME エンコードされた件名を戻す', () => {
  const eml = [
    'From: jinji@example.co.jp',
    `Subject: =?UTF-8?B?${b64('Re: 新卒採用のご担当者様へ')}?=`,
    '',
    'ご連絡ありがとうございます。',
  ].join('\n');
  const m = parseEml(eml);
  assert.equal(m.subject, 'Re: 新卒採用のご担当者様へ');
  assert.equal(m.from, 'jinji@example.co.jp');
});

test('base64 の本文を戻す', () => {
  const body = 'お世話になっております。9月10日 14時でしたら打ち合わせ可能です。';
  const eml = [
    'From: jinji@example.co.jp',
    'Subject: Re',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body),
  ].join('\n');
  assert.equal(parseEml(eml).body.trim(), body);
});

test('quoted-printable の本文を戻す', () => {
  const eml = [
    'From: a@example.co.jp',
    'Subject: Re',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hello=20world=',
    'continued',
  ].join('\n');
  assert.equal(parseEml(eml).body.trim(), 'Hello worldcontinued');
});

test('折り返されたヘッダを 1 行として読む', () => {
  const eml = ['From: jinji@example.co.jp', 'Subject: Re: ご提案について', '\tのご返信', '', 'body'].join('\n');
  assert.match(parseEml(eml).subject, /ご提案について のご返信/);
});

test('未対応の文字コードは黙って取りこぼさず、はっきり断る', () => {
  // ISO-2022-JP のまま化けたテキストを判定すると「本文が空」として
  // 静かに捨てられ、返信があったのに 0 件に見える。
  const eml = [
    'From: a@example.co.jp',
    'Subject: Re',
    'Content-Type: text/plain; charset="ISO-2022-JP"',
    '',
    'body',
  ].join('\n');
  assert.throws(() => parseEml(eml), /ISO-2022-JP|UTF-8 に書き出/);
});

test('自動返信ヘッダを読み取れる', () => {
  const eml = ['From: noreply@example.co.jp', 'Subject: Re', 'Auto-Submitted: auto-replied', '', 'x'].join('\n');
  assert.equal(parseEml(eml).headers?.['auto-submitted'], 'auto-replied');
});

test('CSV を読む（引用内の改行とカンマを含む本文）', () => {
  const csv =
    'from,subject,date,body\n' +
    '"jinji@example.co.jp","Re: ご提案","2026-09-08 10:00","お世話になります。\n' +
    '9月10日、14時でいかがでしょうか。"\n';
  const mails = parseMailCsv(csv);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].from, 'jinji@example.co.jp');
  assert.match(mails[0].body, /9月10日、14時/);
});

test('CSV の列名は日本語でも受け付ける', () => {
  const csv = '差出人,件名,本文\na@example.co.jp,件名です,本文です\n';
  const mails = parseMailCsv(csv);
  assert.equal(mails[0].from, 'a@example.co.jp');
  assert.equal(mails[0].body, '本文です');
});

test('必要な列が無い CSV は理由を言って断る', () => {
  assert.throws(() => parseMailCsv('foo,bar\n1,2\n'), /from と body/);
});
