/**
 * 中断要求に即応できる待機。
 *
 * 長時間ワーカー（一斉送信の送信間隔、取り込みパイプラインの供給待ち）で
 * `setTimeout(ms)` を一発で張ると、「■ 中断」を押してから最大 ms 秒
 * 反応しない。500ms 刻みに割って、その都度 `abort()` を確認する。
 */
export async function sleepInterruptible(
  ms: number,
  abort: () => boolean,
  step = 500,
): Promise<void> {
  for (let waited = 0; waited < ms; waited += step) {
    if (abort()) return;
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
}
