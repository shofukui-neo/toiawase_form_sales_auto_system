#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { companies, outcomes, type OutcomeKind } from './db/repositories.js';
import { ingestCsv, ingestCsvWithResolve, parseCompaniesCsv } from './layers/l0_list.js';
import { resolveHomepage } from './layers/l0_homepage.js';
import { discoverAndIngestCompanyRows } from './layers/l0_autodiscovery.js';
import { discoverAndParse, buildPlan, runExecute, reparse } from './pipeline/pipeline.js';
import { listPending, approve, reject, suppressCompany } from './pipeline/approval.js';
import { exportReport, exportSuppression } from './layers/l6_record.js';
import { formatFunnel } from './pipeline/funnel.js';
import { assignVariant, experimentWarnings } from './pipeline/experiment.js';
import { formatRound, learn, resetLearningCache } from './pipeline/learning.js';
import { activeVariants, allVariants, setVariantStatus, templateProblems, type VariantStatus } from './pipeline/variants.js';
import { importReplies } from './pipeline/replyImport.js';
import { preflight, formatPreflight } from './pipeline/preflight.js';
import { transition } from './core/stateMachine.js';
import { nextSendDelayMs } from './crosscutting/pacing.js';
import type { CompanyStatus, SuppressionReason } from './types.js';
import { logger } from './utils/logger.js';

const log = logger('cli');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const program = new Command();
program
  .name('toiawase')
  .description('MOCHICA form-sales automation pipeline (spec v0.1)')
  .version('0.1.0');

program
  .command('ingest')
  .argument('<csv>', 'CSV of [name, domain?, industry?, employees?, prefecture?, source?]')
  .option('--resolve', 'auto-discover the HP for rows missing a domain (web search)', false)
  .option('--accept-unverified', 'with --resolve, also ingest domains we could not verify', false)
  .description('L0 — ingest an ICP list and score it (--resolve to auto-find missing HPs)')
  .action(async (csv: string, o: { resolve: boolean; acceptUnverified: boolean }) => {
    if (o.resolve) {
      const r = await ingestCsvWithResolve(csv, {
        acceptUnverified: o.acceptUnverified,
        onProgress: (m) => log.info(m),
      });
      console.log(
        `Ingested=${r.ingested} suppressed=${r.suppressed} skipped=${r.skipped} ` +
          `(hadDomain=${r.hadDomain} resolved=${r.resolved} unresolved=${r.unresolved.length})`,
      );
      for (const u of r.unresolved) {
        console.log(`  ! unresolved: ${u.name} — ${u.reason}${u.candidate ? ` (candidate: ${u.candidate})` : ''}`);
      }
    } else {
      const r = ingestCsv(csv);
      console.log(`Ingested=${r.ingested} suppressed=${r.suppressed} skipped=${r.skipped}`);
    }
  });

program
  .command('resolve')
  .argument('<file>', 'CSV/TXT of company names (one per line, or name,industry,prefecture)')
  .option('-o, --out <path>', 'write the resolved [name,domain,...] CSV here')
  .option('--accept-unverified', 'keep unverified candidates in the output', false)
  .option('--ingest', 'also ingest the resolved rows into the pipeline', false)
  .description('L0 拡張 — resolve official HPs for a name list (企業HPを自動探索)')
  .action(async (file: string, o: { out?: string; acceptUnverified: boolean; ingest: boolean }) => {
    const rows = parseCompaniesCsv(readFileSync(file, 'utf8'));
    log.info(`resolving HP for ${rows.length} companies…`);
    const out: string[] = ['name,domain,industry,prefecture,source,confidence,method'];
    let ok = 0;
    for (const row of rows) {
      if (row.domain) {
        out.push([row.name, row.domain, row.industry ?? '', row.prefecture ?? '', row.source ?? 'given', '1', 'given'].map(csvCell).join(','));
        ok++;
        continue;
      }
      const hp = await resolveHomepage(row.name, { industry: row.industry, prefecture: row.prefecture }).catch(() => null);
      const verified = hp && (hp.method === 'search+verified' || o.acceptUnverified);
      if (hp) {
        console.log(`  ${verified ? '✓' : '?'} ${row.name} -> ${hp.domain} (${hp.method}, conf=${hp.confidence})`);
      } else {
        console.log(`  ✗ ${row.name} -> (not found)`);
      }
      if (verified && hp) {
        out.push([row.name, hp.domain, row.industry ?? '', row.prefecture ?? '', 'hp_auto', String(hp.confidence), hp.method].map(csvCell).join(','));
        ok++;
      }
    }
    const csvText = out.join('\n') + '\n';
    if (o.out) {
      writeFileSync(o.out, csvText, 'utf8');
      console.log(`\nWrote ${ok}/${rows.length} resolved rows -> ${o.out}`);
    } else {
      console.log('\n' + csvText);
    }
    if (o.ingest && o.out) {
      const r = ingestCsv(o.out);
      console.log(`Ingested=${r.ingested} suppressed=${r.suppressed} skipped=${r.skipped}`);
    }
  });

program
  .command('discover-auto')
  .description('L0 autonomous discovery — generate candidate companies from search and ingest them')
  .option('--query <query...>', 'custom search queries to use')
  .option('--industry <industry...>', 'industry seed terms to build queries from')
  .option('--prefecture <prefecture...>', 'prefecture seed terms to build queries from')
  .option('--max-companies <n>', 'max companies to ingest', '200')
  .option('--max-results <n>', 'max search results per query', '5')
  .option('--query-delay <ms>', 'delay between search queries', '1200')
  .option('--discover', 'run L1/L2 on newly ingested companies', false)
  .option('--plan', 'run L3/L4 plan on parsed companies after discovery', false)
  .option('--auto-high', 'auto-route gate=high companies to SUBMITTING during plan', false)
  .action(async (o: {
    query?: string[];
    industry?: string[];
    prefecture?: string[];
    maxCompanies: string;
    maxResults: string;
    queryDelay: string;
    discover: boolean;
    plan: boolean;
    autoHigh: boolean;
  }) => {
    const opts = {
      queries: o.query,
      industries: o.industry,
      prefectures: o.prefecture,
      maxCompanies: Number(o.maxCompanies),
      maxResultsPerQuery: Number(o.maxResults),
      queryDelayMs: Number(o.queryDelay),
    };
    const { rows, result } = await discoverAndIngestCompanyRows(opts);
    console.log(`discovered ${rows.length} candidates; ingested=${result.ingested} suppressed=${result.suppressed} skipped=${result.skipped}`);

    if (o.discover && result.companyIds.length > 0) {
      log.info(`discovering ${result.companyIds.length} newly ingested companies`);
      for (const id of result.companyIds) {
        await discoverAndParse(id).catch((e) => log.error(`company ${id}: ${e.message}`));
      }
    }

    if (o.plan) {
      const parsed = result.companyIds
        .map((id) => companies.byId(id))
        .filter((c): c is NonNullable<ReturnType<typeof companies.byId>> => !!c && c.status === 'PARSED');
      log.info(`planning ${parsed.length} companies (autoHigh=${o.autoHigh})`);
      for (const c of parsed) {
        await buildPlan(c.id, { autoHighGate: o.autoHigh }).catch((e) => log.error(`company ${c.id}: ${e.message}`));
      }
    }

    printStatus();
  });

program
  .command('discover')
  .description('L1+L2 — discover & parse forms for NEW companies')
  .option('-l, --limit <n>', 'max companies to process', '50')
  .action(async (o: { limit: string }) => {
    const batch = companies.byStatus('NEW', Number(o.limit));
    log.info(`discovering ${batch.length} companies`);
    for (const c of batch) {
      await discoverAndParse(c.id).catch((e) => log.error(`company ${c.id}: ${e.message}`));
    }
    printStatus();
  });

program
  .command('reparse')
  .description('L2 再解析 — 解析済みフォームを現行マッパーで解析し直す（L2改修後の移行用）')
  .option('-l, --limit <n>', 'max companies to process', '200')
  .option('--include-suppressed', '「非適格」で自動除外された企業もキューに戻す', false)
  .action(async (o: { limit: string; includeSuppressed: boolean }) => {
    const limit = Number(o.limit);
    // 送信済み(SUBMITTED_SUCCESS)/送信中は対象外。二重送信の経路を作らない (§9)。
    const batch = companies
      .all()
      .filter((c) => c.form_url && (o.includeSuppressed || c.status !== 'SUPPRESSED'))
      .slice(0, limit);
    log.info(`reparsing ${batch.length} companies (includeSuppressed=${o.includeSuppressed})`);
    const tally = { reparsed: 0, skipped: 0, failed: 0 };
    for (const c of batch) {
      const r = await reparse(c.id, { includeSuppressed: o.includeSuppressed });
      tally[r]++;
    }
    log.info(`reparsed=${tally.reparsed} skipped=${tally.skipped} failed=${tally.failed}`);
    log.info('次に `plan` を実行すると、新しいマッピングでプレビューが作り直されます。');
    printStatus();
  });

program
  .command('plan')
  .description('L3+L4(Plan) — build dry-run plans for PARSED companies')
  .option('-l, --limit <n>', 'max companies', '50')
  .option('--no-auto-high', 'do not route gate=high straight to SUBMITTING', false)
  .action(async (o: { limit: string; noAutoHigh: boolean }) => {
    const batch = companies.byStatus('PARSED', Number(o.limit));
    const autoHigh = !o.noAutoHigh;
    log.info(`planning ${batch.length} companies (autoHigh=${autoHigh})`);
    for (const c of batch) {
      await buildPlan(c.id, { autoHighGate: autoHigh }).catch((e) =>
        log.error(`company ${c.id}: ${e.message}`),
      );
    }
    printStatus();
  });

program
  .command('pending')
  .description('list companies awaiting human approval (half-auto gate)')
  .action(() => {
    const items = listPending();
    if (items.length === 0) return console.log('(no pending approvals)');
    for (const it of items) {
      console.log(
        `\n#${it.companyId} ${it.name} [${it.domain}] gate=${it.gate} conf=${it.mappingConfidence}`,
      );
      console.log(`  form: ${it.formUrl}`);
      console.log(`  screenshot: ${it.screenshot}`);
      console.log(`  body: ${(it.renderedBody ?? '').slice(0, 80).replace(/\n/g, ' ')}...`);
      console.log(`  approve: toiawase approve ${it.companyId}   reject: toiawase reject ${it.companyId}`);
    }
  });

program
  .command('approve')
  .argument('<companyId>', 'company id')
  .option('--by <email>', 'approver', process.env.USER_EMAIL || 'operator')
  .description('approve a pending plan (half-auto)')
  .action((id: string, o: { by: string }) => {
    approve(Number(id), o.by);
    console.log(`approved #${id} by ${o.by}`);
  });

program
  .command('reject')
  .argument('<companyId>', 'company id')
  .option('--by <email>', 'approver', process.env.USER_EMAIL || 'operator')
  .option('--note <text>', 'reason', '')
  .description('reject a pending plan')
  .action((id: string, o: { by: string; note: string }) => {
    reject(Number(id), o.by, o.note);
    console.log(`rejected #${id}`);
  });

program
  .command('suppress')
  .argument('<companyId>', 'company id')
  .argument('<reason>', 'already_sent|opt_out|no_sales_policy|competitor')
  .option('--by <email>', 'actor', process.env.USER_EMAIL || 'operator')
  .description('manually suppress a company')
  .action((id: string, reason: string, o: { by: string }) => {
    suppressCompany(Number(id), reason as SuppressionReason, o.by);
    console.log(`suppressed #${id} (${reason})`);
  });

program
  .command('execute')
  .description('L4(Execute)+L5 — send approved/high-gate companies (paced)')
  .option('--id <companyId>', 'execute a single company')
  .option('-l, --limit <n>', 'max sends this run', '50')
  .action(async (o: { id?: string; limit: string }) => {
    let batch = o.id
      ? [companies.byId(Number(o.id))!].filter(Boolean)
      : [...companies.byStatus('APPROVED', Number(o.limit)), ...companies.byStatus('SUBMITTING', Number(o.limit))];
    batch = batch.slice(0, Number(o.limit));
    log.info(`executing ${batch.length} companies`);
    for (let i = 0; i < batch.length; i++) {
      await runExecute(batch[i].id).catch((e) => log.error(`company ${batch[i].id}: ${e.message}`));
      if (i < batch.length - 1) {
        const d = nextSendDelayMs();
        log.info(`pacing: sleeping ${(d / 1000).toFixed(0)}s before next send`);
        await sleep(d);
      }
    }
    printStatus();
  });

program
  .command('report')
  .description('L6 — export CSV report + suppression list (--sheets to also sync to Google Sheets)')
  .option('--sheets', 'also sync report + suppression to the configured Google Sheet', false)
  .action(async (o: { sheets: boolean }) => {
    const r = exportReport();
    const s = exportSuppression();
    console.log(`report: ${r}\nsuppression: ${s}`);
    if (o.sheets) {
      const { syncSheets } = await import('./layers/l6_sheets.js');
      const res = await syncSheets();
      console.log(res.synced ? `Sheets: synced report=${res.reportRows} suppression=${res.suppressionRows}` : `Sheets: skipped (${res.reason})`);
    }
  });

program
  .command('preflight')
  .description('送信前の点検 — 名乗り・文面・割り当て・証拠・記録が揃っているか')
  .action(() => {
    const checks = preflight();
    console.log(formatPreflight(checks));
    if (checks.some((c) => c.level === 'ng')) process.exitCode = 1;
  });

program
  .command('import-replies')
  .description('受信メールから返信・アポを取り込む（自動返信は除外）')
  .argument('<path>', '.eml を置いたディレクトリ、単一の .eml、または CSV(from,subject,date,body)')
  .option('--apply', '実際に記録する（既定は確認のみ）', false)
  .action((path: string, o: { apply: boolean }) => {
    const r = importReplies(path, { apply: o.apply });
    for (const line of r.lines) console.log(line);
    console.log('');
    console.log(`=== ${r.total} 通 ===`);
    for (const [k, n] of Object.entries(r.byKind)) console.log(`  ${k.padEnd(12)} ${n}`);
    console.log(`自動返信として除外: ${r.autoReplies}`);
    console.log(`企業を特定できず  : ${r.unmatched}`);
    if (o.apply) {
      console.log(`記録した反応      : ${r.recorded}`);
      console.log('`toiawase funnel` で文面パターン別の返信率・アポ率を確認できます。');
      // 反応が入ったら即座に学習し直す。次に送る企業から新しい配分になる。
      console.log('');
      console.log(formatRound(learn({ apply: true })));
    } else {
      console.log('確認のみ（記録していません）。--apply を付けると記録します。');
    }
  });

program
  .command('experiment')
  .description('文面の割り当て状況 — 配信中の文面と、承認待ちの企業が学習した配分でどう割れるか')
  .option('--sample <n>', '割り当てを確認する件数', '2000')
  .action((o: { sample: string }) => {
    for (const w of experimentWarnings()) console.log(`⚠ ${w}`);
    const round = learn({ apply: true });
    console.log('');
    console.log('=== 配信中の文面 ===');
    for (const v of activeVariants()) {
      const share = round.weights[v.name];
      console.log(`  ${v.name.padEnd(14)} ${v.template.padEnd(22)} 配分 ${share ? `${(share * 100).toFixed(1)}%` : '—'}  ${v.hypothesis}`);
    }
    const pending = companies.byStatus('PENDING_APPROVAL', Number(o.sample));
    const counts = new Map<string, number>();
    for (const c of pending) {
      const n = assignVariant(c.id).name;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    console.log('');
    console.log(`=== 承認待ち ${pending.length} 社の割り当て ===`);
    for (const v of activeVariants()) {
      const n = counts.get(v.name) ?? 0;
      const pct = pending.length ? ((n / pending.length) * 100).toFixed(1) : '0.0';
      console.log(`  ${v.name.padEnd(14)} ${String(n).padStart(5)} 社  ${pct}%`);
    }
    console.log('');
    console.log('配分は送信・反応が増えるたびに自動で引き直されます（`toiawase learn` で根拠を表示）。');
  });

program
  .command('learn')
  .description('文面の学習（PDCA）— 結果を集計し、配分を更新し、負けた文面を外す。--generate で次の挑戦者文面を下書き')
  .option('--dry-run', '集計と判断だけ表示し、状態は変えない', false)
  .option('--generate', '結果を読んで、変更点を一つにした挑戦者文面を LLM で下書きする（配信は承認後）', false)
  .option('--parent <name>', '挑戦者の親にする文面（既定: 最良である確率が最も高い文面）')
  .action(async (o: { dryRun: boolean; generate: boolean; parent?: string }) => {
    const round = learn({ apply: !o.dryRun });
    console.log(formatRound(round));
    if (o.dryRun) console.log('\n（--dry-run: 状態の変更と記録はしていません）');
    if (!o.generate) return;

    console.log('\n=== 挑戦者文面の生成 ===');
    const { generateChallenger } = await import('./pipeline/challenger.js');
    const r = await generateChallenger({ parent: o.parent, dryRun: o.dryRun });
    if (!r.ok) {
      console.log('✗ 使える下書きになりませんでした:');
      for (const p of r.problems) console.log(`  - ${p}`);
      process.exitCode = 1;
      return;
    }
    if (r.variant) {
      console.log(`✓ 下書き ${r.variant.name}（親: ${r.variant.parent}）を config/templates/${r.variant.template}.md に保存`);
      console.log(`  仮説: ${r.variant.hypothesis}`);
    } else {
      console.log(`（--dry-run のため保存していません）変更点: ${r.change}`);
    }
    console.log('\n--- 本文（サンプル企業で描画） ---');
    console.log(r.body);
    if (r.variant) console.log(`\n内容を確認し、問題なければ 'toiawase variant activate ${r.variant.name}' で配信に入ります。`);
  });

program
  .command('variant')
  .description('文面パターンの一覧・状態変更（list | activate | pause | retire <name>）')
  .argument('<action>', 'list | activate | pause | retire')
  .argument('[name]', '文面パターン名')
  .option('--reason <text>', '変更の理由（記録に残る）')
  .action((action: string, name: string | undefined, o: { reason?: string }) => {
    if (action === 'list') {
      for (const v of allVariants()) {
        console.log(
          `${v.name.padEnd(16)} ${v.status.padEnd(8)} ${v.template.padEnd(24)} 親=${(v.parent ?? '-').padEnd(10)} ${v.hypothesis}` +
            (v.statusReason ? `\n${''.padEnd(26)}└ ${v.statusReason}` : ''),
        );
      }
      return;
    }
    const map: Record<string, VariantStatus> = { activate: 'active', pause: 'paused', retire: 'retired' };
    const status = map[action];
    if (!status || !name) {
      console.error('使い方: toiawase variant list | activate|pause|retire <name>');
      process.exitCode = 1;
      return;
    }
    const v = allVariants().find((x) => x.name === name);
    if (!v) {
      console.error(`文面パターン ${name} が見つかりません`);
      process.exitCode = 1;
      return;
    }
    if (status === 'active') {
      // 人の承認でも、実在の相手に届く条件を満たさない文面は入れない。
      const { problems } = templateProblems(v.template);
      if (problems.length) {
        console.error(`✗ 配信に入れられません: ${problems.join(' / ')}`);
        process.exitCode = 1;
        return;
      }
    }
    if (status !== 'active' && v.status === 'active' && activeVariants().length <= 1) {
      console.error('✗ 配信中の文面が無くなるため止められません。先に別の文面を activate してください。');
      process.exitCode = 1;
      return;
    }
    setVariantStatus(name, status, o.reason ?? `手動: ${action}`, 'human');
    resetLearningCache();
    console.log(`${name}: ${v.status} → ${status}`);
    console.log(formatRound(learn({ apply: true })));
  });

program
  .command('funnel')
  .description('アポ率ファネル — 送信 → 到達 → 返信 → アポ を文面パターン別に集計')
  .option('--days <n>', '直近 N 日に絞る')
  .action((o: { days?: string }) => {
    console.log(formatFunnel(o.days ? Number(o.days) : undefined));
  });

program
  .command('outcome')
  .description('送信の「その後」を記録する — これを入れない限りアポ率は測れない')
  .argument('<companyId>', '企業ID')
  .argument('<kind>', 'reply | appointment | refusal | optout | bounce')
  .option('--note <text>', 'メモ（返信の要旨など）')
  .option('--source <src>', '観測元 (inbox/manual/booking/phone)', 'manual')
  .option('--at <datetime>', '実際に起きた日時 (YYYY-MM-DD HH:MM)')
  .action((companyId: string, kind: string, o: { note?: string; source: string; at?: string }) => {
    const allowed: OutcomeKind[] = ['reply', 'appointment', 'refusal', 'optout', 'bounce'];
    if (!allowed.includes(kind as OutcomeKind)) {
      console.error(`kind は次のいずれか: ${allowed.join(' | ')}`);
      process.exitCode = 1;
      return;
    }
    const id = Number(companyId);
    const company = companies.byId(id);
    if (!company) {
      console.error(`企業 ${id} が見つかりません`);
      process.exitCode = 1;
      return;
    }
    outcomes.record({
      companyId: id,
      kind: kind as OutcomeKind,
      source: o.source,
      note: o.note ?? null,
      occurredAt: o.at ?? null,
    });
    // アポは選考の終点なので企業の状態にも反映する（返信済みとして扱う）。
    if ((kind === 'reply' || kind === 'appointment') && company.status === 'SUBMITTED_SUCCESS') {
      transition(id, 'REPLIED', { actor: 'human', detail: `outcome:${kind}` });
    }
    console.log(`記録: 企業 ${id} (${company.name}) → ${kind}`);
    const round = learn({ apply: true });
    const shares = Object.entries(round.weights)
      .map(([n, w]) => `${n} ${(w * 100).toFixed(1)}%`)
      .join(' / ');
    console.log(`学習を更新: 次の配分 ${shares}`);
    for (const a of round.actions.filter((x) => x.kind === 'retire' || x.kind === 'pause')) {
      console.log(`  [${a.kind === 'retire' ? '引退' : '停止'}] ${a.variant}: ${a.reason}`);
    }
  });

program
  .command('intake')
  .description('リスト取り込みジョブの状況表示 / 中断したジョブの再開（3万件規模の分割処理）')
  .option('--resume', '未完了のジョブを続きから再開する', false)
  .option('--job <id>', '対象ジョブID（既定: 直近の未完了ジョブ）')
  .option('--auto-send', '再開と同時に随時送信も走らせる（全項目クリアの企業のみ）', false)
  .option('--no-auto-send', '保存されている随時送信の設定をオフにして再開する')
  .action(async (o: { resume: boolean; job?: string; autoSend?: boolean }) => {
    const { intakeStatus, resumeIntake } = await import('./pipeline/intake.js');
    if (o.resume) {
      // commander は --auto-send / --no-auto-send のどちらも指定されなければ
      // 既定値 false を渡してくる。明示された時だけジョブの設定を上書きする。
      const explicit = process.argv.some((a) => a === '--auto-send' || a === '--no-auto-send');
      const r = resumeIntake(
        o.job ? Number(o.job) : undefined,
        explicit ? { autoSend: o.autoSend === true, autoSendActor: 'auto:cli' } : undefined,
      );
      console.log(`ジョブ #${r.jobId} を再開しました（全 ${r.total} 行）`);
      // Keep the process alive until the job settles. 取り込みと発見処理は
      // 並走するので、2つの進捗を並べて出す。
      let last = '';
      for (;;) {
        const s = intakeStatus();
        if (!s.running) break;
        const line =
          `  読み込み ${s.ingestDone}/${s.total}` +
          (s.pipeline ? ` | 発見処理 ${s.done}/${s.pipelineTotal}${s.ingestRunning ? '+' : ''}` : '') +
          ` | 承認待ちへ ${s.pendingApproval}`;
        if (line !== last) { console.log(line); last = line; }
        await sleep(2000);
      }
    }
    const s = intakeStatus();
    if (s.jobId === null) return console.log('取り込みジョブはありません');
    console.log(
      `\n=== 取り込みジョブ #${s.jobId} ===\n` +
        `  状態         ${s.status} (${s.phase})\n` +
        `  読み込み     ${s.ingestDone} / ${s.total} 行\n` +
        `  取り込み     ${s.ingested}（既存スキップ ${s.alreadyKnown} / 除外 ${s.suppressed} / スキップ ${s.skipped}）\n` +
        `  発見処理     ${s.done} / ${s.pipelineTotal}（承認待ち ${s.pendingApproval} / 未発見 ${s.notFound}）\n` +
        (s.status === 'paused' ? `  → 続きから再開: toiawase intake --resume\n` : ''),
    );
  });

program
  .command('serve')
  .description('A — launch the web approval dashboard')
  .option('-p, --port <n>', 'port', '4599')
  .action(async (o: { port: string }) => {
    const { serve } = await import('./web/server.js');
    serve(Number(o.port));
  });

program
  .command('status')
  .description('show pipeline state counts')
  .action(() => printStatus());

/** Quote a CSV cell if it contains a comma, quote, or newline. */
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function printStatus(): void {
  // Counted in SQLite — tallying `companies.all()` in JS silently stopped at the
  // row limit, so a 3万件 DB reported a wrong (and much smaller) total.
  const counts = companies.countsByStatus();
  console.log('\n=== pipeline status ===');
  let total = 0;
  for (const [status, n] of Object.entries(counts).sort()) {
    console.log(`  ${status.padEnd(20)} ${n}`);
    total += n;
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${total}\n`);
}

program.parseAsync(process.argv);
