import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFormAudience,
  looksLikeJobSeekerPage,
  isApplicantOption,
} from '../src/crosscutting/formAudience.js';
import { classifyEligibility } from '../src/crosscutting/eligibility.js';
import { pickOption } from '../src/layers/l2_choice.js';
import { pickChoiceIndex } from '../src/layers/l4_submit.js';
import { computeCoverage } from '../src/layers/coverage.js';
import { ruleMap } from '../src/layers/l2_parsing.js';
import type { CompanyRow, DetectedField, FormSchema } from '../src/types.js';

/**
 * 送信先を「企業として応対している窓口」に限定するための判定テスト。
 *
 * 採用サイトのお問い合わせや応募フォームは求職者を待っている窓口で、そこに
 * 営業文面が届いても商談にはならない。一方で「会社名・学校名など」のように
 * 企業と学生の両方を1つの欄で受ける総合窓口は本物の営業窓口なので、
 * 落としてはいけない。実データ（送信済み・承認待ちの 1,886 社）で見つかった
 * 境界例をそのまま並べてある。
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

const audienceOf = (
  fields: DetectedField[],
  opts: { url?: string; heading?: string; pageText?: string } = {},
) =>
  classifyFormAudience({
    formUrl: opts.url ?? 'https://example.co.jp/contact/',
    fields,
    heading: opts.heading,
    pageText: opts.pageText,
  });

/* ------------------------- 入力項目からの判定 ------------------------- */

test('応募者しか書けない欄があれば求職者向けと判定する', () => {
  for (const label of ['志望動機', '希望職種', '卒業（予定）学校名', '職務経歴書', '最終学歴']) {
    const v = audienceOf([f({ labelText: label }), f({ tag: 'textarea', labelText: 'お問い合わせ内容' })]);
    assert.equal(v.audience, 'job_seeker', `${label} が応募フォームと判定されない`);
  }
});

test('「会社名・学校名など」の総合窓口は落とさない', () => {
  // サガミエレク・近畿防蝕・NTTデータMHIシステムズ 等。企業の人と学生を
  // 1つの欄で受けているだけで、営業の宛先として正しい窓口。
  const v = audienceOf([
    f({ labelText: '会社名・学校名など', required: true }),
    f({ labelText: '所属部署／学部・学科など' }),
    f({ tag: 'textarea', labelText: 'お問い合わせ内容', required: true }),
  ]);
  assert.equal(v.audience, 'business');
});

test('学生向けの欄が1つだけなら採用ページの外では落とさない', () => {
  // 学校名・学部名を任意欄として置いている総合フォーム（エムイーシー）。
  const v = audienceOf([
    f({ labelText: '学校名' }),
    f({ labelText: '氏名' }),
    f({ tag: 'textarea', labelText: 'ご質問' }),
  ]);
  assert.notEqual(v.audience, 'job_seeker');
});

/* --------------------------- 選択肢からの判定 --------------------------- */

test('種別の選択肢が採用区分で埋まっていれば求職者向け', () => {
  // テイクシステムズ /recruit/contact/ の「お問い合わせ項目」。
  const v = audienceOf([
    f({
      tag: 'select',
      required: true,
      labelText: 'お問い合わせ項目',
      options: ['お選びください', '新卒採用', '経験者採用', '障がい者採用', 'その他お問い合わせ'],
    }),
  ]);
  assert.equal(v.audience, 'job_seeker');
});

test('総合窓口の選択肢に採用が1つ混ざっていても落とさない', () => {
  // エア・ウォーター・パフォーマンスケミカルのラジオ。「採用について（応募／
  // 選考に関するお問い合わせ）」の隣に「会社全般」があり、そちらを選べばよい。
  const radios = [
    '電子材料・医農薬分野',
    '基礎化学品分野',
    '採用について（新卒・中途・パート・派遣の応募／選考に関するお問い合わせ）',
    '会社全般（事業内容・IR・お取引／業務のご相談に関するお問い合わせ）',
    'その他',
  ].map((labelText) => f({ type: 'radio', name: 'category', labelText, required: true }));
  const v = audienceOf([...radios, f({ labelText: '会社名' }), f({ tag: 'textarea', labelText: '内容' })]);
  assert.equal(v.audience, 'business');
});

test('人材会社の「新卒採用のご相談」は営業窓口として残す', () => {
  const v = audienceOf([
    f({
      tag: 'select',
      required: true,
      options: ['選択してください', '新卒採用のご相談', '中途採用のご支援', 'その他'],
    }),
    f({ labelText: '会社名' }),
  ]);
  assert.equal(v.audience, 'business');
});

/* --------------------------- URL・見出しの判定 --------------------------- */

test('採用サイトの見出しなら求職者向け', () => {
  const v = audienceOf([f({ labelText: 'お名前' }), f({ tag: 'textarea', labelText: 'お問い合わせ内容' })], {
    url: 'https://www.example.co.jp/contact/',
    heading: '採用に関するお問い合わせ｜株式会社サンプル',
  });
  assert.equal(v.audience, 'job_seeker');
});

test('URL に recruit があるだけでは落とさない（社名や入力フォームの entry と区別する）', () => {
  // 人材会社のコーポレートサイト。会社名欄があり、採用サイトの語も出てこない。
  const v = audienceOf([f({ labelText: '会社名', required: true }), f({ tag: 'textarea', labelText: '内容' })], {
    url: 'https://www.example-recruit.co.jp/contact/',
    heading: 'お問い合わせ | 株式会社サンプル',
    pageText: 'お問い合わせ 会社概要 事業内容',
  });
  assert.equal(v.audience, 'business');

  // /entry.php を「入力フォーム」の意味で使う CMS。
  const cms = audienceOf([f({ labelText: '会社名' }), f({ tag: 'textarea', labelText: '内容' })], {
    url: 'https://www.example.co.jp/inquiry/entry.php?type=1',
  });
  assert.equal(cms.audience, 'business');
});

test('採用ページの URL に採用サイトの本文が伴えば求職者向け', () => {
  const v = audienceOf([f({ labelText: 'お名前' }), f({ tag: 'textarea', labelText: '内容' })], {
    url: 'https://www.example.co.jp/recruit/contact/',
    heading: 'お問い合わせ',
    pageText: '募集要項 エントリー 福利厚生 先輩社員',
  });
  assert.equal(v.audience, 'job_seeker');
});

test('looksLikeJobSeekerPage は入力項目を見ずにページだけで判定する（L1 の候補選別）', () => {
  assert.ok(
    looksLikeJobSeekerPage({
      url: 'https://www.example.co.jp/contact/',
      heading: '新卒採用エントリーフォーム',
      pageText: '募集要項 選考の流れ',
    }),
  );
  assert.equal(
    looksLikeJobSeekerPage({
      url: 'https://www.example.co.jp/contact/',
      heading: 'お問い合わせ | 株式会社サンプル',
      pageText: 'お問い合わせ 会社概要 採用情報',
    }),
    null,
  );
});

/* ----------------------- 除外（eligibility）への反映 ----------------------- */

const company = {
  id: 1,
  name: 'テスト株式会社',
  domain: 'example.co.jp',
  status: 'PARSED',
} as unknown as CompanyRow;

const schemaOf = (fields: DetectedField[], extra: Partial<FormSchema> = {}): FormSchema =>
  ({
    formUrl: 'https://example.co.jp/contact/',
    fields,
    mappings: ruleMap(fields).mappings,
    hasConfirmScreen: false,
    hasCaptcha: 'none',
    mappingConfidence: 1,
    ...extra,
  }) as unknown as FormSchema;

test('求職者向けと判定されたフォームは送信対象から外れる', () => {
  const schema = schemaOf(
    [
      f({ labelText: 'お名前', required: true }),
      f({ labelText: 'メールアドレス', type: 'email', required: true }),
      f({ tag: 'textarea', labelText: 'お問い合わせ内容', required: true }),
    ],
    { audience: 'job_seeker', audienceEvidence: '見出し「採用エントリー」' },
  );
  const v = classifyEligibility(schema, computeCoverage(company, schema));
  assert.equal(v.eligible, false);
  assert.equal(v.reason, 'job_seeker_form');
  assert.equal(v.detail, '見出し「採用エントリー」');
});

test('判定前に保存されたフォームは URL と入力項目から再判定する', () => {
  // audience を持たない古い field_maps。ページ本文は無いので、応募者しか
  // 書けない欄だけで判断する。
  const schema = schemaOf([
    f({ labelText: '希望職種', required: true }),
    f({ labelText: 'お名前', required: true }),
    f({ tag: 'textarea', labelText: 'ご質問', required: true }),
  ]);
  const v = classifyEligibility(schema, computeCoverage(company, schema));
  assert.equal(v.reason, 'job_seeker_form');
});

/* ------------------------- 種別の自動選択 ------------------------- */

test('必須の種別で求職者向けの選択肢は選ばない', () => {
  assert.ok(isApplicantOption('新卒採用エントリー'));
  assert.ok(!isApplicantOption('新卒採用のご相談'));

  // フォールバック（先頭の実選択肢）でも応募を選ばない。
  assert.deepEqual(pickOption(['選択してください', '新卒採用', '経験者採用', 'その他お問い合わせ']), {
    value: 'その他お問い合わせ',
    confident: true,
  });
  assert.equal(pickOption(['選択してください', '新卒採用', 'アルバイト応募']), null);
});

test('種別の自動選択は企業としての用件を優先する（採用区分は選ばない）', () => {
  const labels = [
    '選択してください',
    '採用について（応募／選考に関するお問い合わせ）',
    '会社全般（お取引・業務のご相談）',
    'その他',
  ];
  assert.equal(labels[pickChoiceIndex(labels)], '会社全般（お取引・業務のご相談）');
  assert.equal(pickChoiceIndex(['選択してください', 'ご応募', 'お問い合わせ・ご質問']), 2);
});
