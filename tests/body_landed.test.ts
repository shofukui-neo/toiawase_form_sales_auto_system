import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../src/browser/browser.js';
import { verifyBodyLanded } from '../src/layers/l4_submit.js';
import type { FormSchema, RenderedContent } from '../src/types.js';

/**
 * 「本文が入っていないのに送信する」事故を止めるための検査。
 *
 * fillForm は入力の失敗を log.warn で握りつぶして先へ進んでいた。ロケータが
 * 剥がれてもブラウザが落ちても、そのまま送信ボタンを押すので、相手には氏名と
 * メールだけの空の問い合わせが届く。しかも完了ページには遷移するため L5 は
 * 「成功」と記録し、返信が来ないまま「アポ率 0%」の分母に入る。
 */

const BODY =
  '突然のご連絡失礼いたします。株式会社ネオキャリアの福井 聖と申します。' +
  '新卒採用管理システム「MOCHICA」は、応募者とのやり取りを LINE に集約できます。';

const schema = {
  formUrl: 'about:blank',
  fields: [],
  mappings: [{ role: 'message', selector: '#msg', confidence: 1 }],
  hasConfirmScreen: false,
  hasCaptcha: 'none',
  mappingConfidence: 1,
} as unknown as FormSchema;

const content = { subject: '件名', body: BODY, values: {} } as unknown as RenderedContent;

async function check(fill: string | null) {
  const session = new BrowserSession({ seed: 3 });
  try {
    const page = await session.open();
    await page.setContent('<!doctype html><html><body><textarea id="msg"></textarea></body></html>');
    if (fill !== null) await page.locator('#msg').fill(fill);
    return await verifyBodyLanded(page, schema, content);
  } finally {
    await session.close();
  }
}

test('本文欄が空なら送信を止める', async () => {
  const r = await check('');
  assert.equal(r.ok, false);
  assert.match(r.detail, /空/);
});

test('本文が途中までしか入っていなければ送信を止める', async () => {
  const r = await check(BODY.slice(0, Math.floor(BODY.length * 0.5)));
  assert.equal(r.ok, false);
  assert.match(r.detail, /途中/);
});

test('本文が入っていれば通す', async () => {
  const r = await check(BODY);
  assert.equal(r.ok, true);
});

test('改行や全角空白の差では止めない（フォーム側の正規化を許容する）', async () => {
  const r = await check(BODY.replace(/。/g, '。\n　'));
  assert.equal(r.ok, true);
});

test('maxlength で数文字削られた程度では止めない', async () => {
  const r = await check(BODY.slice(0, BODY.length - 4));
  assert.equal(r.ok, true);
});
