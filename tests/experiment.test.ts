import test from 'node:test';
import assert from 'node:assert/strict';
import { assignVariant, variantByName, VARIANTS } from '../src/pipeline/experiment.js';
import { renderContent } from '../src/layers/l3_content.js';
import type { CompanyRow, FormSchema } from '../src/types.js';

/**
 * 文面 A/B の割り当て。
 *
 * 承認フローがある以上、割り当てが実行のたびに変わってはいけない。
 * プラン画面で見た文面と実際に送る文面が食い違えば、承認の意味が無くなる。
 */

const company = {
  id: 1234,
  name: 'テスト株式会社',
  domain: 'example.co.jp',
  status: 'PARSED',
  icp_score: 0.8,
} as unknown as CompanyRow;

const schema = {
  formUrl: 'https://example.co.jp/contact/',
  fields: [],
  mappings: [{ role: 'message', selector: '#msg', confidence: 1 }],
  hasConfirmScreen: false,
  hasCaptcha: 'none',
  mappingConfidence: 1,
} as unknown as FormSchema;

test('同じ企業は何度呼んでも同じ文面になる（プレビューと送信が食い違わない）', () => {
  for (const id of [1, 7, 42, 1234, 99999]) {
    const first = assignVariant(id).name;
    for (let i = 0; i < 20; i++) assert.equal(assignVariant(id).name, first);
  }
});

test('腕がおおむね均等に割れる（取り込み順が腕に偏らない）', () => {
  const counts = new Map<string, number>();
  for (let id = 1; id <= 4000; id++) {
    const n = assignVariant(id).name;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  assert.equal(counts.size, VARIANTS.length);
  for (const [name, n] of counts) {
    const share = n / 4000;
    assert.ok(share > 0.4 && share < 0.6, `${name} の比率が偏っている: ${(share * 100).toFixed(1)}%`);
  }
});

test('連番の企業が同じ腕に固まらない（ID をそのまま剰余で割っていない）', () => {
  // 取り込み順は業種や名簿の並びと相関するので、連番が交互に散るかを見る。
  const seq = Array.from({ length: 200 }, (_, i) => assignVariant(5000 + i).name);
  const flips = seq.filter((v, i) => i > 0 && v !== seq[i - 1]).length;
  assert.ok(flips > 40, `連番が固まりすぎている（切り替わり ${flips} 回）`);
});

test('記録された名前から文面パターンを復元できる', () => {
  for (const v of VARIANTS) assert.equal(variantByName(v.name).template, v.template);
});

test('未知の名前・未記録は対照群に倒す（過去の送信を壊さない）', () => {
  assert.equal(variantByName(null).name, VARIANTS[0].name);
  assert.equal(variantByName('存在しない腕').name, VARIANTS[0].name);
});

test('short 群は対照群より明確に短く、依頼は日程調整の一つだけ', () => {
  const long = renderContent(company, schema, { templateName: 'mochica_default' }).body;
  const short = renderContent(company, schema, { templateName: 'mochica_short' }).body;

  assert.ok(short.length < long.length * 0.75, `短くなっていない: ${short.length} vs ${long.length}`);
  // 資料送付の依頼は short から外している（依頼を一つに絞るのが仮説）。
  assert.ok(long.includes('資料をお送り'), '対照群に資料送付の依頼が無い');
  assert.ok(!short.includes('資料をお送り'), 'short 群に資料送付の依頼が残っている');
});

test('どちらの文面にも送信者の身元と配信停止の案内が残る（§9）', () => {
  for (const v of VARIANTS) {
    const body = renderContent(company, schema, { templateName: v.template }).body;
    assert.ok(body.includes('株式会社ネオキャリア'), `${v.name}: 社名が無い`);
    assert.ok(body.includes('@'), `${v.name}: 連絡先メールが無い`);
    assert.ok(/不要|以後お送りいたしません/.test(body), `${v.name}: 配信停止の案内が無い`);
    assert.ok(body.includes(company.name), `${v.name}: 宛先企業名が無い`);
  }
});
