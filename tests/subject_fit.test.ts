import test from 'node:test';
import assert from 'node:assert/strict';
import { shortenSubject, resolveFieldValue } from '../src/layers/fillPolicy.js';
import { renderContent, buildSignature } from '../src/layers/l3_content.js';
import type { CompanyRow, DetectedField, FormSchema } from '../src/types.js';

const company = {
  id: 1,
  name: 'テスト株式会社',
  domain: 'example.co.jp',
  status: 'PARSED',
} as unknown as CompanyRow;

/**
 * 件名の詰め方。
 *
 * 件名欄に maxlength=30 を掛けているフォームは珍しくないが、既定の件名は
 * 40 字を超える。以前はこれを「本文が長すぎる」として企業ごと除外していた
 * （message_too_long 158 社のうち 102 社は本文欄に上限すら無かった）。
 * 件名はこちらが用意した見出しなので、短くしても相手に渡す情報は減らない。
 */

const field = (o: Partial<DetectedField>): DetectedField =>
  ({
    selector: '#s',
    tag: 'input',
    type: 'text',
    name: null,
    id: null,
    labelText: null,
    placeholder: null,
    required: false,
    honeypot: false,
    maxLength: null,
    autocomplete: null,
    options: [],
    ...o,
  }) as DetectedField;

const SUBJ = '新卒採用のご担当者様へ／LINEで応募者対応を一元化するご提案（株式会社ネオキャリア）';

test('括弧書きの補足を先に落とす', () => {
  const out = shortenSubject(SUBJ, 40);
  assert.ok(out.length <= 40);
  assert.ok(!out.includes('（株式会社ネオキャリア）'));
  assert.ok(out.includes('新卒採用'));
});

test('それでも長ければ区切り文字の手前で切る（意味の切れ目で終える）', () => {
  const out = shortenSubject(SUBJ, 20);
  assert.ok(out.length <= 20, `${out.length}字: ${out}`);
  assert.equal(out, '新卒採用のご担当者様へ');
});

test('区切りでも収まらなければ切り捨てる', () => {
  const out = shortenSubject(SUBJ, 8);
  assert.equal(out.length, 8);
  assert.ok(!out.includes('…'), '相手の画面で意図が伝わらない記号は入れない');
});

test('上限内ならそのまま返す', () => {
  assert.equal(shortenSubject(SUBJ, 200), SUBJ);
});

test('件名は入力上限に合わせて詰める', () => {
  const v = resolveFieldValue(field({ maxLength: 20 }), 'subject', { subject: SUBJ });
  assert.ok(v && v.length <= 20, `詰められていない: ${v}`);
});

test('氏名・会社名・メールは絶対に詰めない（嘘の値を送ることになる）', () => {
  for (const role of ['name', 'company', 'email'] as const) {
    const long = 'あ'.repeat(50);
    const v = resolveFieldValue(field({ maxLength: 10 }), role, { [role]: long });
    assert.equal(v, long, `${role} が切り詰められている`);
  }
});

/* ------------------------------ 短縮署名 ------------------------------ */

test('短縮署名でも名乗りと連絡先は残る（§9 を満たす）', () => {
  const compact = buildSignature({ compact: true });
  const full = buildSignature();
  assert.ok(compact.length < full.length / 2, `短くなっていない: ${compact.length} vs ${full.length}`);
  assert.ok(compact.includes('株式会社ネオキャリア'), '社名が落ちている');
  assert.ok(compact.includes('@'), '返信先が落ちている');
  // 住所・FAX・URL は落としてよい（§9 が求めているのは連絡先）。
  assert.ok(!compact.includes('FAX'), 'FAX が残っている');
});

test('本文欄が狭いフォームでは署名を短い形に差し替えて収める', () => {
  const tight = {
    formUrl: 'https://example.co.jp/contact/',
    fields: [{ selector: '#msg', maxLength: 600, tag: 'textarea', type: 'textarea', required: true }],
    mappings: [{ role: 'message', selector: '#msg', confidence: 1 }],
    hasConfirmScreen: false,
    hasCaptcha: 'none',
    mappingConfidence: 1,
  } as unknown as FormSchema;

  const body = renderContent(company, tight, { templateName: 'mochica_short' }).body;
  assert.ok(body.length <= 600, `収まっていない: ${body.length}字`);
  // 縮めても送信者が誰かは分かる状態を保つ。
  assert.ok(body.includes('株式会社ネオキャリア'));
  assert.ok(body.includes('sho.fukui@neo-career.co.jp'));
  assert.ok(!body.includes('FAX'), '短縮署名になっていない');
});

test('余裕があるフォームでは通常の署名のまま', () => {
  const roomy = {
    formUrl: 'https://example.co.jp/contact/',
    fields: [{ selector: '#msg', maxLength: 4000, tag: 'textarea', type: 'textarea', required: true }],
    mappings: [{ role: 'message', selector: '#msg', confidence: 1 }],
    hasConfirmScreen: false,
    hasCaptcha: 'none',
    mappingConfidence: 1,
  } as unknown as FormSchema;
  assert.ok(renderContent(company, roomy, { templateName: 'mochica_short' }).body.includes('FAX'));
});
