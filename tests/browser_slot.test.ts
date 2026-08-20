import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { withBrowserSlot, browserSlotStats } from '../src/browser/browser.js';

/**
 * ブラウザ枠のテスト。
 *
 * 取り込み（L1発見/L2解析）と一斉送信（L4）が並走するようになったので、
 * 同時に起きている Chromium プロセス数はレイヤごとの並列数ではなく
 * この枠が決める。上限が守られないと 3万件の後半でメモリを踏み抜く。
 */

/** 呼ばれたら解決できる Deferred。テスト側が終了タイミングを完全に握る。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** マイクロタスクを十分に流して、待機側が起きる猶予を与える。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}

test('withBrowserSlot: 上限を超えて同時に走らない', async () => {
  const original = config.browserConcurrency;
  config.browserConcurrency = 2;
  try {
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const runs = gates.map((g) =>
      withBrowserSlot(async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      }),
    );

    await settle();
    assert.equal(running, 2, '上限 2 を超えて起動している');
    assert.equal(browserSlotStats().waiting, 2);

    // 1つ解放するたびに待機中の1つだけが起きる。
    gates[0].resolve();
    await settle();
    assert.equal(running, 2);
    assert.equal(browserSlotStats().waiting, 1);

    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all(runs);

    assert.equal(peak, 2, `同時実行のピークが上限を超えた (peak=${peak})`);
    assert.deepEqual(browserSlotStats(), { inFlight: 0, waiting: 0, max: 2 });
  } finally {
    config.browserConcurrency = original;
  }
});

test('withBrowserSlot: priority は待ち行列を追い越す（送信を発見処理の後ろに並ばせない）', async () => {
  const original = config.browserConcurrency;
  config.browserConcurrency = 1;
  try {
    const hold = deferred();
    const order: string[] = [];

    // 枠を1つ占有する（取り込み側の発見処理に相当）。
    const busy = withBrowserSlot(async () => { order.push('occupant'); await hold.promise; });
    await settle();

    // 通常優先度で3つ並ばせたあとに、送信 (priority) を投入する。
    const queued = [
      withBrowserSlot(async () => { order.push('discover-1'); }),
      withBrowserSlot(async () => { order.push('discover-2'); }),
      withBrowserSlot(async () => { order.push('discover-3'); }),
    ];
    await settle();
    const send = withBrowserSlot(async () => { order.push('send'); }, { priority: true });
    await settle();

    hold.resolve();
    await Promise.all([busy, send, ...queued]);

    assert.equal(order[0], 'occupant');
    assert.equal(order[1], 'send', `送信が先頭に入らなかった: ${order.join(' → ')}`);
    assert.deepEqual(order.slice(2), ['discover-1', 'discover-2', 'discover-3']);
  } finally {
    config.browserConcurrency = original;
  }
});

test('withBrowserSlot: 優先どうしは投入順を保つ', async () => {
  const original = config.browserConcurrency;
  config.browserConcurrency = 1;
  try {
    const hold = deferred();
    const order: string[] = [];

    const busy = withBrowserSlot(async () => { await hold.promise; });
    await settle();

    const normal = withBrowserSlot(async () => { order.push('normal'); });
    const p1 = withBrowserSlot(async () => { order.push('p1'); }, { priority: true });
    const p2 = withBrowserSlot(async () => { order.push('p2'); }, { priority: true });
    await settle();

    hold.resolve();
    await Promise.all([busy, normal, p1, p2]);

    assert.deepEqual(order, ['p1', 'p2', 'normal']);
  } finally {
    config.browserConcurrency = original;
  }
});

test('withBrowserSlot: fn が throw しても枠が漏れない', async () => {
  const original = config.browserConcurrency;
  config.browserConcurrency = 1;
  try {
    await assert.rejects(
      withBrowserSlot(async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.deepEqual(browserSlotStats(), { inFlight: 0, waiting: 0, max: 1 });

    // 枠が漏れていれば、この呼び出しは永久に待たされる。
    let ran = false;
    await withBrowserSlot(async () => { ran = true; });
    assert.equal(ran, true);
  } finally {
    config.browserConcurrency = original;
  }
});
