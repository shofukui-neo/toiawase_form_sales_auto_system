import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { judgeResult } from '../src/layers/l5_result.js';

/**
 * L5 の回帰テスト。
 *
 * 背景: 旧実装は「ページ本文に成功文言がある」だけで submitted_success にして
 * いた。「ありがとうございます」はフォーム画面の常設挨拶として日常的に出るため、
 * **1度も画面が変化していない送信 109 件**が成功として記録され、その母数の上で
 * 「アポ率 0%」を数えていた。ここで固定するのは「状態が変化した証拠が無い限り
 * 成功にしない」という一点。
 */

/** 実ブラウザの代わりに、判定に必要な観測値だけを返す最小の偽 Page。 */
function fakePage(o: {
  url: string;
  text: string;
  forms?: number;
  filledTextareas?: number;
}): Page {
  return {
    url: () => o.url,
    evaluate: async () => o.text,
    locator: () => ({ count: async () => o.forms ?? 0 }),
    $$eval: async () => o.filledTextareas ?? 0,
  } as unknown as Page;
}

const BODY =
  '突然のご連絡失礼いたします。株式会社ネオキャリア 事業開発本部の福井 聖と申します。' +
  '弊社が提供する新卒採用管理システム「MOCHICA」は、応募者とのやり取りを LINE に集約できる点が特徴です。';

test('挨拶文だけで画面が変化していないものを成功にしない（旧実装の誤判定 109 件の型）', async () => {
  const page = fakePage({
    url: 'https://example.co.jp/contact/',
    // フォーム画面の見出しに常設されている挨拶。送信の完了は述べていない。
    text: `お問い合わせ\n日頃より格別のご高配を賜り、誠ににありがとうございます。\n${BODY}`,
    forms: 1,
    filledTextareas: 1,
  });
  const j = await judgeResult({
    page,
    beforeUrl: 'https://example.co.jp/contact/',
    captchaPresent: false,
    sentBody: BODY,
  });
  assert.notEqual(j.status, 'submitted_success');
  assert.equal(j.status, 'uncertain');
});

test('入力した本文が画面に残っていれば、成功文言があっても送信済みとしない', async () => {
  const page = fakePage({
    url: 'https://example.co.jp/contact/',
    text: `送信完了しました\n${BODY}`,
    forms: 1,
    filledTextareas: 1,
  });
  const j = await judgeResult({
    page,
    beforeUrl: 'https://example.co.jp/contact/',
    captchaPresent: false,
    sentBody: BODY,
  });
  assert.equal(j.status, 'uncertain');
});

test('エラー文言は成功文言より先に効く（旧実装は順序が逆だった）', async () => {
  const page = fakePage({
    url: 'https://example.co.jp/contact/',
    // 挨拶（成功文言に見える）とバリデーションエラーが同居する典型的な画面。
    text: 'いつもありがとうございます\n必須項目が入力されていません',
    forms: 1,
    filledTextareas: 0,
  });
  const j = await judgeResult({ page, beforeUrl: 'https://example.co.jp/contact/', captchaPresent: false });
  assert.equal(j.status, 'failed');
});

test('確認画面で止まったものは成功ではない（最後の送信を押せていない）', async () => {
  const page = fakePage({
    url: 'https://example.co.jp/contact/confirm/',
    text: '入力内容の確認\n以下の内容でよろしければ「送信する」を押してください',
    forms: 1,
    filledTextareas: 0,
  });
  const j = await judgeResult({ page, beforeUrl: 'https://example.co.jp/contact/', captchaPresent: false });
  assert.equal(j.status, 'uncertain');
  assert.match(j.detail, /確認画面/);
});

test('完了ページへ遷移したものは成功', async () => {
  const page = fakePage({
    url: 'https://example.co.jp/contact/thanks/',
    text: 'お問い合わせありがとうございました。担当者より改めてご連絡いたします。',
    forms: 0,
  });
  const j = await judgeResult({
    page,
    beforeUrl: 'https://example.co.jp/contact/',
    captchaPresent: false,
    sentBody: BODY,
  });
  assert.equal(j.status, 'submitted_success');
});

test('ajax 送信でフォームが消え本文も消えたものは成功', async () => {
  const page = fakePage({
    url: 'https://example.co.jp/contact/#done',
    text: 'お問い合わせを受け付けました。',
    forms: 0,
    filledTextareas: 0,
  });
  const j = await judgeResult({
    page,
    beforeUrl: 'https://example.co.jp/contact/',
    captchaPresent: false,
    sentBody: BODY,
  });
  assert.equal(j.status, 'submitted_success');
});

test('成功と判定しても、CAPTCHA があれば黙って落とされた可能性を必ず残す', async () => {
  const page = fakePage({
    url: 'https://example.co.jp/contact/thanks/',
    text: '送信完了しました',
    forms: 0,
  });
  const j = await judgeResult({
    page,
    beforeUrl: 'https://example.co.jp/contact/',
    captchaPresent: true,
    sentBody: BODY,
  });
  assert.equal(j.status, 'submitted_success');
  assert.match(j.detail, /silent-fail/);
});

test('判定に使った画面テキストを証拠として返す（後から人が検証できるように）', async () => {
  const page = fakePage({
    url: 'https://example.co.jp/contact/thanks/',
    text: '送信完了しました。ありがとうございました。',
    forms: 0,
  });
  const j = await judgeResult({ page, beforeUrl: 'https://example.co.jp/contact/', captchaPresent: false });
  assert.ok(j.evidenceText && j.evidenceText.includes('送信完了'));
});
