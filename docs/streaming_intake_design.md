# 随時処理（ストリーミング取り込み）設計

**目的** — 3万件の取り込み完了を待たずに、読み込めた企業から順に
L1発見 → L2解析 → プラン作成 → 送信 まで流し続ける。

現状: `ingestPhase()` が全29,263行を処理し終えるまで `pipelinePhase()` が
1社も走らない（[intake.ts](../src/pipeline/intake.ts) `worker()` の `await` バリア）。

---

## 1. 全体像

### Before（直列・バリアあり）

```
L0 取り込み  ████████████░░░░░░░░░░░░░░░░  10,500/29,263
L1〜L4       （待機）                        0/0
送信         （待機）                        0
                                    ↑ここが全部終わるまで動かない
```

### After（並走・パイプライン）

```
L0 取り込み  ████████████░░░░░░░░░░░░░░░░  10,500/29,263   ┐
L1〜L4 発見  ████░░░░                       1,240/2,730     ├ 同時に走る
送信         ██                             84 社送信済み   ┘
```

`import_rows.state` がそのままキュー（`pending` → `ingested` → `done`）なので、
**DB スキーマ変更は不要**。2本のループが別々の state を消費するだけ。

```
 pending ──[ingestLoop]──> ingested ──[pipelineLoop]──> done
                        │                            │
                        └─> nodomain/unresolved      └─> error
                            /known/suppressed
                                                companies.status
                                                 = PENDING_APPROVAL
                                                       │
                                                 [bulkSend follow]
                                                       ↓ 送信
```

better-sqlite3 は同期・Node はシングルスレッドなので、2ループが同時に
`tx()` を呼んでも競合しない（await 境界でしか切り替わらない）。

---

## 2. 変更点

### 2.1 `worker()` — バリアを外す（中核）

```ts
async function worker(state: RunState): Promise<void> {
  try {
    // 両フェーズを同時に走らせる。片方が落ちても他方は走り切る。
    const ingest = ingestLoop(state).catch((e) => recordLoopError(state, 'ingest', e));
    const pipeline = state.opts.pipeline
      ? pipelineLoop(state).catch((e) => recordLoopError(state, 'pipeline', e))
      : Promise.resolve();
    await Promise.all([ingest, pipeline]);
    ...
  }
}
```

**片方の例外で全体を落とさない**のが要点。現状は直列なので ingest の例外＝
ジョブ failed で済んでいたが、並走後に「HP探索が死んだせいで、発見処理も
送信も止まる」のは事故になる。`recordLoopError` は該当ループだけを止め、
`counters.errors` と `job.error` に理由を残す。両方死んだときだけ `failed`。

### 2.2 `ingestPhase` → `ingestLoop`

ほぼそのまま。末尾に1行足すだけ。

```ts
  state.collisions = importRows.collisions(state.jobId, 20);
  state.ingestFinished = true;      // ← 追加。pipelineLoop の終了条件
```

### 2.3 `pipelinePhase` → `pipelineLoop`（空バッチで抜けない）

現状は「`ingested` が0件 → `break`（＝完了）」。並走後は「0件」は
*まだ供給されていないだけ* かもしれない。

```ts
    const batch = importRows.nextBatch(state.jobId, 'ingested', chunkSize);
    if (batch.length === 0) {
      // 供給が止まった（＝L0 が全行読み終えた）ときだけ本当に終わり。
      if (state.ingestFinished) break;
      state.current = null;
      state.message = '取り込み待ち — 読み込めた企業から順に処理します';
      lastSeq = -1;                       // 空振り後は spin 判定をリセット
      await sleepInterruptible(state, 1000);
      continue;
    }
```

`sleepInterruptible` は bulkSend の `sleep()` と同じ 500ms 刻みの待機
（「■ 中断」に最大500msで反応する）。共通化して `utils/` に置く。

### 2.4 `pipelineTotal` を動的に

現状は開始時に1回だけ確定（`pipelinePhase` 冒頭）。
並走後は分母が増え続けるので、チャンクごとに取り直す。

```ts
function refreshPipelineTotal(state: RunState): void {
  const c = importRows.countsByState(state.jobId);
  state.counters.pipelineTotal =
    (c.ingested ?? 0) + (c.done ?? 0) + (c.error ?? 0);
}
```

`idx_import_rows_state (job_id, state, seq)` が効くので、数十社ごとに1回なら
3万行でもコストは無視できる。

### 2.5 `phase` の扱い

`'ingest'|'resolve'|'pipeline'|'done'` は「今どちらか一方」を表す型なので、
並走を表現できない。**`phase` は L0 側の状態を持ち続ける**ことにして、
スナップショットに2つの真偽値を足す（型は据え置き＝既存ジョブと互換）。

```ts
export interface IntakeSnapshot extends IntakeCounters {
  ...
  ingestRunning: boolean;     // 追加
  pipelineRunning: boolean;   // 追加
}
```

---

## 3. ブラウザ同時起動数の上限（並走化とセットで必須）

並走させると同時に走るもの:

| 処理 | 使うもの | 既定の並列数 |
|---|---|---|
| HP自動探索 | HTTP のみ（cheerio + fetch） | `INTAKE_RESOLVE_CONCURRENCY=2` |
| L1発見 / L2解析 | **Chromium プロセス** | `INTAKE_CONCURRENCY=3` |
| L4送信（bulkSend） | **Chromium プロセス** | 1 |

`BrowserSession` は毎回 `chromium.launch()` する（[browser.ts:52](../src/browser/browser.ts#L52)）。
つまり **最大4プロセス同時**。HP探索は HTTP なので競合しないが、現在の
`INTAKE_CONCURRENCY=3` は「発見処理だけが走る」前提で決めた値。並走後は
送信の1プロセスが常時上に乗る。

3万件を回すと後半でメモリを踏み抜くので、**グローバルなブラウザ枠**を入れる:

```ts
// src/browser/browser.ts
const MAX = config.browserConcurrency;          // BROWSER_MAX_CONCURRENCY, 既定 4
let inFlight = 0;
const waiters: (() => void)[] = [];

/** ブラウザ枠を1つ確保して fn を実行する。枠が空くまで待つ。 */
export async function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX) await new Promise<void>((r) => waiters.push(r));
  inFlight++;
  try { return await fn(); }
  finally { inFlight--; waiters.shift()?.(); }
}
```

呼び出し側は `BrowserSession` を作る4箇所
（[l1_discovery.ts:163](../src/layers/l1_discovery.ts#L163),
[l2_parsing.ts:200](../src/layers/l2_parsing.ts#L200),
[l4_submit.ts:322](../src/layers/l4_submit.ts#L322),
[l4_submit.ts:375](../src/layers/l4_submit.ts#L375)）を包む。

**送信を待たせないため**、送信だけは枠を優先確保する（`withBrowserSlot(fn, {priority:true})`
で waiters の先頭に積む）。取り込みは何時間走っても構わないが、送信は
送信可能時間帯（9-19時）と日次上限の中でしか動けないため。

---

## 4. 送信までつなぐ

### 4.1 既存の `autoSend` を再開時にも効かせる

`/api/import` の `autoSend` は**新規取り込み時のみ**（[server.ts:87](../src/web/server.ts#L87)）。
再開・サーバ再起動後にも効くよう、`IntakeOptions` に持たせて `options_json` に永続化する。

```ts
export interface IntakeOptions {
  ...
  /** 取り込みと並走して、準備できた企業から自動送信する。 */
  autoSend: boolean;      // 追加
}
```

`launch()` の中で `if (opts.autoSend && opts.pipeline && !isBulkRunning()) startBulkSend({follow:true})`。
これで `resumeIntake()` / `resumeUnfinishedOnBoot()` の経路も自動的に拾う。

### 4.2 bulkSend 側は変更不要

`intakeStillProducing()` は `s.running && s.pipeline` を見ているだけなので、
並走化しても正しく「まだ候補が増える」と判定する。候補が尽きたら
`IDLE_WAIT_MS=5s` 間隔で待ち、取り込み完了とともに自然終了する。

---

## 5. 処理順序（運用上の判断ポイント）

`nextBatch` は `ORDER BY seq ASC` — **リストに貼った順**に発見処理が走る。
一方 bulkSend の候補取得は `icp_score DESC`（[schema.sql](../src/db/schema.sql) の
`idx_companies_status_score`）。

つまり「発見はリスト順、送信はスコア順」。3万件の上位企業がリスト末尾に
いる場合、送信開始が遅れる。ICP上位から先に発見したいなら
`pipelineLoop` の候補取得を companies 側の join に変える:

```sql
SELECT r.* FROM import_rows r
  JOIN companies c ON c.id = r.company_id
 WHERE r.job_id = ? AND r.state = 'ingested'
 ORDER BY c.icp_score DESC, r.seq ASC LIMIT ?
```

**初期実装は seq 順のままを推奨**。リスト順なら「上から順に進む」ことが
画面で追えるし、`WITHOUT ROWID` の主キー順スキャンで済む。スコア順は
join + sort が毎チャンク走るので、必要になってから入れる。

---

## 6. 中断・再開の整合性

| 項目 | 影響 |
|---|---|
| `stopIntake()` | 共有の `stopRequested` を両ループが見るので変更不要 |
| `paused` 保存 | `Promise.all` の後なので現状のまま正しい |
| `resumeUnfinishedOnBoot()` | `remaining = pending + ingested` を既に計算済み — 変更不要 |
| `checkpoint()` の同時呼び出し | `counters` は共有オブジェクト、`tx` は同期 → 破損しない |
| DB マイグレーション | **不要**（`import_rows.state` をそのまま使う） |

進行中のジョブ #1（pending 18,763 / ingested 2,730）は、新コードで再開すると
**その場で 2,730 社の発見処理が始まり**、同時に残り 18,763 行の HP探索も続く。

---

## 7. ダッシュボード

`renderIntake()` の進捗バーは今 1本で、`s.phase === 'pipeline'` かどうかで
分母を切り替えている（[dashboard.html:836](../src/web/dashboard.html#L836)）。
並走後は**2本**にする。

```
L0 読み込み   ████████░░░░░░░░  10,500/29,263   HP探索中: ○○株式会社
発見処理      ███░░░░░░░░░░░░░   1,240/2,730    #4821 △△工業 を解析中
送信          84 社送信済み / 承認待ち 156 社
```

見出しは `PHASE[s.phase]` 単独をやめ、`ingestRunning` / `pipelineRunning` から
「HP探索＋フォーム発見を並行実行中」のように組み立てる。

---

## 8. 実装結果（完了）

| # | 内容 | 主な変更先 |
|---|---|---|
| 1 | `sleepInterruptible` を共通化 | `src/utils/sleep.ts`（新規）/ `bulkSend.ts` |
| 2 | ブラウザ枠（上限 + 優先枠） | `browser.ts` / `config.ts` / L1,L2,L4 の 4 呼び出し |
| 3 | `worker()` 並走化・ループ別エラー隔離 | `intake.ts` |
| 4 | `pipelineTotal` 動的化・スナップショット拡張 | `intake.ts` |
| 5 | 進捗バー 2 本化 | `dashboard.html` |
| 6 | `autoSend` をジョブに永続化 | `intake.ts` / `server.ts` / `repositories.ts` / `index.ts` |

### 実装中に追加で必要になった手当て

- **`state.phase` の共有**— 設計時に見落としていたが、`pipelineLoop` が
  `phase='pipeline'` を書くと並走中の `ingestLoop` の `'resolve'` を踏み潰す。
  `phase` は L0 専用とし、L0 が読み終わった時点で `ingestLoop` 自身が
  `'pipeline'` へ進める。
- **`import_jobs.error` が消えない** — `save()` は `COALESCE(@error, error)` なので
  `null` ではクリアできない。部分失敗を `error` に記録するようになった結果、
  再開してもダッシュボードの赤い失敗表示が残る。`clearError` フラグを追加し、
  `launch()` で毎回消す。

## 9. 検証結果

- `tests/intake_streaming.test.ts`（新規）— ネットワークに出ずに並走を確認する。
  あらかじめ `SUBMITTED_SUCCESS` の企業を仕込むと `processOne` は
  `status !== 'NEW'` の分岐で即 done にするので、ブラウザも Web 検索も使わずに
  キュー消費だけを見られる。`pending > 0 && done > 0` の瞬間を捕まえる。
  → **`pending=59 done=1` を観測**（1 行目を読んだ直後にもう発見処理が動いている）。
  旧コードではこのテストは失敗する（回帰ガードとして確認済み）。
- `tests/browser_slot.test.ts`（新規）— 上限厳守・優先枠の追い越し・
  優先どうしの順序保持・例外時の枠リークなし。4 件とも pass。
- 全体: `tsc --noEmit` はクリーン。`tests/*.test.ts` は 73 件中 71 pass。
  残り 2 件（undici バージョンチェック / maxlength の本文縮約）は**変更前から失敗**している。

### 未実施（実データでの確認）

ジョブ #1（pending 18,763 / ingested 2,730）の再開は実行していない。
実行中のサーバと DB を争うため、サーバを一度落としてから起動すると
自動で続きから再開される（`resumeUnfinishedOnBoot`）。
