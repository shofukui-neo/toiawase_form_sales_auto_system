import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';

// DB を開く前に差し替える。canSendNow は日次上限のために send_ledger を読む。
const tmp = mkdtempSync(join(tmpdir(), 'pacing-'));
config.dbPath = join(tmp, 'test.db');

const { closeDb } = await import('../src/db/db.js');
const { canSendNow, withinSendWindow } = await import('../src/crosscutting/pacing.js');

/**
 * 送信可能時間帯のテスト。
 *
 * 既定は 7-23（深夜 23時〜翝7時は送信しない）。深夜に営業連絡が
 * 飛ぶのも、逆に「夜だから送れない」で一斉送信が黙って待機に入るのも
 * 痛いので、境界時刻を明示的に確かめる。
 */

function withWindow<T>(start: number, end: number, fn: () => T): T {
  const s = config.sendWindowStart;
  const e = config.sendWindowEnd;
  config.sendWindowStart = start;
  config.sendWindowEnd = end;
  try {
    return fn();
  } finally {
    config.sendWindowStart = s;
    config.sendWindowEnd = e;
  }
}

const ALL_HOURS = Array.from({ length: 24 }, (_, h) => h);

test('現行設定（.env 込み）は深夜を止め、日中は通す (7-23)', () => {
  // ここだけは withWindow で上書きせず、.env を読んだ後の実効値を見る。
  // .env や config の既定が 24 時間送信に戻されたらここで落ちる。
  assert.equal(config.sendWindowStart, 7);
  assert.equal(config.sendWindowEnd, 23);
  for (const h of [23, 0, 2, 4, 6]) {
    assert.equal(withinSendWindow(h), false, `深夜 ${h}時に送信できてしまう`);
  }
  for (const h of [7, 9, 12, 18, 22]) {
    assert.equal(withinSendWindow(h), true, `${h}時が送信不可になっている`);
  }
});

test('0-24 を明示指定したときだけ 24 時間送信になる', () => {
  withWindow(0, 24, () => {
    for (const h of ALL_HOURS) {
      assert.equal(withinSendWindow(h), true, `${h}時が送信不可になっている`);
    }
  });
});

test('start === end は「制限なし」と解釈する（幅ゼロで全滅させない）', () => {
  withWindow(9, 9, () => {
    for (const h of ALL_HOURS) assert.equal(withinSendWindow(h), true, `${h}時`);
  });
});

test('窓を狭めれば従来どおり時間外は止まる', () => {
  withWindow(9, 19, () => {
    assert.equal(withinSendWindow(8), false);
    assert.equal(withinSendWindow(9), true);
    assert.equal(withinSendWindow(18), true);
    assert.equal(withinSendWindow(19), false);
    assert.equal(withinSendWindow(3), false);
  });
});

test('start > end は日をまたぐ夜間帯として扱う (20-6)', () => {
  withWindow(20, 6, () => {
    assert.equal(withinSendWindow(21), true);
    assert.equal(withinSendWindow(0), true);
    assert.equal(withinSendWindow(5), true);
    assert.equal(withinSendWindow(6), false);
    assert.equal(withinSendWindow(12), false);
  });
});

test('canSendNow: 現行設定では深夜 3 時の送信を拒む', () => {
  const midnight = new Date(2026, 0, 15, 3, 0, 0);
  const decision = canSendNow(midnight);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? '', /outside send window/);
});

test('canSendNow: 現行設定でも日中（10時）は送れる', () => {
  const daytime = new Date(2026, 0, 15, 10, 0, 0);
  const decision = canSendNow(daytime);
  assert.equal(decision.allowed, true, decision.reason ?? '');
});

test('canSendNow: 0-24 を明示指定すれば深夜 3 時でも送信できる', () => {
  withWindow(0, 24, () => {
    const midnight = new Date(2026, 0, 15, 3, 0, 0);
    const decision = canSendNow(midnight);
    assert.equal(decision.allowed, true, decision.reason ?? '');
  });
});

test('canSendNow: 日次上限に達したら時間帯に関係なく止まる', async () => {
  const { sendLedger } = await import('../src/db/repositories.js');
  const { todayKey } = await import('../src/crosscutting/pacing.js');
  const limit = config.dailySendLimit;
  config.dailySendLimit = 2;
  try {
    const now = new Date(2026, 0, 15, 3, 0, 0);
    sendLedger.record(1, todayKey(now));
    sendLedger.record(2, todayKey(now));
    withWindow(0, 24, () => {
      const decision = canSendNow(now);
      assert.equal(decision.allowed, false);
      assert.match(decision.reason ?? '', /daily send limit/);
    });
  } finally {
    config.dailySendLimit = limit;
  }
});

test.after(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});
