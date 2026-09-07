import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleMap } from '../src/layers/l2_parsing.js';
import { computeCoverage } from '../src/layers/coverage.js';
import { shouldFillField } from '../src/layers/fillPolicy.js';
import type { CompanyRow, DetectedField, FormSchema } from '../src/types.js';

/**
 * 「必須なのに埋められない」として企業ごと除外していたケースの回帰テスト。
 *
 * 抑制リストの最大要因は unfillable_required の 638 社だった。中身を見ると
 * サイト内検索の入力欄、見出しが「空のままにしてください」と書かれた罠、
 * そして辞書から漏れていた「名前」「FAX番号」が並んでいた。どれも
 * 「この企業には送れない」という結論の根拠になっていなかった。
 */

let seq = 0;
const f = (o: Partial<DetectedField>): DetectedField =>
  ({
    selector: `#f${seq++}`,
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

const company = {
  id: 1,
  name: 'テスト株式会社',
  domain: 'example.co.jp',
  status: 'PARSED',
} as unknown as CompanyRow;

const schemaOf = (fields: DetectedField[]): FormSchema =>
  ({
    formUrl: 'https://example.co.jp/contact/',
    fields,
    mappings: ruleMap(fields).mappings,
    hasConfirmScreen: false,
    hasCaptcha: 'none',
    mappingConfidence: 1,
  }) as unknown as FormSchema;

/* ------------------------------ 辞書の漏れ ------------------------------ */

test('「お」の付かない「名前」も氏名欄として扱う', () => {
  // 辞書には「お名前」しかなく、「名前」だけの見出しが対応付かないまま
  // 「必須なのに未マッピング」として企業が捨てられていた。
  for (const label of ['名前', '名前必須', '名前 *', 'お名前']) {
    const r = ruleMap([f({ labelText: label })]);
    assert.equal(r.mappings[0]?.role, 'name', `${label} が氏名欄にならない`);
  }
});

test('FAX 欄に対応する（実在の番号を持っているので捨てる理由がない）', () => {
  const r = ruleMap([f({ labelText: 'FAX番号', required: true })]);
  assert.equal(r.mappings[0]?.role, 'fax');
});

test('FAX は必須のときだけ入力する（任意欄には書かない）', () => {
  assert.equal(shouldFillField(f({ required: true }), 'fax'), true);
  assert.equal(shouldFillField(f({ required: false }), 'fax'), false);
});

test('電話欄を FAX と取り違えない', () => {
  const r = ruleMap([f({ labelText: '電話番号', required: true })]);
  assert.equal(r.mappings[0]?.role, 'phone');
});

/* --------------------------- 送信可否の判断 --------------------------- */

const missingLabels = (fields: DetectedField[]) =>
  computeCoverage(company, schemaOf(fields))
    .fields.filter((x: { status: string }) => x.status === 'missing')
    .map((x: { label: string }) => x.label);

test('サイト内検索の欄を「埋められない必須欄」に数えない', () => {
  // 実データでは「検索」「キーワード検索」が必須欄として数えられ、
  // それだけで企業が除外されていた。問い合わせフォームの欄ではない。
  const fields = [
    f({ labelText: '検索', required: true }),
    f({ labelText: 'キーワード検索', required: true }),
    f({ type: 'search', name: 's', required: true }),
    f({ labelText: 'お問い合わせ内容', tag: 'textarea', type: 'textarea', required: true }),
  ];
  assert.deepEqual(missingLabels(fields), []);
});

test('見出しが「空のままにしてください」の欄は罠として扱う', () => {
  const fields = [
    f({ labelText: 'このフィールドは空のままにしてください。', required: true }),
    f({ labelText: 'お問い合わせ内容', tag: 'textarea', type: 'textarea', required: true }),
  ];
  const cov = computeCoverage(company, schemaOf(fields));
  assert.equal(cov.coverage.missing, 0);
  assert.ok(cov.coverage.honeypots >= 1, '罠として数えられていない');
});

test('装飾違いの同名欄を別物として数えない（姓名の分割欄で誤除外していた）', () => {
  // 「名前」に役割が付き、「名前必須」が未マッピングで残ると、以前は
  // 完全一致で比べていたため別の欄とみなされ missing になっていた。
  const fields = [
    f({ labelText: '名前', required: true }),
    f({ labelText: '名前必須', required: true }),
    f({ labelText: 'お問い合わせ内容', tag: 'textarea', type: 'textarea', required: true }),
  ];
  assert.deepEqual(missingLabels(fields), []);
});

test('本当に埋められない必須欄は今も除外の根拠になる', () => {
  // 何でも通してしまうと、空欄のまま送ってバリデーションで弾かれる。
  const fields = [
    f({ labelText: '生年月日', required: true }),
    f({ labelText: 'お問い合わせ内容', tag: 'textarea', type: 'textarea', required: true }),
  ];
  assert.deepEqual(missingLabels(fields), ['生年月日']);
});
