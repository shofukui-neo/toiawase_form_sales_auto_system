# toiawase_form_sales_auto_system

MOCHICA のフォーム経由アウトバウンド営業を自動化するシステム。仕様書 v0.1 の実装。

**設計の絶対制約**: ブランドを燃やさない。全レイヤーに *抑制*・*計測*・*承認ゲート* を織り込む。
現状の実装ステータスは **P1（半自動MVP）** 相当 — 発見〜文面〜入力〜確認画面プレビューまで自動、
**最終送信は人が承認**（gate=high の全自動もフラグで解禁可能）。

## アーキテクチャ（7レイヤー + 横断機構）

| レイヤー | ファイル | 役割 |
|---|---|---|
| L0 リスト生成 | [src/layers/l0_list.ts](src/layers/l0_list.ts) | CSV取込 + ICPスコアリング + 競合ハード抑制 |
| L1 フォーム発見 | [src/layers/l1_discovery.ts](src/layers/l1_discovery.ts) | 定番パス→リンク走査→sitemap の段階探索 |
| L2 構造解析 | [src/layers/l2_parsing.ts](src/layers/l2_parsing.ts) | 辞書マッピング + 構造シグナル + LLMフォールバック + ハニーポット検知 + フラグ検出 + ゲート判定 |
| L3 文面生成 | [src/layers/l3_content.ts](src/layers/l3_content.ts) | テンプレ + 変数差し込み（決定論的） |
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
`ANTHROPIC_API_KEY` は任意（未設定でも L2 はルールベースで動作、曖昧項目のLLM補完のみ無効）。

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
- 承認ダッシュボード（GAS WebApp / React）は現状CLIベース。§13-2 の決定待ち
- Sheets同期は現状CSV出力で代替（§13-4 の折衷案）
