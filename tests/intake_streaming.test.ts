import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';

// DB を開く前に差し替える。db() は最初の呼び出し時に config.dbPath を読む。
const tmp = mkdtempSync(join(tmpdir(), 'intake-stream-'));
config.dbPath = join(tmp, 'test.db');
// 1行 = 1チャンクにして、取り込みループが行ごとにイベントループを手放すようにする。
// 並走しているかどうかは、この譲り合いの隙間でパイプラインが動くかで決まる。
config.intake.chunkSize = 1;
config.intake.concurrency = 4;

const { closeDb } = await import('../src/db/db.js');
const { companies, importRows } = await import('../src/db/repositories.js');
const { transition } = await import('../src/core/stateMachine.js');
const { startIntake, intakeStatus, stopIntake, defaultOptions } = await import(
  '../src/pipeline/intake.js'
);

/**
 * L0 取り込みと L1〜L4 パイプラインの**並走**を検証する。
 *
 * 直列だった頃は、全行を読み終えるまで発見処理が 1 社も走らなかった
 * （3万件のリストでは「読み込み 10,500/29,263・発見処理 0/0」で固まる）。
 * ここで確かめたいのは「まだ読み込み中なのに、もう発見処理が進んでいる」こと。
 *
 * ネットワークには出ない。あらかじめ `SUBMITTED_SUCCESS` の企業を作っておくと、
 * `processOne` は status !== 'NEW' の分岐で即 done にするため、ブラウザも
 * Web 検索も使わずにパイプライン側のキュー消費だけを観測できる。
 */

const ROWS = 60;
const domainOf = (i: number): string => `example${i}.test`;

function seedAlreadyProcessed(): void {
  for (let i = 0; i < ROWS; i++) {
    const c = companies.upsert({ name: `テスト企業${i}`, domain: domainOf(i), icpScore: 0.5 });
    // NEW 以外なら processOne は発見処理をせず done にする（＝ネットワーク不要）。
    transition(c.id, 'SUBMITTED_SUCCESS', { force: true, detail: 'test fixture' });
  }
}

const listText = (): string =>
  ['会社名,URL', ...Array.from({ length: ROWS }, (_, i) => `テスト企業${i},https://${domainOf(i)}`)].join('\n');

test('取り込みと発見処理が並走する（読み込み完了を待たない）', async (t) => {
  t.after(() => {
    closeDb();
    rmSync(tmp, { recursive: true, force: true });
  });

  seedAlreadyProcessed();

  const { parseCompaniesList } = await import('../src/layers/l0_list.js');
  const { rows } = parseCompaniesList(listText());
  assert.equal(rows.length, ROWS);

  const { jobId } = startIntake(rows, {
    ...defaultOptions(),
    resolve: false,
    pipeline: true,
    // 既知の企業を known で弾くと ingested に入らずパイプラインに流れない。
    skipKnown: false,
  });

  // 「まだ pending が残っているのに done が進んでいる」瞬間を捕まえる。
  // 直列実装ではこの状態は原理的に発生しない。
  let overlapped = false;
  let overlapSample = '';
  for (let i = 0; i < 400 && !overlapped; i++) {
    const counts = importRows.countsByState(jobId);
    const pending = counts.pending ?? 0;
    const done = counts.done ?? 0;
    if (pending > 0 && done > 0) {
      overlapped = true;
      overlapSample = `pending=${pending} done=${done}`;
    }
    if ((counts.pending ?? 0) === 0 && (counts.ingested ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.ok(
    overlapped,
    '取り込み中に発見処理が進まなかった（直列に戻っている可能性）',
  );
  t.diagnostic(`並走を観測: ${overlapSample}`);

  // 最後まで走り切ること（待機ループが抜けられずに固まらない）。
  for (let i = 0; i < 600; i++) {
    if (!intakeStatus().running) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const s = intakeStatus();
  assert.equal(s.running, false, '取り込みが終了しなかった');
  assert.equal(s.status, 'done', `想定外の終了状態: ${s.status} / ${s.error ?? ''}`);

  const final = importRows.countsByState(jobId);
  assert.equal(final.pending ?? 0, 0);
  assert.equal(final.ingested ?? 0, 0, 'ingested が残ったまま完了した');
  assert.equal(final.done ?? 0, ROWS);
  assert.equal(s.done, ROWS);
  // 分母が開始時に固定されず、取り込みの進行に合わせて増えていたこと。
  assert.equal(s.pipelineTotal, ROWS, `pipelineTotal が伸びていない: ${s.pipelineTotal}`);

  stopIntake();
});
