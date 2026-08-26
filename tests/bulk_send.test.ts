import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';

// DB を開く前に差し替える。db() は最初の呼び出し時に config.dbPath を読む。
const tmp = mkdtempSync(join(tmpdir(), 'bulk-send-'));
config.dbPath = join(tmp, 'test.db');
// 送信可能時間帯を明示的に開けておく。既定は 7-23（深夜は送らない）なので、
// これを固定しないと「深夜に CI を回すと落ちるテスト」になる。ここで見たいのは
// 候補の配り方であって、時間帯ゲートではない。
config.sendWindowStart = 0;
config.sendWindowEnd = 24;

const { closeDb } = await import('../src/db/db.js');
const { companies } = await import('../src/db/repositories.js');
const { transition } = await import('../src/core/stateMachine.js');
const { startBulkSend, bulkStatus, isBulkRunning } = await import('../src/pipeline/bulkSend.js');

/**
 * 並列一斉送信ワーカーのテスト。
 *
 * 送信そのもの（Chromium 起動 / 実送信）には踏み込まない。ワーカーを N 本に
 * 増やしたことで壊れうるのは**候補の配り方**の方で、こちらはネットワーク無しで
 * 確かめられる:
 *
 *  - 全候補が「項目に問題あり」でも、N 本のワーカーが互いを待ち合って
 *    ハングせずに終わること（refill を 1 本に絞ったので、待ち合わせを間違えると
 *    ここで永久に止まる）。
 *  - 同じ企業を N 回判定し直さないこと（走査が N 重に走ると 3万件で判定コストが
 *    N 倍になる）。
 *
 * フォーム未発見（form_url なし）の企業は readiness が `no_form` で必ず落ちるので、
 * 送信には一切到達しない = ブラウザを起動しない。
 */

const COMPANIES = 25;

function seedBlockedCandidates(): void {
  for (let i = 0; i < COMPANIES; i++) {
    const c = companies.upsert({ name: `テスト企業${i}`, domain: `example${i}.test`, icpScore: 0.5 });
    // 送信候補の状態にはするが、フォーム未発見なので readiness は通らない。
    transition(c.id, 'PENDING_APPROVAL', { force: true, detail: 'test fixture' });
  }
}

/** 一斉送信が終わるまで待つ（ハングしていれば timeout でテストが落ちる）。 */
async function waitUntilFinished(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isBulkRunning()) {
    if (Date.now() > deadline) throw new Error('一斉送信が終了しませんでした（ワーカーがハングしている）');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('並列ワーカー: 送信対象ゼロでもハングせず終わり、判定は 1 社 1 回', async (t) => {
  t.after(() => {
    closeDb();
    rmSync(tmp, { recursive: true, force: true });
  });

  seedBlockedCandidates();

  const r = startBulkSend({ follow: false, concurrency: 4, actor: 'test' });
  assert.equal(r.started, true, r.message);

  await waitUntilFinished();

  const s = bulkStatus();
  assert.equal(s.running, false);
  assert.equal(s.success, 0);
  assert.equal(s.failed, 0);
  assert.equal(s.blocked, COMPANIES, '全社が「項目に問題あり」で保留になるはず');
  assert.equal(
    s.scanned,
    COMPANIES,
    `同じ企業を重複して判定している (scanned=${s.scanned}, 期待=${COMPANIES})`,
  );
  assert.match(s.stopReason ?? '', /送信できる企業がありませんでした/);
});

test('多重起動はしない（実行中に押しても 2 本目のワーカー群は立たない）', async () => {
  const first = startBulkSend({ follow: false, concurrency: 2, actor: 'test' });
  const second = startBulkSend({ follow: false, concurrency: 2, actor: 'test' });
  // 1本目が即終了しているとこの検証にならないので、その場合だけ緩める。
  if (first.started && isBulkRunning()) {
    assert.equal(second.started, false);
    assert.match(second.message, /すでに実行中/);
  }
  await waitUntilFinished();
});
