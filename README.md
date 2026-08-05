# toiawase_form_sales_auto_system

MOCHICA のフォーム経由アウトバウンド営業を自動化するシステム。仕様書 v0.1 の実装。

**設計の絶対制約**: ブランドを燃やさない。全レイヤーに *抑制*・*計測*・*承認ゲート* を織り込む。
現状の実装ステータスは **P1（半自動MVP）** 相当 — 発見〜文面〜入力〜確認画面プレビューまで自動、
**最終送信は人が承認**（gate=high の全自動もフラグで解禁可能）。

## アーキテクチャ（7レイヤー + 横断機構）

| レイヤー | ファイル | 役割 |
|---|---|---|
| L0 リスト生成 | [src/layers/l0_list.ts](src/layers/l0_list.ts) | CSV取込 + **企業HP自動探索**（[l0_homepage.ts](src/layers/l0_homepage.ts)）+ ICPスコアリング + 競合ハード抑制 |
| L1 フォーム発見 | [src/layers/l1_discovery.ts](src/layers/l1_discovery.ts) | 定番パス→リンク走査→sitemap の段階探索 |
| L2 構造解析 | [src/layers/l2_parsing.ts](src/layers/l2_parsing.ts) | 辞書マッピング + 構造シグナル + LLMフォールバック + ハニーポット検知 + フラグ検出 + ゲート判定 |
| L3 文面生成 | [src/layers/l3_content.ts](src/layers/l3_content.ts) | テンプレ + 変数差し込み + 署名生成 + **業種別パーソナライズ**（[l3_personalize.ts](src/layers/l3_personalize.ts)）。全て決定論的 |
| L4 入力・送信 | [src/layers/l4_submit.ts](src/layers/l4_submit.ts) | **Plan承認→再実行パターン**（本設計の肝） |
| L5 結果判定 | [src/layers/l5_result.ts](src/layers/l5_result.ts) | 成功/失敗/CAPTCHA/要確認 |
| L6 記録・返信 | [src/layers/l6_record.ts](src/layers/l6_record.ts) | DB(source of truth) → CSVレポート層 |
| 横断 | [src/core/](src/core/), [src/crosscutting/](src/crosscutting/) | ステートマシン / ゲート / 抑制 / コンプラ / ペーシング / 監査 |

### L4 の肝：「Plan承認 → 再実行」パターン（§4-L4）

セッションを保持して人間を待たない。Plan（ドライラン）で全項目入力し、確認画面 or 入力済みフォームを
スクショしてセッション破棄。承認後、**新規セッション**で再入力→最終送信。これにより
承認待ち時間とセッション寿命を完全分離し、半自動→完全自動は「承認ゲートを外すだけ」になる。

## セットアップ

```bash
npm install                 # postinstall で playwright chromium も入る
cp .env.example .env         # 送信者情報・ペーシング等を設定
```

`.env` の `SENDER_*` は必ず正しい値に（コンプラ§9: 送信元の明示は必須）。
ここが**フォーム入力値と署名の唯一の出典**で、署名ブロックは `SENDER_*` から組み立てられる
（`buildSignature()`）。未設定の項目は行ごと落とす（`FAX ：` だけ残るような事故を防ぐ）。
`SENDER_ADDRESS` は都道府県/市区町村/番地に自動分割され、分割住所欄のあるフォームに対応する。
`SENDER_PHONE` は代表番号（フォームの「電話番号」欄）、`SENDER_MOBILE` は署名と「携帯電話」欄用。

> **値の捏造はしない**: 未設定の項目は空のまま送る（以前は電話未設定時に `03-0000-0000` を
> 入れていた）。必須欄が埋まらないフォームは自動除外され、人の判断に回る。

送信者情報やテンプレートを変更したら、ダッシュボードで手動編集した本文が**古い情報のまま固定**
されていないか確認する（手動編集はテンプレートより優先されるため）:

```bash
npx tsx scripts/reset_stale_overrides.ts          # 旧文面が残っている企業を確認（dry run）
npx tsx scripts/reset_stale_overrides.ts --apply  # 旧文面のみ削除（氏名・電話の編集は保持）
```

### L2（項目マッピング）を改修したあとの移行

解析結果 `field_maps` は**保存されている**ため、L2 の改善は新規に発見した企業にしか効かない。
既にキューにいる企業は古いマッピングのままなので、明示的に解析し直す:

```bash
npm run cli -- reparse                        # 解析済みの企業を現行マッパーで再解析 → PARSED に戻す
npm run cli -- reparse --include-suppressed   # 「非適格」で自動除外された企業もキューに戻して再判定
npm run cli -- plan                           # 新しいマッピングでプレビューを作り直す
```

`--include-suppressed` が戻すのは**パーサ自身の適格性判定**による除外（`ineligible_form`）だけ。
コンプラ由来の抑制（送信済み・配信停止・競合・営業お断り）は解除しない。
送信済み／送信中の企業は対象外（二重送信の経路を作らないため・§9）。
`ANTHROPIC_API_KEY` は任意（未設定でも L2 はルールベースで動作、曖昧項目のLLM補完のみ無効）。

> **Node のバージョン**: `better-sqlite3` はネイティブモジュール。Node を上げて
> `NODE_MODULE_VERSION` の不一致（`ERR_DLOPEN_FAILED`）が出たら `npm install better-sqlite3@latest`
> でプレビルドを取り直すか、C++ ビルドツール導入後に `npm rebuild better-sqlite3`。

## クイックスタート（サンプルデータで動作確認）

外部ネットワーク・APIキー不要。1コマンドでデモDBを作り、営業パイプラインの
各状態（承認待ち／承認済み／送信成功／送信失敗／抑制／未検出／新規）をまとめて投入する。
承認待ちには**本物の確認画面スクショ**が付くので、ダッシュボードのプレビューがそのまま出る。

```bash
npm run seed                 # デモDBをリセットしてサンプル9社を投入（数分・ブラウザ実操作）
npm run purge-demo -- --dry-run  # 投入済みデモ/テストデータの削除対象を確認
npm run purge-demo               # デモ/テストデータを削除（実データは残す。--all で全削除）
npm run serve                # http://localhost:4599 で承認ダッシュボードを確認
npm run cli -- status        # 状態別の件数
npm run cli -- pending       # 承認待ち一覧（スクショパス）
npm run cli -- report        # artifacts/report.csv / suppression.csv を出力
```

投入内容（[scripts/seed_demo.ts](scripts/seed_demo.ts)）は、ローカルのテストフォームサーバ
（確認画面あり2段 / 1段）に対して実パイプライン（L2→L3→L4 Plan/Execute）を実際に走らせている。
ダッシュボードの「送信実行 / 承認して即送信」を**ライブで**試す場合は、別ターミナルで
`npm run testform`（8787番に常駐）を起動しておくと、投入済み `form_url`（127.0.0.1:8787）へ
実送信できる。※最終送信は**送信可能時間帯**（`.env` の `SEND_WINDOW_START`〜`END`、既定 9–19時）
かつ日次上限内でのみ実行される（ペーシング §9。時間外は `_送信可: 0` となり実行はスキップされる）。

## 使い方（P1 半自動フロー）

```bash
npm run cli -- ingest scripts/sample_companies.csv   # L0 取込
npm run cli -- discover --limit 50                   # L1+L2 発見・解析
npm run cli -- plan --limit 50                        # L3+L4(Plan) ドライラン生成
npm run cli -- pending                                # 承認待ち一覧（スクショパス表示）
npm run cli -- approve 1                              # 人が承認
npm run cli -- execute --limit 50                     # L4(Execute)+L5 実送信（ペーシング付き）
npm run cli -- report                                 # L6 CSVレポート出力
npm run cli -- status                                 # 各状態の件数
```

gate=high を全自動送信するには `plan --auto-high`（§5 の段階自動化。計測して閾値超えたら解禁）。

### 取り込むCSVの列（L0）

ヘッダ有無・列順は自動判定。読み取るのは**企業の属性列だけ**で、SFA/CRM の書き出しを
そのまま貼っても構わない。

| 用途 | 認識するヘッダ名（例） |
|---|---|
| 会社名（必須） | `会社名` `企業名` `法人名` `社名` `company` `name` |
| サイト | `Webサイト` `ホームページ` `HP` `URL` `ドメイン` `会社URL` `website` |
| 業種 | `業種` `業界` `industry` |
| 従業員 | `従業員数` `従業員規模` `社員数` `規模` `employees` |
| 都道府県 | `都道府県` `所在地` `地域` `エリア` `prefecture` |
| 出典 | `出典` `媒体` `ソース` `リードソース` `source` |

**無視する列**: `電話` `担当者姓/名` `役職` `部署` `コール日時` `コールコメント`
`リードURL` `リードID` `リードステージ` `リード所有者` `備考` `メール` など、
リードレコードや個人を指す列。特に `リードURL`（SFA 内のリード詳細ページ）は全行で
ホストが同じなので、これを会社サイトとして取り込むと `companies.domain` は UNIQUE の
ため**全社が1社に統合されて消える**。取り込みプレビューには認識した列が表示され、
複数社が同一ドメインになる場合は警告が出る。

ヘッダ行が無い場合のみ、1列目=会社名 / 2列目=ドメイン として位置で読む。

### 企業HPを自動探索（名前だけのリストから送信まで）

ドメインが無く**企業名だけ**のリストでも、HP（公式サイト）を自動で探索してから
パイプラインに載せられる。ドメイン列が空の行は Web 検索で公式サイトを特定する
（[src/layers/l0_homepage.ts](src/layers/l0_homepage.ts) / [src/layers/websearch.ts](src/layers/websearch.ts)）。

```bash
# 名前だけのCSV/TXT → 公式HPを解決して [name,domain,...] を出力（調査用）
npm run cli -- resolve scripts/icp-targets-seed.csv --out data/icp-targets-resolved.csv

# 取込と同時にHPを自動解決（ドメイン欄が空の行だけ検索、埋まっている行はそのまま）
npm run cli -- ingest scripts/icp-targets-seed.csv --resolve
```

サンプルの ICP v2 準拠ターゲットリスト: [scripts/icp-targets-seed.csv](scripts/icp-targets-seed.csv)
（効率業種セグメントA〜Dの実企業。名前・業種・都道府県のみでドメイン無し）。

探索の肝は「ページを見つける」ことより**集約サイト（求人媒体・企業DB・SNS・Wikipedia・
ニュース）を弾いて“会社自身のサイト”に着地する**こと。二重の防御を入れている:

1. **ブロックリスト** — mynavi/rikunabi/baseconnect/salesnow/wikipedia/facebook 等は候補から除外。
2. **実在検証** — 候補HPを実際に取得し、**社名がそのトップページに出現するか**を確認できた
   ドメインだけを `search+verified` として採用。会社概要等の一般シグナルだけでは採用しない
   （*誤ドメイン=誤送信* はブランドを燃やすため。設計の絶対制約）。確認できない候補は
   `search+unverified`（既定では取込せず、`--accept-unverified` で明示的に許可）。

ISP間借り（例: `komeri.bit.or.jp`）はサブドメインを保持し、共有ドメイン（bit.or.jp）へ
潰さない。実測（ICP v2 セグメントの実企業10社）で **9/10 を verified で正解、verified の
精度は 100%**（誤採用ゼロ。1社は unverified として手動確認へ回送）。

> ターゲット企業の考え方は [docs/mochica-icp-v2-2026-07.md](docs/mochica-icp-v2-2026-07.md)（詳細ICP v2）。
> スコアリング設定は [config/icp.json](config/icp.json) に反映済み（従業員100-2000/ピーク300-500、
> 効率業種の細分ラベル、低成約ラベルの減点）。

### A — Web承認ダッシュボード

```bash
npm run serve                 # http://localhost:4599
```

承認待ち（PENDING_APPROVAL）を**フォーム項目単位の照合ビュー**で表示する。各社カードは、
実際のフォームが要求する項目（ラベル）と、そこへ入力される値を左右に並べ、
**必須充足率・誤りの疑い・自動選択箇所**を色分けで一目化する（[src/web/review.ts](src/web/review.ts)）:

- 🟢 OK … 適切な値が入る（会社名/氏名/メール/本文 等）
- 🟠 誤り疑い（suspect）… ラベルと値のロールが不一致（例:「住所」欄に郵便番号）
- 🔴 未入力（missing）… 必須なのに埋まらない空欄
- 🟣 要確認（auto）… 未マッピングの必須 select/radio を実行時に自動選択（何が選ばれるか要確認）

右カラムに**フルページ・スクロール対応のプレビュー**（クリックで拡大）と件名・本文全文。
**承認 / 承認して即送信 / 却下 / 抑制**、承認済みの**送信実行**をブラウザから操作できる。CLIの承認操作
([approval.ts](src/pipeline/approval.ts))をそのままHTTP化したもの（§13-2）。
実装: [src/web/server.ts](src/web/server.ts) + [src/web/dashboard.html](src/web/dashboard.html) + [src/web/review.ts](src/web/review.ts)。

#### マッピング判断の基準（誤り疑い・未入力をゼロに近づける）

項目照合と自動除外は次の基準で判定する。ロジックは
[src/layers/coverage.ts](src/layers/coverage.ts)（項目単位の予測）/
[src/layers/fillPolicy.ts](src/layers/fillPolicy.ts)（入力方針）/
[src/crosscutting/eligibility.ts](src/crosscutting/eligibility.ts)（フォーム適格性）に集約。

1. **ロール整合の判定**は `labelText` だけでなく `name / id / autocomplete` と `input type`
   を横断照合（`type=email/tel` は最優先、`search_by_zip_code…` は郵便として認識）。分割欄は
   base ロール（phone/postal/name/kana/address）に畳んで照合。→ 補助欄・分割欄の誤検知を排除。
2. **入力方針＝必須＋主要身元のみ**（会社名/氏名/フリガナ/メール/電話/本文/同意）。任意の付帯欄
   （部署・郵便番号検索の補助欄・積地/降地 等）は埋めない。L4 実入力と承認プレビューは
   `shouldFillField()` と `resolveFieldValue()` を共有し、プレビューと実送信が1文字も乖離しない
   （ふりがな→ひらがな変換、「携帯電話」欄への携帯番号差し替えも含む）。
3. **必須の select/radio**（種別・きっかけ等）は中立安全オプションを自動選択（`法人>企業>その他…`）。
   種別を**チェックボックス群**で表すフォームも同じ基準で**1つだけ**選択する。
   なお `type=checkbox` というだけで同意欄扱いにはしない（それをやると「OEMについて」「メディア・取材に
   ついて」等の種別が全部チェックされ、明らかにボットの挙動になる）。同意欄は語で判定する。
4. **住所の分割入力**（[l2_split.ts](src/layers/l2_split.ts) / `deriveAddressValues`）:
   都道府県 / 市区町村 / 番地・マンション名 に分かれた欄へ、`SENDER_ADDRESS` を分解して配分する。
   欄が2つしか無い場合は、**どの構成要素も落とさず重複させない**ように寄せる
   （都道府県+番地 なら 番地欄に「市区町村＋番地」）。都道府県欄は `<select>` のことが多いため
   常に都道府県のみ。フォームが1欄なら分割せず住所全体を入れる。
5. **フリガナのセイ/メイ分割**は `sei/mei`・`lastname/firstname` に加えて、読み仮名の接尾辞が
   くっついた `form_lastKana` / `form_firstKana` / `kanaSei` 形も認識する。
6. **本文は maxlength に合わせて決定論的に短縮**（[l3_content.ts](src/layers/l3_content.ts)）。
   テンプレの `<!--optional-->` ブロックを落として収める。**署名は絶対に削らない** — 途中で切られて
   送信元の連絡先が消えた文面はコンプラ§9違反になるため、収まらない場合は送信対象から外す。
7. **非適格フォームは自動除外**（キューから外す・[eligibility.ts](src/crosscutting/eligibility.ts)）:
   CAPTCHA v2（対話型・突破不能） / 営業お断り / **営業用ではないフォーム**（迷惑メール通報・苦情・
   解約受付など。`【迷惑メールの内容】迷惑メールの件名` に営業件名を入れると *自社をスパム報告* する
   ことになる） / 消費者向け・非B2B（介護相談・施設見学・要介護度 等） / 真実の値を持てない必須が残る /
   本文が maxlength に収まらない / 本文も会社名も入力先が無い。**捏造せず除外**（コンプラ§9）。
   ダッシュボードの「非適格を自動除外」ボタン（`POST /api/sweep`）または `buildPlan` 時に適用され、
   除外理由は「自動除外」セクションに表示（「キューに戻す」で個別復帰可）。
   なお **reCAPTCHA v3 は不可視・スコア型**で操作対象が無いため除外しない。ただし gate は `mid` 止まり
   にして全自動送信の対象からは外す（人が承認する）。

### B — 実ドメインでのL1発見バッチ

```bash
npm run discover-batch -- mochica.jp smarthr.jp cybozu.co.jp        # 引数で複数ドメイン
npm run discover-batch -- --file domains.txt --ingest --concurrency 4  # ファイル + DB投入
```

段階探索（定番パス→リンク→sitemap の静的fetch）で見つからない場合、**Playwrightでレンダリングして
再確認するfallback**を実行（JS/SPAフォーム対策）。実地テストで判明した現実：
- 単純な静的フォーム（WordPress/Contact Form 7系。＝本来のICPであるSMBに多い）→ 静的探索で高確度に発見
- SPA/JSレンダリングのフォーム（例: SmartHR, サイボウズ）→ ブラウザfallbackで発見
- **クロスオリジンiframe埋め込み**（HubSpot/Marketo等。大手SaaSに多い）→ 現状 `FORM_NOT_FOUND`（既知の限界、P2で対応候補）
- DNS到達不可・メールのみ → 想定内の `FORM_NOT_FOUND`（発見率KPIに計上）

### C — Google Sheets レポート同期

```bash
npm run cli -- report --sheets   # CSV出力に加えて Google Sheets へ同期
```

DBを source of truth に保ったまま、report/suppression の同一テーブルをスプレッドシートへ書き出す（§13-4 の
Sheetsレポート層を実体化）。`.env` に `SHEETS_SPREADSHEET_ID` とサービスアカウントJSONのパス
（`GOOGLE_SERVICE_ACCOUNT_KEY`）を設定し、対象スプレッドシートをそのサービスアカウントのメールに
Editor共有すれば有効化。未設定なら警告してスキップ（CSVのみ）。実装: [src/layers/l6_sheets.ts](src/layers/l6_sheets.ts)。

## 検証（P0 E2E）

外部ネットワーク不要。ローカルのテストフォーム（確認画面あり2段 / 1段 / ハニーポット付き）で
発見→解析→入力→確認画面→スクショ→送信→成功判定を通す。

```bash
npm run e2e        # 全チェック PASS を確認
npm run testform   # テストフォームをブラウザで手動確認したい場合
```

## データモデル / 状態遷移

- スキーマ: [src/db/schema.sql](src/db/schema.sql)（companies / field_maps / submissions / suppression / audit_log / send_ledger）
- ステートマシン: [src/core/stateMachine.ts](src/core/stateMachine.ts)（§7、不正遷移をガードし全遷移を監査ログへ）
- ゲート: [src/core/gate.ts](src/core/gate.ts)（発見×マッピング×アンチボットリスクの合成で high/mid/low/block）

## 未実装 / 今後（仕様書 §13・ロードマップ）

- P3: クラウド移行・IP管理・返信検知・Salesforce書き戻し
- P4: LLMパーソナライズ（ROI実測後に条件付き導入）
- L1: クロスオリジンiframe埋め込みフォーム（HubSpot/Marketo等）の発見・入力（大手向け。SMB ICPでは優先度低）
- 承認ダッシュボードは軽量Web実装済み（express）。GAS WebApp/React への載せ替えは §13-2 の決定次第で容易
