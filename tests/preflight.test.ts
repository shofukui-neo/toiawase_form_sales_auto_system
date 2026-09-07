import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight, formatPreflight, type Check } from '../src/pipeline/preflight.js';

/**
 * 送信前の点検。
 *
 * これまでに見つかった不具合は、どれも例外を出さずに動き続ける種類だった
 * （証拠が残らない、除外理由が実態と違う、承認画面と送信内容が食い違う）。
 * 走らせているだけでは気づけないので、送る前に確かめられることを確かめる。
 */

test('現在の設定で、送信を止める問題が無いこと', () => {
  const checks = preflight();
  const ng = checks.filter((c) => c.level === 'ng');
  assert.deepEqual(
    ng.map((c) => `${c.title}: ${c.detail}`),
    [],
  );
});

test('点検項目に、これまで壊れていた箇所が含まれている', () => {
  const titles = preflight().map((c) => c.title);
  for (const must of ['送信者の身元', '日程調整リンク', '文面の割り当て', '証拠の保存先', '返信・アポの記録']) {
    assert.ok(
      titles.some((t) => t === must || t.startsWith(must)),
      `点検項目に「${must}」が無い`,
    );
  }
  // 文面は腕ごとに個別に確認する（片方だけ壊れても気づけるように）。
  assert.ok(titles.filter((t) => t.startsWith('文面 ')).length >= 2, '文面が腕ごとに点検されていない');
});

test('どの文面にも名乗り・返信先・配信停止の案内が入る', () => {
  // §9 の要件。ここが欠けたまま送ると、受け手は誰からの連絡か分からない。
  const broken = preflight().filter((c) => c.title.startsWith('文面 ') && c.level !== 'ok');
  assert.deepEqual(broken.map((c) => c.detail), []);
});

test('送信を止める問題があれば、そう言い切る', () => {
  const checks: Check[] = [
    { level: 'ok', title: 'a', detail: '' },
    { level: 'ng', title: 'b', detail: '' },
    { level: 'warn', title: 'c', detail: '' },
  ];
  const out = formatPreflight(checks);
  assert.match(out, /1 件が送信を止める問題/);
});

test('警告だけなら送信は止めないが、結果の解釈に影響すると伝える', () => {
  const out = formatPreflight([
    { level: 'ok', title: 'a', detail: '' },
    { level: 'warn', title: 'b', detail: '' },
  ]);
  assert.match(out, /送信できますが/);
  assert.doesNotMatch(out, /送信を止める/);
});

test('問題が無ければそう言う', () => {
  assert.match(formatPreflight([{ level: 'ok', title: 'a', detail: '' }]), /問題は見つかりませんでした/);
});
