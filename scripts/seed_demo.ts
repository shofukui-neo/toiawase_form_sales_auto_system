/**
 * デモ用サンプルデータ投入スクリプト（動作確認用）。
 *
 * 実パイプライン（L2 構造解析 → L3 文面生成 → L4 Plan/Execute）を、外部ネット
 * ワーク不要のローカルのテストフォームサーバに対して実際に走らせ、DB を営業
 * パイプラインの各状態で満たす。生成される確認画面スクショは本物なので、承認
 * ダッシュボード（npm run serve）のプレビューがそのまま表示できる。
 *
 * 投入される状態:
 *   PENDING_APPROVAL ×3  … 承認待ち（本物のPlanスクショ付き / 2段フォーム・1段フォーム）
 *   APPROVED         ×1  … 承認済み・送信待ち
 *   SUBMITTED_SUCCESS×1  … ローカルフォームへ実送信して成功判定まで通したもの
 *   SUBMITTED_FAILED ×1  … 送信失敗（デモ用に結果を注入）
 *   SUPPRESSED       ×1  … 競合ATS導入済みでハード抑制（L0）
 *   FORM_NOT_FOUND   ×1  … フォーム未検出（既知の想定内ケース）
 *   NEW              ×1  … 未処理の新規リード（discover から試せる）
 *
 * 使い方:  npm run seed
 *   既存のデモDBを毎回リセットしてから投入する（app.db を初期化）。
 *   ダッシュボードの「送信実行 / 承認して即送信」をライブで試したい場合は、
 *   別ターミナルで `npm run testform`（8787番で常駐）を立ち上げておくと、
 *   投入済み form_url（127.0.0.1:8787）に対して実送信できる。
 */

// --- config が env を読む前に、送信者情報とペーシングを確定させる ---
process.env.SENDER_COMPANY ||= 'ネオキャリア株式会社';
process.env.SENDER_PRODUCT ||= 'MOCHICA';
process.env.SENDER_PERSON ||= '福井 翔';
process.env.SENDER_EMAIL ||= 'sho.fukui@neo-career.co.jp';
process.env.HEADLESS ||= 'true';
process.env.LOG_LEVEL ||= 'info';
// デモの実送信（SUBMITTED_SUCCESS ケース）がペーシング窓で弾かれないよう広げる。
// dotenv は既に設定済みの env を上書きしないので、これらが優先される。
process.env.SEND_WINDOW_START = '0';
process.env.SEND_WINDOW_END = '24';
process.env.DAILY_SEND_LIMIT ||= '9999';

import net from 'node:net';
import type { Server } from 'node:http';
// 型のみ（実行時には消える＝env 確定前に import しても副作用なし）。
import type { IngestRow } from '../src/layers/l0_list.js';
import type { FormSchema } from '../src/types.js';

const FIXED_PORT = 8787;

/** 8787 が空いているか（既に npm run testform が居るか）を確認。 */
function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  // env 確定後に動的 import（config を含む全モジュールがここで env を読む）。
  const { startServer } = await import('./test_form_server.js');
  const { db } = await import('../src/db/db.js');
  const { companies, fieldMaps, submissions, suppression, audit } = await import(
    '../src/db/repositories.js'
  );
  const { transition } = await import('../src/core/stateMachine.js');
  const { loadIcp } = await import('../src/config.js');
  const { scoreIcp } = await import('../src/layers/l0_list.js');
  const { parseForm } = await import('../src/layers/l2_parsing.js');
  const { buildPlan, runExecute } = await import('../src/pipeline/pipeline.js');
  const { approve } = await import('../src/pipeline/approval.js');

  const icp = loadIcp();
  const approver = 'demo@neo-career.co.jp';

  /* ---------------- 0) 既存デモDBをリセット ---------------- */
  const conn = db();
  conn.exec(`
    DELETE FROM submissions;
    DELETE FROM field_maps;
    DELETE FROM send_ledger;
    DELETE FROM audit_log;
    DELETE FROM suppression;
    DELETE FROM companies;
    DELETE FROM sqlite_sequence;
  `);
  console.log('DB をリセットしました（既存のデモデータを削除）');

  /* ---------------- 1) ローカルのテストフォームサーバ ---------------- */
  let ownServer: Server | null = null;
  let base: string;
  if (await portFree(FIXED_PORT)) {
    const started = await startServer(FIXED_PORT);
    ownServer = started.server;
    base = started.url; // http://127.0.0.1:8787
    console.log(`テストフォームサーバを起動: ${base}`);
  } else {
    base = `http://127.0.0.1:${FIXED_PORT}`;
    console.log(`8787 は使用中 — 既存のテストフォームサーバを再利用: ${base}`);
  }
  const CONTACT = `${base}/contact`; // 2段（確認画面あり）+ ハニーポット
  const SIMPLE = `${base}/simple`; // 1段（確認画面なし）

  /** NEW→…→PARSED まで進めて schema を保存（L1発見は擬似的にローカルフォームを割当）。 */
  async function toParsed(id: number, formUrl: string, conf: number): Promise<void> {
    transition(id, 'DISCOVERING');
    companies.setForm(id, formUrl, conf);
    transition(id, 'FORM_FOUND', { detail: `demo-assign conf=${conf}` });
    transition(id, 'PARSING');
    const schema = await parseForm({ formUrl, formConfidence: conf });
    fieldMaps.save(id, schema);
    transition(id, 'PARSED', { detail: `gate=${schema.gate} conf=${schema.mappingConfidence}` });
  }

  /** L0 と同じスコアリングで会社を登録。 */
  function add(row: IngestRow): number {
    const { score } = scoreIcp(row, icp);
    const c = companies.upsert({
      name: row.name,
      domain: row.domain,
      source: row.source,
      icpScore: score,
    });
    return c.id;
  }

  let n = 0;
  const step = (msg: string) => console.log(`\n[${++n}] ${msg}`);

  /* ---------------- 2) PENDING_APPROVAL ×3（本物のPlanスクショ付き） ---------------- */
  step('承認待ち: デモ介護サービス（2段フォーム・確認画面）');
  {
    const id = add({ name: 'デモ介護サービス株式会社', domain: 'demo-kaigo.example.jp', industry: '介護', employees: 320, source: 'マイナビ' });
    await toParsed(id, CONTACT, 0.9);
    await buildPlan(id); // → 本物の確認画面スクショ + PENDING_APPROVAL
  }

  step('承認待ち: デモ建設工業（2段フォーム・確認画面）');
  {
    const id = add({ name: 'デモ建設工業株式会社', domain: 'demo-kensetsu.example.jp', industry: '建設', employees: 180, source: 'リクナビ' });
    await toParsed(id, CONTACT, 0.85);
    await buildPlan(id);
  }

  step('承認待ち: デモ物流ソリューションズ（1段フォーム）');
  {
    const id = add({ name: 'デモ物流ソリューションズ株式会社', domain: 'demo-butsuryu.example.jp', industry: '物流', employees: 95, source: '新卒採用' });
    await toParsed(id, SIMPLE, 0.8);
    await buildPlan(id);
  }

  /* ---------------- 3) APPROVED ×1（承認済み・送信待ち） ---------------- */
  step('承認済み: デモ小売チェーン（人が承認済み・送信待ち）');
  {
    const id = add({ name: 'デモ小売チェーン株式会社', domain: 'demo-kouri.example.jp', industry: '小売', employees: 450, source: 'マイナビ' });
    await toParsed(id, CONTACT, 0.88);
    await buildPlan(id);
    approve(id, approver); // PENDING_APPROVAL → APPROVED
  }

  /* ---------------- 4) SUBMITTED_SUCCESS ×1（ローカルフォームへ実送信） ---------------- */
  step('送信成功: デモ製造テック（承認→実送信→成功判定まで通す）');
  {
    const id = add({ name: 'デモ製造テック株式会社', domain: 'demo-seizo.example.jp', industry: '製造', employees: 260, source: 'エントリー' });
    await toParsed(id, SIMPLE, 0.86);
    await buildPlan(id);
    approve(id, approver);
    await runExecute(id); // APPROVED → SUBMITTING → SUBMITTED_SUCCESS（成功なら markSent）
  }

  /* ---------------- 5) SUBMITTED_FAILED ×1（デモ用に失敗結果を注入） ---------------- */
  step('送信失敗: デモ飲食グループ（送信後に完了ページを検出できず＝要調査）');
  {
    const id = add({ name: 'デモ飲食グループ株式会社', domain: 'demo-inshoku.example.jp', industry: '飲食', employees: 70, source: 'リクナビ' });
    // ブラウザは使わず、手組みの schema で PARSED まで進める。
    transition(id, 'DISCOVERING');
    companies.setForm(id, CONTACT, 0.6);
    transition(id, 'FORM_FOUND');
    transition(id, 'PARSING');
    const failSchema: FormSchema = {
      formUrl: CONTACT,
      formSelector: 'form',
      fields: [],
      mappings: [
        { role: 'company', selector: '#company', confidence: 0.7, source: 'rule' },
        { role: 'email', selector: '#email', confidence: 0.7, source: 'rule' },
        { role: 'message', selector: '#message', confidence: 0.7, source: 'rule' },
      ],
      hasConfirmScreen: true,
      hasCaptcha: 'none',
      hasHoneypot: true,
      noSalesPolicy: false,
      mappingConfidence: 0.62,
      gate: 'low',
    };
    fieldMaps.save(id, failSchema);
    transition(id, 'PARSED');
    transition(id, 'PLAN_READY');
    const subId = submissions.createPlan({
      companyId: id,
      contentRendered: 'デモ飲食グループ株式会社 採用ご担当者様\n\nネオキャリア株式会社の福井です。（デモ文面）',
      planScreenshotUrl: null,
    });
    transition(id, 'PENDING_APPROVAL');
    transition(id, 'APPROVED', { actor: approver });
    submissions.approve(subId, approver);
    transition(id, 'SUBMITTING');
    submissions.setResult(subId, 'failed', 'デモ: 送信後に完了ページを検出できず（要調査）');
    transition(id, 'SUBMITTED_FAILED', { detail: 'demo failure injected' });
  }

  /* ---------------- 6) SUPPRESSED ×1（競合ATS導入済み → ハード抑制） ---------------- */
  step('抑制: 競合ATS導入済み（L0 で competitor 判定 → SUPPRESSED）');
  {
    const row: IngestRow = { name: '競合ATS導入済み株式会社', domain: 'demo-herp.example.jp', industry: '製造', employees: 500, source: 'HERP' };
    const { score, excluded } = scoreIcp(row, icp); // excluded=true, score=0
    const c = companies.upsert({ name: row.name, domain: row.domain, source: row.source, icpScore: score });
    if (excluded) {
      suppression.add(row.domain, 'competitor');
      audit.log({ companyId: c.id, layer: 'L0', action: 'suppress:competitor', detail: row.name });
      transition(c.id, 'SUPPRESSED', { force: true, detail: 'competitor/exclude at ingest' });
    }
  }

  /* ---------------- 7) FORM_NOT_FOUND ×1 ---------------- */
  step('フォーム未検出: デモ食品メーカー（DNS到達不可・メールのみ 等の想定内ケース）');
  {
    const id = add({ name: 'デモ食品メーカー株式会社', domain: 'demo-foods.example.jp', industry: '製造', employees: 140, source: 'マイナビ' });
    transition(id, 'DISCOVERING');
    transition(id, 'FORM_NOT_FOUND', { detail: 'no confirmed form (demo)' });
    audit.log({ companyId: id, layer: 'L1', action: 'form_not_found' });
  }

  /* ---------------- 8) NEW ×1（未処理・discover から試せる） ---------------- */
  step('新規: デモ新規リード（未処理。npm run cli -- discover から試せる）');
  add({ name: 'デモ新規リード株式会社', domain: 'demo-newlead.example.jp', industry: 'サービス', employees: 210, source: '新卒' });

  /* ---------------- 完了サマリ ---------------- */
  const all = companies.all();
  const counts = new Map<string, number>();
  for (const c of all) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  console.log('\n=== 投入完了：状態別件数 ===');
  for (const [s, k] of [...counts.entries()].sort()) console.log(`  ${s.padEnd(20)} ${k}`);
  console.log(`  ${'TOTAL'.padEnd(20)} ${all.length}`);
  console.log('\n次の一手:');
  console.log('  npm run serve                 → 承認ダッシュボード（承認待ちにスクショが出ます）');
  console.log('  npm run cli -- status         → 状態別件数');
  console.log('  npm run cli -- pending        → 承認待ち一覧（スクショパス）');
  console.log('  npm run cli -- report         → artifacts/report.csv 出力');

  if (ownServer) ownServer.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
