# フォーム送信機構 ASUMO 移植 計画書

**作成日**: 2026-08-17 ／ **改訂**: 2026-08-17（rev.2 — ASUMO 実装レビュー反映）
**移植元**: `toiawase_form_sales_auto_system`（Node CLI + Express / 生SQL better-sqlite3 / 実装 7,703行）
**移植先**: ASUMO（Next.js 16 App Router + React 19 / Drizzle + better-sqlite3 / Fly.io）
**移植範囲**: L1〜L5 + 承認ダッシュボード（L0 リスト生成は対象外＝ASUMO 既存資産を使う）

> **rev.2 での変更点**: 初版は「ASUMO プロセス内で Playwright を動かす」前提で組んでいたが、
> これは成立しない（§1）。ブラウザ層を手元PC側ワーカーへ分離する構成に組み替えた。
> あわせて、初版が「要確認」としていた 6 項目に既存実装上の答えがあることを反映し、
> 安全機構の案A/案B比較（初版 §5）は決着済みのため削除した。
>
> 本改訂は ASUMO 側コードのレビュー指摘（`polite.ts:15` / `prospect/observe.ts:9` /
> `リスト作成機能_移植_20260811.md:101` / `form-outreach/page.tsx:5` / `outreach.impl.ts:651` /
> `company-reset.test.ts:214` / `sf-exclusion.ts:21,202` / `gemini.ts` / `registry.ts` / `cache.ts:5`）
> を**確定事実として受け入れて**書いている。本計画書の作成者は ASUMO リポジトリを直接読んでいない。

---

## 0. この移植の一行要約

「**フォームURL → 解析 → 文面生成 → 入力 → 人が承認 → 送信 → 結果判定**」という機構のうち、
**判断・データ・画面は ASUMO に、ブラウザ操作だけを手元PC側のワーカーに**置く。

ブラウザを分離しても機構は劣化しない。現行設計の C1（Plan はセッションを保持しない）により、
**解析・Plan・Execute はもともと 3 つの独立したブラウザセッション**であり、その境目に
プロセス境界を置く追加コストはゼロだからである。

---

## 1. 前提の訂正：ASUMO 本番に Chromium は載らない

初版はこれを「設定で解決できるビルドの問題」（初版 R1）として扱っていた。誤りである。

| 事実 | 出典 |
|---|---|
| Fly の shared-cpu-1x / 1GB に Chromium は載らない | `polite.ts:15` |
| 同旨（候補企業の巡回でブラウザを使わない理由） | `prospect/observe.ts:9` |
| **同じ形の移植で既に一度この判断を下している** | `リスト作成機能_移植_20260811.md:101` |
| `auto_stop_machines = "suspend"` / `min_machines_running = 0` | fly.toml |

初版の R1/R5 は開発機の話に閉じており、本番の話が無かった。加えて最後の 1 行は独立した問題を生む：
**マシンが停止している状態では、3時間毎・30分毎の無人ジョブが起きる保証がない。**
初版 §4-1 の自律ジョブ計画は、この 1 点だけでも成立しない。

### 1-1. 帰結：ワーカーが引きに来る（push ではなく pull）

ブラウザを手元PC側ワーカーに置くと、上の 2 つの問題が同時に解ける。

- ブラウザは 1GB 制約の外で動く
- **ワーカーの HTTP 要求そのものが Fly マシンを起こす**ので、ASUMO 側にスケジューラが要らない

したがって ASUMO 側には**ブラウザ関連の自律ジョブを一切登録しない**。ワーカーが
「作業をください」と定期的に問い合わせ、ASUMO が渡せる仕事を返す。スケジューリングの
責任はワーカー側にある。

---

## 2. プロセス境界の引き方

境界は「ブラウザが要るか」で引く。**判断は一切ワーカーに渡さない。**

```
┌─ ASUMO (Fly) ────────────────────────┐      ┌─ ワーカー (手元PC / Chromium可の実行環境) ─┐
│                                       │      │                                            │
│  項目→ロール マッピング (mapFields)   │      │  ブラウザセッション                        │
│  ゲート判定 / 適格性判定              │      │  DOM 抽出 (extract)                        │
│  文面生成 / 署名 / 値解決             │      │  打鍵・クリック・スクショ                  │
│  カバレッジ予測                       │◀────▶│  静的クロール (L1 候補収集)                │
│  結果判定 (L5 の判定ロジック)         │ HTTP │                                            │
│  抑制・ペーシング・承認・権限         │      │  ※ 判断はしない。観測と実行のみ            │
│  DB / 画面 / 操作ログ                 │      │                                            │
└───────────────────────────────────────┘      └────────────────────────────────────────────┘
```

### 2-1. やり取りする 3 つの往復

現行の `parseForm` / `planSubmission` / `executeSubmission` が既に 3 つの独立セッションなので、
**そのまま 3 つの往復になる**。設計を曲げていない。

| # | ワーカー → ASUMO | ASUMO の処理 |
|---|---|---|
| 1. 観測 | `DetectedField[]` / ボタン / CAPTCHA種別 / 可視テキスト / formSelector | `mapFields` → ゲート → 営業お断り検知 → 適格性 → `FormSchema` を保存 |
| 2. Plan | スクショ / 確認画面到達可否 / 使った戦略 | `form_submissions` に plan_ready を作成 → 承認待ちへ |
| 3. Execute | `finalUrl` / 可視テキスト / 残存フォーム数 | `judgeResult` で成功・失敗・CAPTCHA・要確認を判定 → 状態遷移 → 送信済み記録 |

**ASUMO → ワーカー**へ渡すのは、往復2・3では `FormSchema` と**解決済みのロール別入力値**。
ワーカーは値を作らず、渡された文字列を打つだけ。

> **これが C4（プレビュー == 実際に入る値）を構造的に保証する。**
> 文面描画と値解決が ASUMO 側にしか存在しないので、承認画面が見せた値と
> ワーカーが打つ値が原理的に一致する。初版のように両側で同じ純ロジックを
> 二重に持つ設計だと、この一致は「同じコードをコピーし続ける」運用でしか守れない。

### 2-2. ワーカーの設置形態

- 実行環境: 手元PC（営業担当 or 運用者の端末）。Chromium が動けば何でもよい
- 起動: 常駐 or 業務時間中のみ。**送信可能時間帯（9–19時）と揃えるなら常駐は不要**
- 認証: ASUMO へのアクセスはワーカー専用トークン。**これが無いと外部から送信を起こせてしまう**（R3）
- 資格情報: ワーカーは送信者情報を持たない（値は ASUMO から渡ってくる）。
  持つのは ASUMO の URL とトークンだけ

---

## 3. 移植対象の棚卸し（rev.2）

初版は「ASUMO へ」の 1 宛先で分類していたが、宛先が 2 つになったので切り直した。

| 分類 | 行数 | 割合 | 内容 |
|---|---:|---:|---|
| ASUMO へ（純ロジック・無改造） | 約 2,340 | 30% | 解析マッピング・文面・カバレッジ・ゲート・適格性・結果判定 |
| ワーカーへ（無改造） | 約 1,260 | 16% | ブラウザセッション・DOM抽出・打鍵/送信機構・静的クロール |
| 書き換え | 約 1,000 | 13% | DB層・状態機械・パイプライン・LLM 呼び出し |
| 作り直し | 約 1,730 | 23% | 承認ダッシュボード・CLI |
| 移植しない | 約 1,320 | 17% | L0 リスト生成・L6 レポート |

### 3-1. ASUMO へ（純ロジック・無改造）— 約 2,340行

| 現行ファイル | 行数 | ASUMO での配置 |
|---|---:|---|
| `types.ts` | 179 | `lib/formsend/types.ts` |
| `layers/l2_parsing.ts`（`mapFields` 部） | 約 190 | `lib/formsend/parse/map.ts` |
| `layers/l2_dictionary.ts` | 184 | `lib/formsend/parse/dictionary.ts` |
| `layers/l2_split.ts` | 366 | `lib/formsend/parse/split.ts` |
| `layers/l2_choice.ts` | 155 | `lib/formsend/parse/choice.ts` |
| `layers/l3_content.ts` | 401 | `lib/formsend/content/render.ts` |
| `layers/l3_personalize.ts` | 172 | `lib/formsend/content/personalize.ts` |
| `layers/fillPolicy.ts` | 81 | `lib/formsend/content/fill-policy.ts` |
| `layers/coverage.ts` | 200 | `lib/formsend/coverage.ts` |
| `core/gate.ts` | 109 | `lib/formsend/gate.ts` |
| `crosscutting/eligibility.ts` | 102 | `lib/formsend/eligibility.ts` |
| `layers/l5_result.ts`（判定部） | 約 80 | `lib/formsend/judge.ts` |
| `crosscutting/compliance.ts`（`detectNoSalesPolicy` のみ） | 約 25 | `lib/formsend/no-sales.ts` |
| `utils/url.ts` + `config.ts` の `splitAddress` | 約 70 | `lib/formsend/utils/` |

**`judge.ts` は要リファクタ**（軽微）。現行は `Page` を受け取るので、
`{ finalUrl, visibleText, formCount, beforeUrl, captchaPresent }` を受ける純関数に変える。
判定ロジック自体は変えない。

### 3-2. ワーカーへ（無改造）— 約 1,260行

| 現行ファイル | 行数 | 備考 |
|---|---:|---|
| `browser/browser.ts` | 111 | セッション・人間らしい打鍵・決定論的ジッタ |
| `browser/extract.ts` | 282 | DOM 抽出。**ハニーポット判定・必須バッジ検知はここ**（C5 の実装点） |
| `layers/l4_submit.ts` | 423 | 入力・確認クリック・最終送信の機構 |
| `layers/l1_discovery.ts` | 240 | 静的クロール + ブラウザ描画フォールバック |
| `utils/{http,crash_guard,logger}.ts` | 172 | HTTPスタック・クラッシュ防御 |
| （新規）ポーラ + ASUMO クライアント | 約 200 | 作業取得・結果返却・リトライ |

**`utils/http.ts` はワーカー側へ移すことで、初版 R2（`setGlobalDispatcher` が ASUMO の
`polite.ts` クローラと衝突する）が消える。** undici 8 を明示的に噛ませる目的
（undici 7 のパーサ assert でプロセスごと落ちる事故への対策）はワーカー内で完結する。

### 3-3. 書き換え — 約 1,000行

| 現行ファイル | 行数 | 書き換え理由 |
|---|---:|---|
| `config.ts` | 164 | `SENDER_*` env → ASUMO の設定/社員マスタ由来へ（D2） |
| `db/db.ts` + `repositories.ts` | 294 | 生 SQL → Drizzle（§4） |
| `core/stateMachine.ts` | 58 | `form_targets.status` + 工程反映 |
| `crosscutting/compliance.ts` | 54 → 約5 | `preSendCheck` は `isSuppressed({ channel: "form" })` の 1 行になる（§5） |
| `crosscutting/pacing.ts` | 46 | 送信ハンドアウト時の判定へ |
| `pipeline/pipeline.ts` | 268 | 3ステージ → ワーカーへのハンドアウト API + server action |
| `pipeline/approval.ts` | 118 | server action へ。承認は `authz.ts` の権限判定を通す |
| `layers/l2_llm.ts` | 87 | Anthropic SDK 直呼び → `gemini.ts`（§6） |

### 3-4. 作り直し / 移植しない

作り直し（約 1,730行）: `web/server.ts` 557 ／ `web/dashboard.html` 754 ／ `web/review.ts` 109 ／ `index.ts` 313。

移植しない（約 1,320行）: `l0_list.ts` 440 ／ `l0_homepage.ts` 347 ／ `l0_autodiscovery.ts` 192 ／
`websearch.ts` 169 ／ `l6_record.ts` 76 ／ `l6_sheets.ts` 94 ／ `config/icp.json`。
いずれも ASUMO の ①リストインポート・`prospect-*`・`/usage` が代替する。

---

## 4. データ層

### 4-1. 列名は `company_id`（確定・厳守）

初版は「`customer_id` にして、`TARGETS` 検出が対応しているか要確認」と書いた。**誤り。**

`company-reset.test.ts:214` は**列名リテラル照合**である。したがって：

> `customer_id` で作ると、**検出網にかからないままテストは緑になり、消し漏れが通る。**

要確認事項ではなく、失敗が沈黙する種類の罠である。**全 `form_*` テーブルの外部キー列は
`company_id` で作る**こと、そして `lib/company-reset.ts` の `TARGETS` へ登録することを
Phase 3 の必須条件とする。

### 4-2. テーブル設計

企業マスタは二重に持たない。ASUMO の企業マスタを正とし、フォーム送信固有のデータだけを持つ。

| 現行テーブル | ASUMO |
|---|---|
| `companies` | **作らない**。`status`/`form_url` は `form_targets` へ分離 |
| `field_maps` | `form_schemas`（`company_id`, `schema_json`, `gate`, `mapping_confidence`, `has_captcha`, `has_confirm_screen`） |
| `submissions` | `form_submissions`（`company_id`, `content_rendered`, `plan_screenshot_key`, `status`, `approved_by/at`, `submitted_at`, `result_detail`） |
| `content_overrides` | `form_content_overrides`（`company_id` PK, `overrides_json`） |
| `suppression` | **作らない**。`sf-exclusion` の台帳を使う（§5） |
| `send_ledger` | `form_send_ledger`（`company_id`, `day`, `sent_at`） |
| `audit_log` | `op_logs` + 企業イベント |
| （新規） | `form_targets`（`company_id` PK, `form_url`, `form_confidence`, `status`, `lease_token`, `leased_until`, `updated_at`） |

`lease_token` / `leased_until` は**ワーカーへの作業ハンドアウト用**。複数ワーカーや
再送で同じ企業が二重に処理されるのを防ぐ（R4）。

`schema_json` は JSON を text で保持。Postgres 移行時に jsonb へ移せるよう、
アプリ側は必ずパーサ経由で読む（生 SQL で JSON 演算子を使わない）。

### 4-3. Plan スクショの保持ポリシー（初版の欠落）

初版はスクショの置き場だけ書き、**保持期間も総量上限も書いていなかった**。
`cache.ts:5` が「volume を埋めて DB の書き込みが失敗する」罠を明記しているにもかかわらずである。

必要なもの：

- **保持期間**: 送信完了 or 除外から N 日で削除（既定 30 日を提案）
- **総量上限**: LRU で上限超過分を削除（`SCRAPE_CACHE_MAX_MB` と同じ考え方）
- **掃除の実行主体**: ASUMO 側の軽量ジョブ（ブラウザ不要なので `registry.ts` に載せられる）
- スクショはフルページ PNG で 1 枚あたり数百 KB〜数 MB になる。**上限なしは volume 枯渇と同義**

---

## 5. 抑制：既存台帳を呼ぶだけ（初版 §5 は削除）

初版は案A（engine 完結）／案B（ASUMO 統合）を比較したが、**この論争は決着済みだった。**

| 事実 | 出典 |
|---|---|
| `SUPPRESSION_CHANNELS` に `form` が列挙済み | `sf-exclusion.ts:21` |
| 架電/メール/DM/フォームの全経路がここを必ず通る | `sf-exclusion.ts:202` |
| 回帰テスト 273 行が既に存在 | 同テスト |

したがって：

- `preSendCheck` → **`isSuppressed({ ..., channel: "form" })` を呼ぶだけ**。Port の読み側は実装不要
- `markSent` → 同じ台帳へ `channel: "form"` で書く（`:202` の「全経路が必ず通る」に従う）
- 初版が提案した `SuppressionPort` インタフェースも `form_suppression` テーブルも**不要**

engine 側に残すのは**送信時間帯・日次上限・送信間隔**だけ。これはフォーム送信固有のマナーで、
ASUMO の他経路と共有すべき値ではない（既定値の是非は D3）。

---

## 6. LLM：参照先が違っていた

初版 §4-5 は `lib/external.ts` を差し替え先として指したが、**これは外部連携のスタブ・ファサード**であり、
LLM の実装ではない。正しい参照先は `gemini.ts`。

あわせて初版 R6（「Gemini が JSON 以外を返すリスク」）も**解決済み**である。
`gemini.ts` の `responseSchema` でスキーマが強制されるため、現行の
「JSON のみを返せ」というプロンプト頼みの構造ごと不要になる。

- `classifyAmbiguousFields` を `gemini.ts` 経由に変更し、ロール分類の `responseSchema` を定義
- 予算キャップは ASUMO の作法（`JOBS_AICAP_*`）に合わせる
- 失敗・未設定時は**必ずルールのみで続行**（現行の挙動を維持）

---

## 7. 壊してはいけない設計制約

移植中に「動かすこと」を優先して踏み潰しやすい制約。**ここを崩すと機構は動くがブランドが燃える。**

| # | 制約 | rev.2 での実装点 |
|---|---|---|
| C1 | Plan はセッションを保持しない | ワーカー側 `finally { session.close() }`。**この制約こそがプロセス境界を無コストにしている** |
| C2 | Plan は最終送信ボタンを押さない | ワーカー側。`confirm` 種別のみクリック |
| C3 | 値を捏造しない | ASUMO 側。未設定の送信者情報は空のまま → 適格性で除外 |
| C4 | プレビュー == 実際に入る値 | **ASUMO 側にしか値解決が存在しない**ので構造的に保証（§2-1） |
| C5 | ハニーポットに絶対入力しない | ワーカー側 `extract.ts` で検知 → ASUMO でマッピング除外 → ワーカーで二重ガード |
| C6 | 同一企業へ二度送らない | ASUMO 側。`sf-exclusion` + `form_targets` の CAS（R4） |
| C7 | 営業お断り表記を尊重する | ASUMO 側 `detectNoSalesPolicy`（ワーカーが返した可視テキストに対して実行） |
| C8 | 対象外フォームに営業文面を入れない | ASUMO 側 適格性判定 |
| C9 | 本文の途中切れを許さない | ASUMO 側 L3 の段階収縮 |

受入テストは**この 9 項目それぞれに回帰テストを持つこと**を条件とする。

---

## 8. 段階計画（rev.2）

### Phase A — 先行投入：`guessFormUrl()` の置き換え（2〜3日・送信可否の決定と独立）

`outreach.impl.ts:651` の `guessFormUrl()` は定番パス 5 個のベタ書きである。
L1 発見（定番パス → リンク走査 → sitemap）は明確な上位互換であり、
**手送り運用のままでも効く**。ASUMO が送信主体になるかの結論を待つ必要がない。

- 静的 3 段階のみ実装（ブラウザ描画フォールバックは Phase 2 でワーカーが付く）
- クロールは ASUMO 既存の `polite.ts` に載せる（`utils/http.ts` は持ち込まない）

**受入条件**: 現行 `guessFormUrl()` が見つけられなかった企業でフォーム URL が取れることを実データで確認。既存の手送りフローが壊れていない。

### Phase 0 — 意思決定（0.5日・調査ではない）

初版は 9 項目の調査に 2〜3 日を置いたが、**6 項目には既に答えがある**（§9）。
残るのは調査ではなく意思決定 4 件（D1〜D4）。会議 1 本で決める。

### Phase 1 — 純ロジック層を ASUMO へ（3〜4日）

- `types` / `parse/*` / `content/*` / `fill-policy` / `coverage` / `gate` / `eligibility` / `judge`（純関数化）
- `tests/l2_parsing.test.ts`（33KB・実フォームのキャプチャを replay する**ブラウザ非依存**テスト）を移植。
  **これは移植の生命線**であり、実企業フォームで積んだ知見の唯一の回帰網

**受入条件**: `npm test`（**3本立ての全て**）が緑 ／ `lib/formsend/` が ASUMO の他モジュールを import していない

### Phase 2 — ワーカー + プロトコル（4〜5日）

- ワーカー本体（ブラウザ層・打鍵機構・静的クロール）とポーラ
- ASUMO 側のハンドアウト API（リース発行・結果受理・トークン認証）
- ローカルテストフォームサーバ（確認画面あり2段 / 1段）を**ワーカー側の E2E** として移植

**受入条件**: ローカルテストフォームで 2段/1段の両方が Plan → Execute まで通る ／ **C1・C2 の回帰テスト** ／ ワーカーを落としても ASUMO 側が壊れず、再起動で処理が再開する

### Phase 3 — データ層（4〜5日）

- Drizzle スキーマ（**外部キー列は `company_id`**）+ マイグレーション
- `lib/company-reset.ts` の `TARGETS` 登録
- 状態機械の書き換え、工程反映（工程4の `dealNo` の扱いを含む）
- 現行 `data/app.db` からの移行スクリプト

**受入条件**: `company-reset.test.ts` が緑 ／ `companies:reset` / `demo:purge` が `form_*` も掃除する ／ **C6 の回帰テスト**

### Phase 4 — 安全機構の結線（1日・初版から大幅短縮）

抑制の読み書きが `isSuppressed` 呼び出しに縮んだため、残るのはペーシングと権限のみ。

- 送信時間帯 / 日次上限 / 送信間隔をハンドアウト判定へ
- **承認・送信操作を `authz.ts` の権限判定に通す**（初版の欠落）

**受入条件**: **C6/C7 の回帰テスト** ／ 時間帯外・上限超過で 1 件も渡らない ／ 権限のないユーザーが承認・送信できない

### Phase 5 — 画面（5〜7日・最大の作業量）

- 承認待ち / 承認済み / 除外のタブ、項目別カバレッジ表、Plan スクショ、手動編集、単発・一斉送信
- **ワーカーの死活表示**（最終ポーリング時刻・待機中の作業数）— 無いと滞留に気づけない（R2）
- server action を `op()` で包み、`oplog-catalog.ts` へ日本語名を登録（本文は文字数のみ記録）
- `ui/nav.ts` へ画面登録、スクショ配信 API

**受入条件**: `npm test` 3本立てが緑 ／ **C4 の回帰テスト** ／ 手動編集→再プレビュー→承認→送信が画面だけで完結

### Phase 6 — 運用（3〜4日）

- スクショの保持期間・総量上限とその掃除ジョブ（§4-3）
- ASUMO 側に残る軽量ジョブを `registry.ts` へ登録（**`tasks.ts` ではない**。既定 `timeoutMs` 120秒に収まる粒度で）
- `docs:sync` / devlog の作法に従ったドキュメント整備
- 実企業 10〜20社に対する **Plan フェーズのみ**の実地検証（送信はしない）

**受入条件**: **C5/C8/C9 の回帰テスト** ／ スクショ総量が上限内に収まる ／ 現行 `docs/field_test_findings.md` と同等の入力精度

### 工数

| Phase | 内容 | 見積 |
|---|---|---:|
| A | `guessFormUrl()` 置き換え（先行・独立） | 2〜3日 |
| 0 | 意思決定 | 0.5日 |
| 1 | 純ロジック層 → ASUMO | 3〜4日 |
| 2 | ワーカー + プロトコル | 4〜5日 |
| 3 | データ層 | 4〜5日 |
| 4 | 安全機構 | 1日 |
| 5 | 画面 | 5〜7日 |
| 6 | 運用 | 3〜4日 |
| | **合計（1人・逐次）** | **23〜30日** |

Phase A は独立して先行可能。Phase 1 と Phase 2 は並行可能（境界がプロトコルで切れているため）。

---

## 9. リスク（rev.2 で全面差し替え）

初版の R1/R5（Playwright のバンドル・HMR リーク）は**開発機の話に閉じており本番の話が無かった**。
ブラウザを分離したことで両方とも消え、代わりにワーカー運用のリスクが立つ。
R2（dispatcher 衝突）と R6（Gemini の JSON）も §3-2 / §6 で解消済み。

| # | リスク | 影響 | 対策 |
|---|---|---|---|
| R1 | **ワーカーが動いていない** | キューが静かに滞留する。「送ったつもりで 1 件も出ていない」 | 最終ポーリング時刻と待機件数を承認画面に常時表示（Phase 5 受入条件）。N 時間無音でアラート |
| R2 | ワーカーの実行環境が個人PC | 端末の入れ替え・OS更新で止まる。属人化 | 手順を devlog に残す。中期的には常時稼働の実行環境へ移す（§10） |
| R3 | **ハンドアウト API が無認証だと外部から送信を起こせる** | 第三者が実企業へ送信できる | ワーカー専用トークン必須。ASUMO 側で発行・失効可能に。Phase 2 の受入条件へ |
| R4 | **二重送信**（複数ワーカー・リトライ・再送） | C6 違反 | `form_targets` の `lease_token`/`leased_until` によるリース + 送信直前の CAS。更新行数 0 なら送らない |
| R5 | **Plan スクショが volume を埋める** | `cache.ts:5` の罠を再度踏み、DB 書き込みが失敗する | 保持期間 + 総量上限 + 掃除ジョブ（§4-3）。Phase 6 の受入条件へ |
| R6 | `registry.ts` の既定 `timeoutMs` 120秒 | ASUMO 側に載せたジョブが途中で切られる | ブラウザ作業は載せない。載せるのは掃除など短いものだけ。長いものは分割 |
| R7 | Fly の suspend からの復帰遅延 | ワーカーの最初の要求がタイムアウトする | ワーカー側でリトライ + バックオフ。cold start を異常扱いしない |
| R8 | 移植途中で 2 システムが並走 | L2 マッパー改善が片方にしか効かない | 移行後に現行システムを読み取り専用へ凍結。並走は 1 スプリント以内 |
| R9 | `reparse` 相当の移行手順が漏れる | ASUMO 側でも古いマッピングのまま塩漬け | `formsend:reparse` を Phase 3 で用意し、docs へ手順を残す |

---

## 10. 将来の選択肢

ワーカーを手元PCに置くのは**始点であって終点ではない**。プロトコルで切れているため、
実行環境だけを差し替えられる。

- **常時稼働の実行環境へ移設**: Chromium が載るサイズのマシン（Fly の別プロセスグループ、
  あるいは社内サーバ）へワーカーを移す。ASUMO 側の変更はゼロ
- **ワーカーの複数化**: リース機構（R4）が既に前提なので、台数を増やすだけでスループットが上がる

---

## 11. 決めること（4件）／ 既に答えがあること（6件）

### 決めること — いずれも技術判断ではない

| # | 論点 | 補足 |
|---|---|---|
| **D1** | **ASUMO が送信主体になってよいか** | 初版は「置換か裏側か」という技術判断として扱ったが誤り。`form-outreach/page.tsx:5` に「asumo は1通も送らないから」画面を分けたと明記されている。**業務判断であり、Phase 1〜6 全体の前提**。なお Phase A はこの結論を待たずに着手できる |
| **D2** | 送信者アイデンティティ（会社固定 or 担当者別） | 現行は `.env` の `SENDER_*` が「フォーム入力値と署名の唯一の出典」。ASUMO は複数担当を持つため、この一元化をどう持ち上げるか。C3 の判定基準にも影響 |
| **D3** | 送信の日次上限・時間帯（既定 200件 / 9–19時）を ASUMO の営業ポリシーと揃えるか | ワーカーの稼働時間設計にも直結する |
| **D4** | ワーカーの設置場所と運用責任者 | 誰の端末で、誰が落ちたことに気づくか（R1/R2） |

### 既に答えがあること — 調査不要

| 初版 Phase 0 の項目 | 答え |
|---|---|
| `/outreach` の実装・置換可否 | `form-outreach/page.tsx:5` — 業務判断（D1 へ移動） |
| 抑制リストのスキーマと意味論 | `sf-exclusion.ts:21,202` — `form` チャネル実装済み（§5） |
| テストランナー | `npm test` は 3本立て |
| `TARGETS` の列名対応 | `company-reset.test.ts:214` は列名リテラル照合。`company_id` 必須（§4-1） |
| LLM の参照先と JSON 返却 | `gemini.ts` の `responseSchema`。`external.ts` はスタブ・ファサードで参照先が違う（§6） |
| Next.js + Playwright の同居 | 成立しない。`polite.ts:15` ほか（§1） |

---

## 付録. 現行機構の処理フロー（rev.2 — 実行主体つき）

```
[W] ワーカー   [A] ASUMO

[W] L1 発見     domain → 定番パス → リンク走査 → sitemap → (静的で見つからなければ) 描画
                  ↓ formUrl + confidence
[W] 観測        ページを開く → 項目抽出（ラベル/必須バッジ/ハニーポット/maxlength/autocomplete）
                  → ボタン分類 / CAPTCHA種別 / 可視テキスト / formSelector
                  ↓ 生の観測データを ASUMO へ
[A] L2 解析     分割欄検出（姓名・カナ・電話・郵便・住所・メール確認）
                  → 辞書マッピング（貪欲割当）→ LLM補完（曖昧項目のみ・任意）
                  → 必須select/radio 自動選択 → 営業お断り検知
                  → ゲート判定（high / mid / low / block）
                  ↓ FormSchema を保存
[A] L3 文面     テンプレ + 変数差込 + 業種別パーソナライズ + 署名生成
                  → maxlength に収まるまで optional ブロックを段階的に削る
                  → ロール別入力値を解決（分割欄へ配分・ふりがな変換・手動編集の適用）
[A] 適格性      非B2B / 対象外フォーム / CAPTCHA / 未充足必須 / 本文超過 → 除外
                  ↓ FormSchema + 解決済み値をワーカーへ
[W] L4 Plan     新規セッション → 全項目入力 → 確認ボタンのみクリック → スクショ → セッション破棄
                  ↓ スクショを ASUMO へ
[A] 承認        項目別カバレッジ・誤り疑い・本文を確認 → 手動編集 → 承認（authz 判定）
[A] ハンドアウト 抑制チェック（isSuppressed channel=form）→ ペーシング → リース発行
                  ↓ FormSchema + 解決済み値をワーカーへ
[W] L4 Execute  新規セッション → 同一内容で再入力 → 確認 → 最終送信
                  ↓ finalUrl / 可視テキスト / 残存フォーム数
[A] L5 判定     成功文言 / URL遷移 / フォーム消失 / エラー文言 / CAPTCHA残存 で
                  submitted_success / failed / captcha / needs_review
[A] 記録        送信成功 → sf-exclusion へ channel=form で登録（二度と送らない）
```

---

## 未反映：レビュー指摘の残り 2 件

レビューで挙がった見落とし 8 件のうち、本改訂に反映したのは 6 件
（`registry.ts` / スクショ保持 / `npm test` 3本立て / `docs:sync`・devlog / 工程4の `dealNo` / `authz.ts`）。
**残り 2 件は記事側にのみ存在し、本計画書に未反映。** 受領後に rev.3 で取り込む。
