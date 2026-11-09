import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, config } from '../src/config.js';

// DB を開く前に差し替える。
config.dbPath = join(mkdtempSync(join(tmpdir(), 'learning-')), 'test.db');

const { db } = await import('../src/db/db.js');
const { companies, outcomes } = await import('../src/db/repositories.js');
const { learn, collectStats, currentWeights, resetLearningCache, estimate } = await import(
  '../src/pipeline/learning.js'
);
const { activeVariants, setVariantStatus } = await import('../src/pipeline/variants.js');
const { pickByWeights } = await import('../src/pipeline/experiment.js');
const { validateChallenger } = await import('../src/pipeline/challenger.js');
const { clearTemplateCache } = await import('../src/layers/l3_content.js');

/**
 * 文面の学習ループ。
 *
 * 確かめたいのは「送るたびに結果が配分に返ってくるか」と、その過程で
 * 実在の相手に害のある判断をしないか（早とちりで固まる・最後の文面まで
 * 止める・返信待ちの文面を不当に負けにする・根拠の無い数字を書いた文面を通す）。
 */

let seq = 0;
function reset(): void {
  const d = db();
  d.exec('DELETE FROM outcomes; DELETE FROM submissions; DELETE FROM learning_rounds; DELETE FROM variant_state;');
  resetLearningCache();
}

/** variant で n 社に送った（daysAgo 日前）ことにし、先頭 k 社に kind の反応を付ける。 */
function seed(variant: string, n: number, daysAgo: number, reactions: { kind: any; k: number }[] = []): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = companies.upsert({ name: `学習テスト${++seq}`, domain: `learn${seq}.test` });
    const sub = db()
      .prepare(
        `INSERT INTO submissions (company_id, status, submitted_at, variant)
         VALUES (?, 'submitted_success', datetime('now', ?), ?)`,
      )
      .run(c.id, `-${daysAgo} days`, variant);
    ids.push(Number(sub.lastInsertRowid));
    let offset = 0;
    for (const r of reactions) {
      if (i >= offset && i < offset + r.k) {
        outcomes.record({ companyId: c.id, submissionId: Number(sub.lastInsertRowid), kind: r.kind });
      }
      offset += r.k;
    }
  }
  return ids;
}

test('データが無いうちは均等に配る', () => {
  reset();
  const w = currentWeights();
  const names = activeVariants().map((v) => v.name);
  for (const n of names) assert.ok(Math.abs(w[n] - 1 / names.length) < 1e-9, `${n}: ${w[n]}`);
});

test('アポが多い文面ほど次の配分が増える', () => {
  reset();
  seed('default', 150, 30, [{ kind: 'appointment', k: 1 }]);
  seed('short', 150, 30, [{ kind: 'appointment', k: 8 }]);
  const round = learn();
  const short = round.arms.find((a) => a.name === 'short')!;
  const dflt = round.arms.find((a) => a.name === 'default')!;
  assert.ok(short.pBest > 0.9, `short の最良確率が低い: ${short.pBest}`);
  assert.ok(round.weights.short > 0.7, `配分が勝ち側に寄っていない: ${JSON.stringify(round.weights)}`);
  // 負けている側にも探索のための最低配分は残る。
  assert.ok(round.weights.default >= 0.09, `最低配分が残っていない: ${round.weights.default}`);
  assert.ok(dflt.rate < short.rate);
});

test('送ったばかりの未反応は「反応なし」と確定させない（新しい文面を不当に負けにしない）', () => {
  reset();
  seed('default', 100, 1);
  const s = collectStats().get('default')!;
  assert.equal(s.delivered, 100);
  assert.ok(s.exposure < 100 * (2 / 14), `返信待ちが割り引かれていない: ${s.exposure}`);
  seed('short', 100, 60);
  assert.equal(collectStats().get('short')!.exposure, 100);
});

test('前向きな返信は成果に入るが、お断りは成果に入らない', () => {
  reset();
  seed('default', 10, 30, [
    { kind: 'reply', k: 2 },
    { kind: 'refusal', k: 3 },
  ]);
  const s = collectStats().get('default')!;
  assert.equal(s.positiveReplies, 2);
  assert.equal(s.refusals, 3);
  assert.equal(s.complaints, 3);
  assert.ok(Math.abs(s.reward - 2 * 0.3) < 1e-9);
});

test('届いていない送信（bounce）は文面の評価から外す', () => {
  reset();
  seed('default', 10, 30, [{ kind: 'bounce', k: 4 }]);
  const s = collectStats().get('default')!;
  assert.equal(s.delivered, 6);
  assert.equal(s.bounces, 4);
});

test('十分な数で明らかに負けた文面は自動で引退し、配信から外れる', () => {
  reset();
  seed('default', 400, 30, [{ kind: 'appointment', k: 0 }]);
  seed('short', 400, 30, [{ kind: 'appointment', k: 12 }]);
  const round = learn();
  assert.ok(round.actions.some((a) => a.kind === 'retire' && a.variant === 'default'), JSON.stringify(round.actions));
  assert.deepEqual(
    activeVariants().map((v) => v.name),
    ['short'],
  );
  assert.equal(round.weights.short, 1);
  // 比較相手が居なくなったので、次の挑戦者を作るよう促す。
  assert.ok(round.actions.some((a) => a.kind === 'suggest'));
});

test('最後の 1 本は引退させない（配信する文面が無くならない）', () => {
  reset();
  setVariantStatus('short', 'retired', 'test', 'human');
  seed('default', 500, 30);
  const round = learn();
  assert.ok(!round.actions.some((a) => a.kind === 'retire'));
  assert.deepEqual(
    activeVariants().map((v) => v.name),
    ['default'],
  );
});

test('お断り・配信停止が突出した文面は止める（返信率だけ上げる煽り文面を勝たせない）', () => {
  reset();
  seed('default', 200, 30, [
    { kind: 'reply', k: 4 },
    { kind: 'optout', k: 4 },
  ]);
  seed('short', 200, 30, [
    { kind: 'reply', k: 6 },
    { kind: 'optout', k: 40 },
  ]);
  const round = learn();
  assert.ok(round.actions.some((a) => a.kind === 'pause' && a.variant === 'short'), JSON.stringify(round.actions));
});

test('--dry-run 相当（apply:false）は状態も記録も変えない', () => {
  reset();
  seed('default', 400, 30);
  seed('short', 400, 30, [{ kind: 'appointment', k: 12 }]);
  learn({ apply: false });
  assert.equal(activeVariants().length, 2);
  assert.equal(Number((db().prepare('SELECT COUNT(*) n FROM learning_rounds').get() as any).n), 0);
});

test('新しい反応が入ると次の割り当てから配分が変わる（実行するたびに学習が効く）', () => {
  reset();
  const ids = seed('short', 120, 30);
  seed('default', 120, 30);
  const before = currentWeights();
  // 反応を記録 → キャッシュを捨てれば（実運用では 1 分後に）学習し直される。
  const companyId = (db().prepare('SELECT company_id FROM submissions WHERE id = ?').get(ids[0]) as any).company_id;
  for (const id of ids.slice(0, 6)) {
    const cid = (db().prepare('SELECT company_id FROM submissions WHERE id = ?').get(id) as any).company_id;
    outcomes.record({ companyId: cid, submissionId: id, kind: 'appointment' });
  }
  assert.ok(companyId);
  resetLearningCache();
  const after = currentWeights();
  assert.ok(after.short > before.short + 0.2, `配分が動いていない: ${before.short} → ${after.short}`);
  const rounds = Number((db().prepare('SELECT COUNT(*) n FROM learning_rounds').get() as any).n);
  assert.equal(rounds, 2);
});

test('同じデータからは同じ配分（再実行で割り当てが揺れない）', () => {
  const arms = [
    { name: 'a', delivered: 100, exposure: 100, appointments: 2, positiveReplies: 1, refusals: 0, optouts: 0, bounces: 0, reward: 2.3, complaints: 0 },
    { name: 'b', delivered: 100, exposure: 100, appointments: 3, positiveReplies: 0, refusals: 0, optouts: 0, bounces: 0, reward: 3, complaints: 0 },
  ];
  assert.deepEqual(
    estimate(arms, 42).map((x) => x.share),
    estimate(arms, 42).map((x) => x.share),
  );
});

test('配分どおりに企業が割れ、同じ企業はいつも同じ文面になる', () => {
  const active = activeVariants().length >= 2 ? activeVariants() : [
    { name: 'default', template: 'mochica_default', hypothesis: '', status: 'active' as const },
    { name: 'short', template: 'mochica_short', hypothesis: '', status: 'active' as const },
  ];
  const weights = { [active[0].name]: 0.2, [active[1].name]: 0.8 };
  let second = 0;
  for (let id = 1; id <= 5000; id++) if (pickByWeights(id, active, weights).name === active[1].name) second++;
  assert.ok(Math.abs(second / 5000 - 0.8) < 0.03, `配分どおりに割れていない: ${second / 5000}`);
  for (const id of [3, 99, 12345]) {
    assert.equal(pickByWeights(id, active, weights).name, pickByWeights(id, active, weights).name);
  }
});

/* ------------------------------ 挑戦者文面の検証 ------------------------------ */

const TPL_DIR = resolve(ROOT, 'config/templates');
const parentRaw = readFileSync(join(TPL_DIR, 'mochica_short.md'), 'utf8');

function withTemplate(raw: string, fn: (name: string) => void): void {
  const name = `__test_challenger_${process.pid}`;
  const path = join(TPL_DIR, `${name}.md`);
  writeFileSync(path, raw, 'utf8');
  clearTemplateCache();
  try {
    fn(name);
  } finally {
    unlinkSync(path);
    clearTemplateCache();
  }
}

test('挑戦者文面: 親と同じ条件を満たすものは通す', () => {
  const raw = parentRaw.replace('突然のご連絡失礼いたします。', '新卒採用のご担当者様に、一点だけご相談がありご連絡しました。');
  withTemplate(raw, (name) => {
    const problems = validateChallenger(name, parentRaw, raw).filter(
      // .env が無い環境では送信者情報が空なので、身元の点検は対象外にする。
      (p) => !/社名が無い|返信先が無い/.test(p),
    );
    assert.deepEqual(problems, []);
  });
});

test('挑戦者文面: 親に無い数字（根拠の無い実績）を書いたら通さない', () => {
  const raw = parentRaw.replace('{{reason}}', '{{reason}}\n導入企業は 1200 社を超え、辞退率が 45% 改善しています。');
  withTemplate(raw, (name) => {
    const problems = validateChallenger(name, parentRaw, raw);
    assert.ok(problems.some((p) => p.includes('親に無い数字')), problems.join(' / '));
  });
});

test('挑戦者文面: 配信停止の案内や宛先・日程調整ブロックを落としたら通さない', () => {
  const raw = parentRaw
    .replace('ご不要でしたらその旨ご返信ください。以後お送りいたしません。', '')
    .replace('{{company}}', '')
    .replace('<!--if:bookingUrl-->', '');
  withTemplate(raw, (name) => {
    const problems = validateChallenger(name, parentRaw, raw).join(' / ');
    assert.ok(problems.includes('配信停止の案内が無い'), problems);
    assert.ok(problems.includes('{{company}} が無い'), problems);
    assert.ok(problems.includes('日程調整リンクの条件ブロック'), problems);
  });
});

test('挑戦者文面: 存在しない変数を作ったら通さない', () => {
  const raw = parentRaw.replace('{{reason}}', '{{reason}}{{discount}}');
  withTemplate(raw, (name) => {
    assert.ok(validateChallenger(name, parentRaw, raw).some((p) => p.includes('未知の変数')));
  });
});
