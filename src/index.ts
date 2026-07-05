#!/usr/bin/env node
import { Command } from 'commander';
import { companies } from './db/repositories.js';
import { ingestCsv } from './layers/l0_list.js';
import { discoverAndParse, buildPlan, runExecute } from './pipeline/pipeline.js';
import { listPending, approve, reject, suppressCompany } from './pipeline/approval.js';
import { exportReport, exportSuppression } from './layers/l6_record.js';
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
  .argument('<csv>', 'CSV file of [name, domain, industry?, employees?, source?]')
  .description('L0 — ingest an ICP list and score it')
  .action((csv: string) => {
    const r = ingestCsv(csv);
    console.log(`Ingested=${r.ingested} suppressed=${r.suppressed} skipped=${r.skipped}`);
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
  .command('plan')
  .description('L3+L4(Plan) — build dry-run plans for PARSED companies')
  .option('-l, --limit <n>', 'max companies', '50')
  .option('--auto-high', 'route gate=high straight to SUBMITTING (full-auto)', false)
  .action(async (o: { limit: string; autoHigh: boolean }) => {
    const batch = companies.byStatus('PARSED', Number(o.limit));
    log.info(`planning ${batch.length} companies (autoHigh=${o.autoHigh})`);
    for (const c of batch) {
      await buildPlan(c.id, { autoHighGate: o.autoHigh }).catch((e) =>
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
  .description('L6 — export CSV report + suppression list')
  .action(() => {
    const r = exportReport();
    const s = exportSuppression();
    console.log(`report: ${r}\nsuppression: ${s}`);
  });

program
  .command('status')
  .description('show pipeline state counts')
  .action(() => printStatus());

function printStatus(): void {
  const all = companies.all();
  const counts = new Map<CompanyStatus, number>();
  for (const c of all) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  console.log('\n=== pipeline status ===');
  for (const [status, n] of [...counts.entries()].sort()) console.log(`  ${status.padEnd(20)} ${n}`);
  console.log(`  ${'TOTAL'.padEnd(20)} ${all.length}\n`);
}

program.parseAsync(process.argv);
