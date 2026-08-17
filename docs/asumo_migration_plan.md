# フォーム送信機構 ASUMO 移植 計画書

**改訂**: rev.4（第2回レビュー N1–N13 反映）
**移植元**: `toiawase_form_sales_auto_system`（Node CLI + Express / 7,703行）
**移植先**: ASUMO（Next.js 16 / Drizzle + better-sqlite3 / Fly.io shared-cpu-1x 1GB）

> **改訂履歴**
> - **rev.1** — ASUMO 内で Playwright を動かす前提。**誤り**（B1）。
> - **rev.2** — ブラウザ層をワーカーへ分離。`utils/http.ts` をワーカーへ移すとしたのは**誤り**（F4）。
> - **rev.3** — B1–B3 / W1–W3 / F1–F8 反映。ただし `markSent` を `sf_exclusions` へ移したのは
>   **誤り**。W2（営業お断り検知の登録先）の話を送信済み台帳まで拡張した結果、
>   **C6 が routine な CSV 取込で無音で壊れる**構造になっていた（N1）。
> - **rev.4（本版）** — N1 を rev.1 の判断へ差し戻し。Phase A を具体化、Phase 5 を 5a/5b に分割、
>   ASUMO 固有の関門（§8）と「門番」列（§9）を新設。
>
> 本計画書の作成者は ASUMO リポジトリを直接読んでいない。file:line はすべてレビューの記載を
> 確定事実として受け入れている。

---

## 0. 一行要約

**判断・データ・画面・Web 取得は ASUMO に、ブラウザ操作だけを手元PC側ワーカーに**置く。
C1（Plan はセッションを保持しない）により、解析・Plan・Execute はもともと独立した 3 セッションであり、
その境目にプロセス境界を置く追加コストはゼロである。

**D1（ASUMO が送信主体になってよいか）が未決でも、11〜15日ぶんの作業が動く**：
Phase A（フォーム URL 精度）→ Phase 1（純ロジック）→ Phase 5a（確認 UI）。
どれも「担当者が手で送る」現行フローのまま価値が出る（N7）。

| 分類 | 行数 | 割合 |
|---|---:|---:|
| ASUMO へ（純ロジック・無改造） | 約 2,340 | 30% |
| ワーカーへ | 約 1,150 | 15% |
| 書き換え | 約 1,230 | 16% |
| 作り直し | 約 1,730 | 22% |
| 移植しない | 約 1,410 | 17% |

---

## 1. 前提：ASUMO 本番に Chromium は載らない（B1）

| 事実 | 出典 |
|---|---|
| 「Fly の shared-cpu-1x / 1GB に Chromium は載らない。JS でしか出ない情報は asumo では取らない」 | `lib/fetchx/polite.ts:15` |
| 同旨 | `lib/prospect/observe.ts:9` |
| **同じ形の移植で既に一度この判断をしている** | `docs/リスト作成機能_移植_20260811.md:101` |
| `shared-cpu-1x` / `memory = "1gb"` / `auto_stop_machines = "suspend"` / `min_machines_running = 0` | `fly.toml` |
| `node:22-slim` に `python3 make g++` のみ。Chromium も `playwright install` も無い（+500MB〜1GB） | `Dockerfile` |

`auto_stop_machines = "suspend"` / `min_machines_running = 0` は **HTTP リクエストが無ければマシンが止まる**
という意味であり、rev.1 の「3時間毎」「30分毎」の自律ジョブは起きる保証がない。

**帰結：ワーカーが引きに来る（pull）。** ブラウザは 1GB 制約の外で動き、ワーカーの HTTP 要求そのものが
Fly マシンを起こすので ASUMO 側にスケジューラが要らない。

---

## 2. プロセス境界

境界は「ブラウザが要るか」で引く。**判断も Web 取得もワーカーに渡さない。**

```
┌─ ASUMO (Fly) ─────────────────────────┐      ┌─ ワーカー (手元PC) ──────────────┐
│  項目→ロール マッピング (mapFields)   │      │  ブラウザセッション              │
│  ゲート判定 / 適格性判定              │      │  DOM 抽出 (extract)              │
│  文面生成 / 署名 / 値解決             │ HTTP │  打鍵・クリック・スクショ        │
│  カバレッジ予測 / 結果判定            │◀────▶│  L1 の描画フォールバックのみ     │
│  抑制・ペーシング・承認・権限         │      │                                  │
│  ★ 全ての Web 取得 (polite)           │      │  ※ 判断も静的取得もしない        │
│  ★ L1 の静的段階                      │      │                                  │
└───────────────────────────────────────┘      └──────────────────────────────────┘
```

> `lib/fetchx/polite.ts:4` — 「★ **全てのWeb取得はここを通す。** poc で合法性と安定性を担保していたのは
> この1点で、**迂回する取得コードを1本でも書いた時点で設計が崩れる**」

- **L1 の静的 3 段階は ASUMO 側で `polite()` の上に書き直す**
- **`utils/http.ts` は移植しない。** ワーカー側に第二の取得経路を作らない（F4）
- ワーカーが開くのは **ASUMO が polite で収集して渡した候補 URL** のみ

**ワーカーは値を作らない。** 渡された文字列を打つだけ。これが C4（プレビュー == 実際に入る値）を
構造的に保証する — 文面描画と値解決が ASUMO 側にしか存在しないため。

---

## 3. 移植対象の棚卸し

### 3-1. ASUMO へ（純ロジック・無改造）— 約 2,340行

`types.ts` 179 ／ `mapFields` 部 約190 ／ `l2_dictionary.ts` 184 ／ `l2_split.ts` 366 ／
`l2_choice.ts` 155 ／ `l3_content.ts` 401 ／ `l3_personalize.ts` 172 ／ `fillPolicy.ts` 81 ／
`coverage.ts` 200 ／ `gate.ts` 109 ／ `eligibility.ts` 102 ／ `l5_result.ts` 判定部 約80 ／
`detectNoSalesPolicy` 約25 ／ `url.ts` + `splitAddress` 約70。

配置は `lib/formsend/`。**他モジュールを import しない**制約を lint で固定（`lib/icp` / `lib/fetchx` と同じ作法）。
例外は `polite()`・`isSuppressed`・`setStatus`・`toUserMessage`・`idempotencyKey` のみ。

`judge.ts` は `Page` 依存を外し `{ finalUrl, visibleText, formCount, beforeUrl, captchaPresent }` を
受ける純関数にする（判定ロジックは変えない）。

### 3-2. ワーカーへ — 約 1,150行

| 現行ファイル | 行数 | 備考 |
|---|---:|---|
| `browser/browser.ts` | 111 | セッション・人間らしい打鍵・決定論的ジッタ |
| `browser/extract.ts` | 282 | DOM 抽出。**ハニーポット判定・必須バッジ検知はここ**（C5 の実装点） |
| `l4_submit.ts` | 423 | 入力・確認クリック・最終送信の機構 |
| `l1_discovery.ts` の `browserConfirm` 部 | 約50 | 描画フォールバックのみ |
| `crash_guard.ts` + `logger.ts` | 83 | Playwright 由来の非同期例外対策 |
| （新規）ポーラ + クライアント | 約200 | 作業取得・結果返却・リトライ・バックオフ |

### 3-3. 書き換え — 約 1,230行

`l1_discovery.ts` 静的段階 約190（**`polite()` 化・§10 Phase A**）／ `config.ts` 164（D4）／
`db/*` 294（Drizzle）／ `stateMachine.ts` 58（`setStatus` 経由）／ `compliance.ts` 54→約5 ／
`pacing.ts` 46 ／ `pipeline.ts` 268 ／ `approval.ts` 118（`authz` 経由）／ `l2_llm.ts` 87（`gemini.ts`）。

### 3-4. 作り直し / 移植しない

**作り直し 約1,730行**: `web/server.ts` 557 ／ `dashboard.html` 754 ／ `review.ts` 109 ／ `index.ts` 313。

**移植しない 約1,410行**: `l0_list.ts` 440 ／ `l0_homepage.ts` 347 ／ `l0_autodiscovery.ts` 192 ／
`websearch.ts` 169 ／ `l6_record.ts` 76 ／ `l6_sheets.ts` 94 ／ `config/icp.json` ／ `utils/http.ts` 89（F4）。

---

## 4. データ層

### 4-1. 列名は `company_id`（B3・確定）

| 事実 | 出典 |
|---|---|
| `columnsOf(name).includes("company_id")` の総当たり | `tests/company-reset.test.ts:214` |
| `customers.companyId = text("company_id")`（`K000001`）。**全 70 テーブルがこの命名** | `lib/db/schema.ts:7` |
| 「足し忘れは company_id 列の総当たりで検出する」 | `lib/company-reset.ts:88` |

`customer_id` で作ると**検出網にかからないまま消し漏れが通る — テストは緑のまま**。

### 4-2. テーブル

| 現行 | ASUMO |
|---|---|
| `companies` | **作らない**。`customers` が正（`company_identity_keys` の名寄せ込み） |
| `field_maps` | `form_schemas`（`company_id`, `schema_json`, `gate`, `mapping_confidence`, `has_captcha`, `has_confirm_screen`） |
| `submissions` | `form_submissions`（`company_id`, `content_rendered`, `plan_screenshot_key`, `status`, `approved_by/at`, `submitted_at`, `result_detail`） |
| `content_overrides` | `form_content_overrides`（`company_id` PK） |
| `suppression` | **読みは `sf_exclusions`（`isSuppressed`）／ 書きは下記 2 表**（§5・N1） |
| `send_ledger` | **`form_send_ledger`（`company_id`, `day`, `sent_at`）— C6 の担保。移植する** |
| `audit_log` | `op_logs` + `board_events` |
| （新規） | `form_targets`（`company_id` PK, `form_url`, `form_confidence`, `status`, `lease_token`, `leased_until`） |

- 全 `form_*` を `lib/company-reset.ts` の `TARGETS` に登録する
- **`sf_exclusions` は TARGETS に入れない**（`lib/company-reset.ts:9`：法務リスクの最終防衛線）
- `schema_json` は text 保持。Postgres 移行時に jsonb へ移せるよう、生 SQL で JSON 演算子を使わない

**`form_targets.status`** は現行の状態機械を移植したもの。rev.4 で 1 状態を追加する：

| 状態 | 意味 | 画面での扱い |
|---|---|---|
| `FORM_NOT_FOUND` | 探したが問い合わせフォームが無い | 対象外 |
| **`BLOCKED_BY_ROBOTS`**（新規・N5） | robots.txt が自動取得を拒否 | **「自動では取得しない／手送りは可」と表示** |

`politeGet` は `{ blocked: true, reason }` を返す（`lib/fetchx/polite.ts:42`）。これを `FORM_NOT_FOUND` に
落としてはいけない。**robots は自動取得についての意思表示**なので、担当者が手で開いて送るのは可であり、
同一視するとその企業は手送りの対象にも二度と出てこなくなる。
`SCRAPE_IGNORE_ROBOTS=1` という逃がし口があるが**使わない** — 設計の意図はそこではない。

### 4-3. ドメインは列ではなく `url` から導出（F3）

`customers` にドメイン列は無い。`lib/db/schema.ts:9` の `url` が 1 本だけで、
`lib/normalize.ts` の `urlDomain(url)` で導出するのが既定の作法（`sf-exclusion` がそう使っている）。
`l0_homepage.ts` を戻すかは「`url` が空の企業の割合」だけで決まり、**SQL 1 本で出る**。

### 4-4. 工程 4 は既存。`dealNo` と `setStatus` 経由が必須（F6）

| 事実 | 出典 |
|---|---|
| `{ no: 4, key: "STEP04_FORM", label: "工程4:フォーム送信" }`、`STEP.FORM = 4` | `lib/constants.ts:25` |
| `board_steps` は **(companyId, dealNo, stepNo) で一意**。1社N商談で18工程がNセット並ぶ | `lib/db/schema.ts:212` |
| 既存 `clientOutreachMarkFormSent` は `setStatus(companyId, STEP.FORM, DONE)` を呼ぶだけ | `outreach.impl.ts:688` |

> 進行ボードの状態変更は `board_events` に 1 行残り、取り消しは `undone_at` を刻む設計で、
> **機械が自動で進めた工程を人が戻せること**が既存の要件。engine から直接 UPDATE するとこの経路が抜ける。

### 4-5. Plan スクショの保持期間と総量上限（F5）

本番の書き込み先は Fly volume（`DB_PATH=/data/data.db`）で DB とスクレイプキャッシュが同居する。
フルページ PNG は 1 枚 200KB〜1MB。**2,000社で volume が飽和し、DB の書き込みが失敗＝画面全体が止まる。**

> `lib/fetchx/cache.ts:5` — 「上限が無いとキャッシュが volume を埋め、**DB の書き込みが失敗する**。
> 総量上限と LRU 削除は後付けにしない」

キャッシュが既に 200MB を予約（`SCRAPE_CACHE_MAX_MB` 既定 200）。**総量上限 + 古い順削除**を
Phase 3 の受入条件に入れる。いつ捨てるかは運用判断 → **D3**。

配信は **`app/api/formsend/artifact/[id]`**（認証プロキシ、既存 `app/api/zoom/recording` と同型）。
rev.3 でこの route が Phase 5 成果物から落ちていた（N12）。`plan_screenshot_key` を持つだけでは
画面に出せない。ワーカーがアップロードし ASUMO が認証つきで返す。§8-2 の対象にもなる。

---

## 5. 抑制：読みは統合・書きは engine（N1 で差し戻し）

### 5-1. 読み（`isSuppressed`）— rev.3 のまま正しい

| 事実 | 出典 |
|---|---|
| `SUPPRESSION_CHANNELS = ["all","call","email","dm","form"]` | `lib/sf-exclusion.ts:21` |
| 「架電/メール/DM/フォームの全経路がここを必ず通る」 | `lib/sf-exclusion.ts:202` |
| `dnc` は **hard: true（続行不可）** | `lib/sf-exclusion.ts:32` |
| 経路・期限・解除の回帰テスト 273行が既存 | `tests/suppression-channel.test.ts` |

`preSendCheck` → `isSuppressed({ ...targetFromCustomer(c), channel: "form" })` **のみ**。読み側は実装不要。

### 5-2. 書き（送信済み）— `sf_exclusions` に置いてはいけない（N1）

rev.3 は `markSent` を `sf_exclusions` へ移した。**これが C6 を無音で壊す。**

```
営業が SF の架電禁止リストを CSV で入れ替え取込（kind=dnc / mode=replace）
  ↓
UPDATE sf_exclusions SET released_at = now WHERE kind='dnc' AND released_at IS NULL
  ↓
送信済み 2,000 社の記録が全部「解除済み」になる → isActiveEntry() が false
  ↓
次の execute で全社が再送対象。C6 違反が無音で起きる
```

| 事実 | 出典 |
|---|---|
| `mode=replace` は `where(and(eq(kind, payload.kind), isNull(releasedAt)))`。**channel も出所も見ない** | `lib/actions/exclusion.impl.ts:240` |
| `kind` は `dnc` / `contact` の 2 値。「送信済み」に使える kind が無く、`isKind()` が第三の値を弾く | `lib/db/schema.ts:948` / `exclusion.impl.ts:32` |
| 表の定義そのものが **SF 由来の除外リスト**（旧GAS 2シートの統合）。第三の出所を混ぜる前提が無い | `lib/db/schema.ts:940` |
| `clientExclusionSummary` が `dnc`/`contact` 件数を `/exclusion` に出す。送信済みが DNC 件数に混ざると**法務台帳として読めなくなる** | `lib/actions/exclusion.impl.ts:148` |

**→ C6 は `form_send_ledger` + `form_targets.status` に戻す（rev.1 の判断が正しかった）。**
「フォーム送信済み（＝二度と送らない）」は engine 固有の状態であり、法務台帳に置く概念ではない。

### 5-3. 営業お断り検知（C7）の置き場所 → D5（N2）

同じ `mode=replace` は営業お断り由来の行も `released` にする。表に `source` / `origin` に相当する列が無いため、
**「SF 由来の行だけ入れ替える」が今は表現できない。** 2 案：

| 案 | 内容 | 評価 |
|---|---|---|
| **(a)** 推奨 | `sf_exclusions` に `source` 列を足し、`replace` 取込を `source = 'sf'` に限定 | 変更が小さく、将来どの経路から抑制を足しても同じ事故を防げる（W1 の「全経路がここを必ず通る」設計意図の側に立つ） |
| (b) | 営業お断りは engine 側の表に持ち、`isSuppressed` と併せて 2 本判定 | 法務台帳を触らない。ただし判定が 2 本に分かれ、W1 が防ごうとした「書き忘れ」の余地が戻る |

**法務のクリティカルパスなので、`tests/suppression-channel.test.ts` の原則（止まるはずのものが止まること）を
先にテストで固定してから触る。** どちらを採るかは **D5**。

engine 側に残すのは送信時間帯・日次上限・送信間隔、そして送信済み台帳。

---

## 6. LLM：`lib/gemini.ts` + `schema`（W3）

rev.1 は `lib/external.ts` を指したが、そこは外部連携のスタブ・ファサード（`lib/external.ts:1`）。
実体は `lib/gemini.ts`（Gemini 直接）と `lib/n2i-proxy.ts`（GAS プロキシ）。
`lib/gemini.ts:19` の `GeminiOpts.schema`（`responseSchema`）で構造化 JSON を強制でき「実機確認済み」。

**枠の制約**: Gemini 無料枠 **20 RPM** は `call-transcribe` が既に食っており、AI 機能が黙ってスタブに
落ちる事象が起きている。`aiCapPerRun` 既定は **8/実行**（`lib/jobs/registry.ts`）。
L2 の LLM 補完は 1社あたり最大 1 コール、`aiCapPerRun: 8` を既定とし超過は次回実行へ繰り越す。
失敗・未設定時は**必ずルールのみで続行**。

---

## 7. 承認権限と操作ログ

### 7-1. 「誰の名前で送るか」と「誰が承認してよいか」は別問題（F7）

- `lib/authz.ts` に `manager` / `member`
- 運用方針は「**記録が先、判定は後**」— `AUTH_REQUIRE_LOGIN=1` になるまでは拒否を記録だけする
- **画面右上の担当者切替（`asumo_me` クッキー）はクライアントが自由に書ける値**なので承認者の根拠に使えない

### 7-2. op_logs への本文流出は設計で防ぐ（F8）

`op()` は引数をそのまま記録する。**画面から送るのは `submissionId` だけにし、本文はサーバ側で組み立てる**
設計にすれば構造的に満たされる。`lib/oplog-catalog.ts` の `AREAS` に「メール・フォーム送信」が既にある
（新設不要）。キー命名規則も定義済み：`<ファイル名>.<関数名から client を外したもの>` ／
`page:<パス>` ／ `api:<メソッド> <パス>` ／ `job:<ジョブキー>`。

---

## 8. ASUMO 固有の関門（rev.4 新設・N8〜N12）

`npm test` の 3 本立てのうち、個別に効く関門。**新規アクション・route すべてに効くので受入条件に入れる。**

### 8-1. `catch` で `String(e)` を返すとテストが落ちる（N8）

`tests/action-contract.test.ts` が `lib/actions/*.impl.ts` を構文木で走査し、`error:` に例外の原文を
載せている箇所を落とす。理由は**営業担当の画面に `SqliteError: no such column` がそのまま出るから**。
変換は `lib/errors.ts` の `toUserMessage()` に一本化されている。

→ Phase 2〜5 の受入条件に入れる。

### 8-2. ハンドアウト API は `tests/api-contract.test.ts` に足す（N9）

固定されている契約：

- 壊れた入力で **500 を返さない**（想定内の失敗は 400 / 404 / 413 で表す）
- 失敗しても相手の用は足す
- 応答の型を変えない

**注意点**: `lib/google.ts`（`import "server-only"`）を辿る route は tsx から import できず、
このテストに載せられない（代替は `npm run test:smoke`）。
**ハンドアウト route が `session` / `google` を辿らない設計にしておくと、単体テストで守れる。**
スクショ配信 route（§4-5）も同じ対象。

### 8-3. ワーカー認証：fail-closed の作法と経路の選択（N10）

`lib/auth-token.ts` はセッション cookie の署名専用（`AUTH_SECRET` / TTL 30日）で機械用トークンではない。
**借りるべきは作法**：`authSecret()` は本番で未設定なら空を返し、sign / verify 側で閉じる —
既定鍵にフォールバックすると**既知鍵でセッションを偽造できる**（`:17`）。
ワーカートークンも同じく、**未設定なら受け付けない**（`dev-secret` 相当を作らない）。

経路の選択が要る。`proxy.ts` は全体に BASIC 認証を掛け、公開パスだけ除外している
（`:29` = `/picker` / `/api/auth/callback` / `/api/mail/` / `/api/zoom/webhook`）。

| 案 | 内容 | トレードオフ |
|---|---|---|
| BASIC の内側 | ワーカーが BASIC 資格情報を持つ | 変更が最小。ただし失効管理が BASIC の粒度になる |
| 除外して専用トークン | ハンドアウトパスを `:29` の除外に追加 | 失効管理ができる。**ただし除外に載せた時点でそのパスは社外から到達可能になる** |

→ R3 に選択として明記。どちらを採っても fail-closed は必須。

### 8-4. 冪等性と送信一意性を混ぜない（N11）

`lib/idempotency.ts` の `idempotencyKey(scope, parts)`（TTL 既定 **120秒**、2回目は1回目と同じ結果を返す）は
**ワーカーの結果送信の再送**にはこれが正解。ただし **TTL 120秒はワーカーのバックオフより短くなりえる**。

「二度と送らない」（C6）は別問題で、`form_targets` の CAS と `form_send_ledger` が担う。

| 層 | 守るもの | 部品 |
|---|---|---|
| API 呼び出しの重複 | 同じ結果報告が 2 回届いても 1 回として扱う | `idempotencyKey`（TTL 120秒） |
| 送信の一意性（C6） | 同じ企業へ 2 回送らない | `form_targets` の CAS + `form_send_ledger` |

---

## 9. 壊してはいけない設計制約と「門番」（N13）

rev.3 の表は「実装点」しか書いていなかった。**C1・C2・C5 はワーカー側コードの制約なので
ASUMO の `npm test` では守れない** — 緑でも誰も見ていない状態になりえる。門番列を足す。

| # | 制約 | 実装点 | 門番 |
|---|---|---|---|
| C1 | Plan はセッションを保持しない | ワーカー `finally { session.close() }` | **ワーカー CI** |
| C2 | Plan は最終送信ボタンを押さない | ワーカー。`confirm` 種別のみクリック | **ワーカー CI** |
| C3 | 値を捏造しない | ASUMO。未設定は空 → 適格性で除外 | ASUMO `npm test` |
| C4 | プレビュー == 実際に入る値 | **ASUMO 側にしか値解決が存在しない**（構造的保証） | ASUMO `npm test` |
| C5 | ハニーポットに絶対入力しない | ワーカー `extract.ts` → ASUMO で除外 → ワーカーで二重ガード | **ワーカー CI**（検知）+ ASUMO（除外） |
| C6 | 同一企業へ二度送らない | **`form_send_ledger` + `form_targets` の CAS**（§5-2） | ASUMO `npm test` |
| C7 | 営業お断り表記を尊重する | ASUMO で検知 → 登録先は **D5** | ASUMO `npm test` |
| C8 | 対象外フォームに営業文面を入れない | ASUMO 適格性判定 | ASUMO `npm test` |
| C9 | 本文の途中切れを許さない | ASUMO L3 の段階収縮 | ASUMO `npm test` |

**ワーカー側にも CI を置き、両方の緑を Phase の受入条件にする。** これが一番安い直し方である。

`tests/suppression-channel.test.ts` 冒頭の「守りたいのは1つだけ：**止まるはずのものが止まること**」と
同じ思想であり、そのまま噛み合う。C4 は既存の `/form-outreach` にも今は無い保証である。

---

## 10. 段階計画

### Phase A — `guessFormUrl()` の置き換え（4〜6日・**D1 と独立**）

現行の URL 推測は `lib/actions/outreach.impl.ts:651` の `guessFormUrl()` — 定番パス 5 個のベタ書き。
L1 発見は明確な上位互換で、**担当者が手で送る現行フローのままでも効く**。

rev.3 は「`polite()` の上に書き直す」だけで中身が薄かった。以下を具体化する。

**A-1. `observeCompany()` をなぞる（N3）** — L1 静的とほぼ同型の巡回が `lib/prospect/observe.ts` に既にある。

| なぞる点 | 出典 |
|---|---|
| トップ →（必要なら）会社概要 → 採用ページ の**最大 4 ページで打ち切る**。rev.3 の L1 は候補パス数が無制限だった | `observe.ts:46` |
| 定番パスは `break` で 1 枚打ち切り。相手のサーバに何枚も当てない | `observe.ts:87` |
| 毎 fetch の前に `signal.aborted` を見る（ジョブのタイムアウトで即降りる） | 同 |
| `pagesFetched` を数えて `job_runs.detail` に載せる（滞留の診断が効く） | 同 |
| リンク走査は `findRecruitLinks(topUrl, top.html)` と同型の関数で行う | 同 |

→ **1社あたりのページ予算を数字で決める**：定番パス 3 + リンク走査 1 + sitemap 1 = **最大 5 リクエスト/社**。

**A-2. cheerio は足せない（N4）** — 移植元 L1 のリンク走査は cheerio 前提だが、これは持ち込めない。

> `lib/fetchx/extract.ts:6` — 要るのは `<a href="tel:">` / `<a href>` / 可視テキストの 3 つだけで、
> そのために 1MB 級の DOM パーサを本番イメージへ足す理由が無い

`docs/リスト作成機能_移植_20260811.md:101` の表にも「cheerio 非依存」の行があり、等価性は検証済みと明記。

→ **`lib/fetchx/extract.ts` にフォームリンク版の抽出関数を足す**（`findRecruitLinks` の隣）。
rev.3 の見積 2〜3日はこの分を含んでいなかった。**+1〜2日**。

**A-3. robots 拒否の状態を分ける（N5）** — §4-2 の `BLOCKED_BY_ROBOTS`。

**A-4. スループットを数字で置く（N6）** — 既定値のままでは 1 実行 5〜7社しか回らない。

| 計算 | 出典 |
|---|---|
| `throttle()` は同一ホスト直列 + 取得後に `SCRAPE_DELAY_MS`（既定 **4,000ms**）待ち | `polite.ts:73` |
| 企業をまたいだ処理では各サイトの負荷は増えない。ホストをまたぐ待ちは無い（**企業間は並列可**） | `polite.ts:53` |
| 1社は同一ホストへ 3〜5 リクエスト → 逐次で **15〜25秒/社** | — |
| `JobDef.timeoutMs` 既定 120,000ms → 逐次なら **5〜7社/実行**。`maxPerRun` 既定 50 に届かない | `registry.ts` |

→ 企業をまたいで**小さな固定並列（4〜6）**で回し、`timeoutMs` と `maxPerRun` を実測から明示設定。
**1GB なので `SCRAPE_MAX_BYTES`（2MB）× 並列数がメモリに直接効く。**
`hasWork` は「`form_url` 未設定の企業が居るか」で書ける。

**受入条件**: 現行 `guessFormUrl()` が見つけられなかった企業でフォーム URL が取れることを実データで確認 ／
1社あたりのリクエスト数が予算内 ／ robots 拒否が `BLOCKED_BY_ROBOTS` として分離される ／
`pagesFetched` が `job_runs.detail` に出る ／ 既存の手送りフローが壊れていない ／
`npm test` 3本立て + `docs:sync` + devlog

### Phase 0 — 意思決定（0.5日）

D1〜D5（§12）。

### Phase 1 — 純ロジック層を ASUMO へ（3〜4日・**D1 と独立**）

- `types` / `parse/*` / `content/*` / `fill-policy` / `coverage` / `gate` / `eligibility` / `judge`（純関数化）
- `tests/l2_parsing.test.ts`（33KB・実フォームのキャプチャを replay する**ブラウザ非依存**テスト）を移植。
  **移植の生命線**であり、実企業フォームで積んだ知見の唯一の回帰網

**受入条件**: `npm test`（typecheck + `run-tests.mjs` + `docs:check` の3本すべて）が緑 ／
`lib/formsend/` が他モジュールを import していない（lint 固定）／ devlog に 1 エントリ

### Phase 5a — 確認 UI（4〜5日・**D1 と独立**・N7）

項目別カバレッジ表・Plan スクショ・文面プレビュー・手動編集は **D1 がどちらに転んでも要る**。
担当者が手で送る現行フローのままでも、**C4（プレビュー == 実際に入る値）は今の `/form-outreach` に無い保証**で、
そのまま価値になる。

- カバレッジ表（誤り疑い・未入力の必須・ハニーポット表示）
- Plan スクショの表示と配信 route（§4-5・N12）
- 文面プレビューと手動編集 → 再プレビュー
- server action は `submissionId` だけを受ける（§7-2）。`op()` で包み `oplog-catalog.ts` へ登録
- `catch` は `toUserMessage()` を通す（§8-1）

**受入条件**: `npm test` 3本立てが緑 ／ **C4 の回帰テスト** ／ 手動編集→再プレビューが画面だけで完結 ／
`action-contract` / `api-contract` テストが緑

### Phase 2 — ワーカー + プロトコル（6〜9日・**D1/D2 待ち**）

- ワーカー本体（ブラウザ層・打鍵機構・描画フォールバック）とポーラ
- ハンドアウト API（リース発行・結果受理・トークン認証・冪等性）。
  **`session` / `google` を辿らない設計にする**（§8-2）
- ワーカー認証は fail-closed。経路は D2 と併せて決める（§8-3）
- 結果送信の再送は `idempotencyKey`。C6 とは層を分ける（§8-4）
- ローカルテストフォームサーバ（2段 / 1段）をワーカー側 E2E として移植
- **ワーカー側 CI を立てる**（§9 の門番）

**受入条件**: 2段/1段の両方が Plan → Execute まで通る ／ **C1・C2・C5 の回帰テストがワーカー CI で緑** ／
無認証リクエストが拒否される ／ 壊れた入力で 500 を返さない ／
ワーカーを落としても ASUMO が壊れず再起動で再開する

### Phase 3 — データ層（5〜6日）

- Drizzle スキーマ（**外部キー列は `company_id`**）+ マイグレーション
- `TARGETS` 登録（`sf_exclusions` は入れない）
- `form_send_ledger` の移植と `form_targets` の CAS（§5-2）
- 状態機械の書き換え（`BLOCKED_BY_ROBOTS` を含む）、`setStatus` 経由の工程反映（`dealNo` の決定）
- **スクショの総量上限 + 古い順削除**（後付けにしない）
- 現行 `data/app.db` からの移行スクリプト

**受入条件**: `company-reset.test.ts` が緑 ／ `companies:reset` / `demo:purge` が `form_*` を掃除し
`sf_exclusions` は残す ／ スクショ総量が上限内 ／ **C6 の回帰テスト（CSV 入れ替え取込の後でも
送信済みが再送対象にならないことを含む）**

### Phase 4 — 安全機構の結線（1〜1.5日 + D5 の実装分）

- `isSuppressed({ channel: "form" })` の結線（読み側は既存・実装不要）
- 送信時間帯 / 日次上限 / 送信間隔をハンドアウト判定へ
- **承認・送信操作を `authz.ts` に通す**。`asumo_me` クッキーを承認者の根拠にしない
- D5 が (a) なら `sf_exclusions` の `source` 列追加 +
  `replace` 取込の限定（**先に `suppression-channel.test.ts` で原則を固定してから**）

**受入条件**: **C6/C7 の回帰テスト** ／ 時間帯外・上限超過で 1 件も渡らない ／
権限のないユーザーが承認・送信できない

### Phase 5b — 承認・送信（**見積不能。D1 待ち**）

- 「承認して送信」ボタン・`authz` 判定・一斉送信
- **ワーカーの死活表示**（最終ポーリング時刻・待機件数）— 無いと滞留に気づけない（R1）

### Phase 6 — ジョブ・検証（4〜6日）

- ASUMO 側の軽量ジョブを **`lib/jobs/registry.ts` の `JOBS: JobDef[]`** へ登録
  （**`lib/jobs/tasks.ts` ではない**）
- **`JobDef` が既に持っているものを手で作らない**: `hasWork` ／ `deps` ／ `maxPerRun` ／
  `aiCapPerRun` ／ `timeoutMs` ／ `retry` ／ `singleWriter` ／ `adaptive`
- 実企業 10〜20社に対する **Plan フェーズのみ**の実地検証（送信はしない）

**受入条件**: **C5/C8/C9 の回帰テスト** ／ 現行 `docs/field_test_findings.md` と同等の入力精度

### 工数

| Phase | 見積 | D1 依存 |
|---|---:|---|
| A `guessFormUrl()` 置き換え | 4〜6日 | **独立** |
| 1 純ロジック層 | 3〜4日 | **独立** |
| 5a 確認 UI | 4〜5日 | **独立** |
| 0 意思決定 | 0.5日 | — |
| 2 ワーカー + プロトコル | 6〜9日 | 待ち |
| 3 データ層 | 5〜6日 | — |
| 4 安全機構 | 1〜1.5日 + D5分 | — |
| 5b 承認・送信 | 見積不能 | **待ち** |
| 6 ジョブ・検証 | 4〜6日 | — |

**D1・D2 が未決のあいだも動く: Phase A + 1 + 5a = 11〜15日ぶん。**
これで「正しいフォーム URL が出て、文面が出て、実際に入る値が事前に見える」まで到達する
（送信主体が担当者のままでも成立する範囲）。**D1 の議論の材料にもなる。**

---

## 11. リスク

| # | リスク | 対策 |
|---|---|---|
| R1 | **ワーカーが動いていない** — キューが静かに滞留し「送ったつもりで1件も出ていない」 | 最終ポーリング時刻と待機件数を承認画面に常時表示（Phase 5b）。N 時間無音でアラート |
| R2 | **二重送信**（複数ワーカー・リトライ・再送）＝C6 違反 | **層を分ける**（§8-4）：API 呼び出しの重複は `idempotencyKey`（TTL 120秒）／ 送信の一意性は `form_targets` の CAS + `form_send_ledger`。混ぜない |
| R3 | **ハンドアウト API が無認証だと外部から送信を起こせる** | fail-closed（未設定なら受け付けない・`dev-secret` を作らない）。経路は BASIC の内側 / 除外＋専用トークン の選択（§8-3） |
| R4 | ジョブの `timeoutMs` とブラウザ寿命の不整合 | 既定 120,000ms。ブラウザ作業は ASUMO に載せない。Phase A の並列度と `timeoutMs` は実測から明示設定（§10 A-4） |
| R5 | ワーカーの実行環境が個人PC | 手順を devlog に残す。中期的には常時稼働の実行環境へ（§13） |
| R6 | Fly の suspend からの復帰遅延 | ワーカー側でリトライ + バックオフ。cold start を異常扱いしない |
| R7 | Gemini 20RPM の枠を `call-transcribe` と食い合う | `aiCapPerRun: 8`。超過は繰り越し、ルールのみで続行（§6） |
| R8 | **`SCRAPE_MAX_BYTES`（2MB）× 並列数がメモリを食う** | 1GB なので並列度は 4〜6 に留める。実測して決める（§10 A-4） |
| R9 | 移植途中で 2 システムが並走 | 移行後に現行システムを読み取り専用へ凍結。並走は 1 スプリント以内 |
| R10 | `reparse` 相当の移行手順が漏れる | `formsend:reparse` を Phase 3 で用意し docs へ残す |

**解決済みとして消したリスク**: SQLite 書き込み競合は `JobDef.singleWriter` 既定（F1）。
Gemini の JSON は `responseSchema`（W3）。dispatcher 衝突は `utils/http.ts` を移植対象から外して消滅（F4）。

---

## 12. 決めること（5件）

| # | 論点 | 補足 |
|---|---|---|
| **D1** | **ASUMO が送信主体になってよいか** | `app/(main)/form-outreach/page.tsx:5` — 「メール送信（/outreach）から独立させたのは、**asumo は1通も送らない**から。ここで作るのは文面と URL の候補だけで、実際に送信するのは担当者本人の手作業になる」。画面バナーにも「この画面から**自動送信はされません**」。**営業・法務の判断であり、Phase 2・5b の前提**。Phase A・1・5a は待たずに動く |
| **D2** | **Chromium をどこで走らせるか** | D1 に従属。既決事項（§1）を覆すなら理由を文書に残す。ワーカー認証の経路（§8-3）も併せて決める |
| **D3** | **Plan スクショの保持期間と総量上限** | 承認済み・送信済みをいつ捨てるか（§4-5） |
| **D4** | **送信者アイデンティティ と 承認権限** | 「誰の名前で送るか」（`SENDER_*` の一元化）と「誰が承認してよいか」（`authz.ts`・`asumo_me` は根拠にできない）の両方（§7-1） |
| **D5**（新規・N2） | **営業お断り検知の置き場所** | (a) `sf_exclusions` に `source` 列を足し `replace` 取込を `source='sf'` に限定（推奨） ／ (b) engine 側の表に持ち 2 本判定。**法務のクリティカルパスなので、先に `suppression-channel.test.ts` で原則を固定してから触る**（§5-3） |

副次的に、送信の日次上限・時間帯（既定 200件 / 9–19時）を ASUMO の営業ポリシーと揃えるかがある。
Phase 4 の実装時に決めれば足りる。

### 既に答えがあり調査不要

`/outreach` の位置づけ（`form-outreach/page.tsx:5` — 業務判断）／ 抑制の読み（`sf-exclusion.ts:21,202`）／
テストランナー（`package.json:53`）／ `data.db` の pragma（WAL・`singleWriter` 既定）／
`TARGETS` の列名（`company_id` 一択）／ `customers` のドメイン列（無い・`url` のみ）／
LLM の参照先（`lib/gemini.ts`）／ Next.js + Playwright の同居（成立しない）。

---

## 13. 将来の選択肢

- **常時稼働の実行環境へ移設**: Chromium が載るサイズのマシンへワーカーを移す。ASUMO 側の変更はゼロ
- **ワーカーの複数化**: リース機構（R2）が前提なので、台数を増やすだけでスループットが上がる

---

## 付録. 処理フロー（実行主体つき）

```
[W] ワーカー   [A] ASUMO

[A] L1 静的     polite() で 定番パス(3) → リンク走査(1) → sitemap(1) = 最大5req/社
                  → robots 拒否なら BLOCKED_BY_ROBOTS（手送りは可）
                  ↓ 静的で決まらない候補のみ
[W] L1 描画     候補を描画してフォーム有無を確認
                  ↓ [A] が確度を採点 → formUrl + confidence
[W] 観測        ページを開く → 項目抽出（ラベル/必須バッジ/ハニーポット/maxlength/autocomplete）
                  → ボタン分類 / CAPTCHA種別 / 可視テキスト / formSelector
                  ↓ 生の観測データ
[A] L2 解析     分割欄検出 → 辞書マッピング → LLM補完（gemini schema・任意）
                  → 必須select/radio 自動選択 → 営業お断り検知（登録先は D5）
                  → ゲート判定（high / mid / low / block）→ FormSchema を保存
[A] L3 文面     テンプレ + 差込 + 業種別パーソナライズ + 署名
                  → maxlength に収まるまで optional ブロックを段階的に削る
                  → ロール別入力値を解決（分割欄へ配分・ふりがな変換・手動編集の適用）
[A] 適格性      非B2B / 対象外フォーム / CAPTCHA / 未充足必須 / 本文超過 → 除外
                  ↓ FormSchema + 解決済み値
[W] L4 Plan     新規セッション → 全項目入力 → 確認ボタンのみクリック → スクショ → セッション破棄
                  ↓ スクショをアップロード
[A] 確認(5a)    カバレッジ・誤り疑い・本文を確認 → 手動編集 → 再プレビュー
[A] 承認(5b)    承認（authz 判定・approved_by は検証済み本人）
[A] ハンドアウト isSuppressed(channel=form) → form_send_ledger 照会 → ペーシング
                  → form_targets を SUBMITTING へ CAS（更新0件なら渡さない）→ リース発行
                  ↓ FormSchema + 解決済み値
[W] L4 Execute  新規セッション → 同一内容で再入力 → 確認 → 最終送信
                  ↓ finalUrl / 可視テキスト / 残存フォーム数（再送は idempotencyKey で1回扱い）
[A] L5 判定     成功文言 / URL遷移 / フォーム消失 / エラー文言 / CAPTCHA残存
                  → submitted_success / failed / captcha / needs_review
[A] 記録        送信成功 → form_send_ledger に記録 ＋ form_targets.status = SUBMITTED_SUCCESS
                  （★ sf_exclusions には書かない — CSV 入れ替え取込で消える・§5-2）
                  → setStatus(companyId, STEP.FORM, DONE) で工程4へ反映（board_events に残る）
```
