import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';

// renderContent は content_overrides を読むので DB が要る（読めなくても落ちない
// 作りだが、実運用と同じ経路を通したいので一時 DB を用意する）。
const tmp = mkdtempSync(join(tmpdir(), 'content-guard-'));
config.dbPath = join(tmp, 'test.db');

const { closeDb } = await import('../src/db/db.js');
const { renderContent } = await import('../src/layers/l3_content.js');
const { verifyContent } = await import('../src/crosscutting/contentGuard.js');
import type { CompanyRow, DetectedField, FormSchema } from '../src/types.js';

/**
 * 送信内容の最終検証（誤送信ガード）のテスト。
 *
 * 実際に起きた誤送信は「フォームは埋まるが、入れる値が間違っている」型
 * だった。フォーム側のゲート（coverage / eligibility）はそれを見ないので、
 * ここが最後の砦になる。壊れた内容が 1 パターンでも素通りすると相手に届く。
 */

const COMPANY = { id: 1, name: 'テスト販売株式会社' } as CompanyRow;

function field(over: Partial<DetectedField> = {}): DetectedField {
  return {
    selector: '#message', tag: 'textarea', type: null, name: 'message', id: 'message',
    labelText: 'お問い合わせ内容', placeholder: null, required: true, honeypot: false,
    maxLength: null, autocomplete: null, ...over,
  };
}

/** 本文欄だけを持つ最小スキーマ。maxLength を渡すと入力上限テストになる。 */
function schemaWith(maxLength: number | null = null): FormSchema {
  return {
    formUrl: 'https://example.test/contact',
    formSelector: 'form',
    fields: [field({ maxLength })],
    mappings: [{ selector: '#message', role: 'message', confidence: 0.9 } as FormSchema['mappings'][number]],
    hasConfirmScreen: false, hasCaptcha: 'none', hasHoneypot: false, noSalesPolicy: false,
    ambiguousChoice: false, mappingConfidence: 0.9, gate: 'high',
  };
}

const codes = (v: { issues: { code: string }[] }): string[] => v.issues.map((i) => i.code);

/* ------------------------------------------------------------------ */
/* 正常系: 実テンプレート + 実 .env で組んだ内容は通らなければならない    */
/* ------------------------------------------------------------------ */

test('実際のテンプレートで生成した内容は検証を通る', () => {
  const content = renderContent(COMPANY, schemaWith());
  const v = verifyContent(COMPANY, schemaWith(), content);
  assert.equal(v.ok, true, `検証NG: ${JSON.stringify(v.issues, null, 2)}`);
});

test('生成された本文に氏名・電話番号・日程調整URLが載っている', () => {
  const { body } = renderContent(COMPANY, schemaWith());
  const s = config.sender;
  assert.ok(body.includes(s.person.replace(/\s+/g, '')), '署名に氏名がない');
  assert.ok(body.includes(s.phone), '署名に電話番号がない');
  assert.ok(body.includes(COMPANY.name), '宛名がない');
  if (s.bookingUrl) assert.ok(body.includes(s.bookingUrl), '日程調整URLがない');
});

/* ------------------------------------------------------------------ */
/* ① 文面                                                              */
/* ------------------------------------------------------------------ */

/** 正常な内容を作り、一部だけ壊して渡すためのヘルパー。 */
function broken(mutate: (c: ReturnType<typeof renderContent>) => void) {
  const content = renderContent(COMPANY, schemaWith());
  mutate(content);
  return verifyContent(COMPANY, schemaWith(), content);
}

test('本文が空なら止める', () => {
  const v = broken((c) => { c.body = ''; c.values.message = ''; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('body_empty'));
});

test('未置換の差し込み項目が残っていたら止める', () => {
  const v = broken((c) => { c.body += '\n{{senderPerson}} 様'; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('placeholder_left'));
});

test('テンプレートの制御タグが残っていたら止める', () => {
  const v = broken((c) => { c.body += '\n<!--optional:1-->'; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('template_marker_left'));
});

test('他社の文面を使い回して宛名が違えば止める', () => {
  const content = renderContent({ id: 9, name: '別会社ホールディングス' } as CompanyRow, schemaWith());
  const v = verifyContent(COMPANY, schemaWith(), content);
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('recipient_missing'));
});

test('本文が入力上限を超えていたら止める（自動短縮でも収まらないケース）', () => {
  const small = schemaWith(200);
  const content = renderContent(COMPANY, small);
  const v = verifyContent(COMPANY, small, content);
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('body_over_limit'), JSON.stringify(codes(v)));
});

/* ------------------------------------------------------------------ */
/* ② 氏名（福井 聖）                                                    */
/* ------------------------------------------------------------------ */

test('氏名が設定と違えば止める（旧字・誤字の作り込み）', () => {
  const v = broken((c) => { c.values.name = '福井 翔'; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('name_mismatch'));
});

test('氏名の空白の有無は差分として扱わない', () => {
  const v = broken((c) => { c.values.name = config.sender.person.replace(/\s+/g, ''); });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('姓名の分割欄だけ古いまま残っていたら止める', () => {
  const v = broken((c) => { c.values.name_mei = '翔'; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('name_split_mismatch'));
});

test('氏名が入力値に無ければ止める', () => {
  const v = broken((c) => { delete c.values.name; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('name_missing'));
});

/** 本文から氏名を消す。挨拶文は「福井 聖」、署名は「福井聖」と表記が違う。 */
function stripName(body: string): string {
  const p = config.sender.person;
  return body.split(p).join('').split(p.replace(/[\s　]+/g, '')).join('');
}

test('本文から氏名が消えていたら止める', () => {
  const v = broken((c) => { c.body = stripName(c.body); });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('name_not_in_body'), codes(v).join(', '));
});

test('氏名の表記ゆれ（姓名の間の空白）は許容する', () => {
  // 挨拶文の「福井 聖」が残っていれば氏名は本文にある。ここで止めると
  // 正常な本文まで落ちるので、表記ゆれは許容が正しい。
  const v = broken((c) => { c.body = c.body.split(config.sender.person.replace(/[\s　]+/g, '')).join(''); });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

/* ------------------------------------------------------------------ */
/* ③ 電話番号                                                          */
/* ------------------------------------------------------------------ */

test('電話番号が設定と違えば止める', () => {
  const v = broken((c) => { c.values.phone = '03-1234-5678'; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('phone_mismatch'));
});

test('電話番号の区切り文字の違いは差分として扱わない', () => {
  const v = broken((c) => { c.values.phone = config.sender.phone.replace(/-/g, ''); });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('分割された電話番号欄が基準値とずれていたら止める', () => {
  const v = broken((c) => { c.values.phone2 = '9999'; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('phone_split_mismatch'));
});

test('電話番号が入力値に無ければ止める', () => {
  const v = broken((c) => { delete c.values.phone; });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('phone_missing'));
});

test('本文の署名から電話番号が消えていたら止める', () => {
  const v = broken((c) => { c.body = c.body.split(config.sender.phone).join(''); });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('phone_not_in_body'));
});

/* ------------------------------------------------------------------ */
/* ④ 日程調整 URL                                                      */
/* ------------------------------------------------------------------ */

test('日程調整URLが本文から落ちていたら止める', () => {
  assert.ok(config.sender.bookingUrl, 'SENDER_BOOKING_URL が未設定だとこのテストは意味を持たない');
  const v = broken((c) => { c.body = c.body.split(config.sender.bookingUrl).join(''); });
  assert.equal(v.ok, false);
  assert.ok(codes(v).includes('booking_url_missing'));
});

test('日程調整URLが未設定の運用では「無いこと」を問題にしない', () => {
  const original = config.sender.bookingUrl;
  config.sender.bookingUrl = '';
  try {
    const content = renderContent(COMPANY, schemaWith());
    const v = verifyContent(COMPANY, schemaWith(), content);
    assert.equal(v.ok, true, JSON.stringify(v.issues));
    assert.ok(!content.body.includes('下記より'), '案内文だけ残って URL が無い状態になっている');
  } finally {
    config.sender.bookingUrl = original;
  }
});

/* ------------------------------------------------------------------ */

test('複数壊れていれば全部まとめて報告する（1件直すたびに再送信を試さない）', () => {
  const v = broken((c) => {
    c.values.name = '福井 翔';
    c.values.phone = '03-1234-5678';
    c.body = c.body.split(config.sender.bookingUrl).join('');
  });
  assert.equal(v.ok, false);
  for (const code of ['name_mismatch', 'phone_mismatch', 'booking_url_missing']) {
    assert.ok(codes(v).includes(code), `${code} が報告されていない: ${codes(v).join(', ')}`);
  }
});

test.after(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});
