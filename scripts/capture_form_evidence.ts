import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { discoverForm } from '../src/layers/l1_discovery.js';
import { parseForm } from '../src/layers/l2_parsing.js';
import { renderContent } from '../src/layers/l3_content.js';
import { planSubmission } from '../src/layers/l4_submit.js';
import { companies, fieldMaps } from '../src/db/repositories.js';
import { transition } from '../src/core/stateMachine.js';
import { writeFile } from 'node:fs/promises';

const targets = [
  'コクヨ株式会社',
  'パステムソリューションズ株式会社',
  '康正産業株式会社',
  '株式会社コムリード',
  '株式会社テクノトップ',
  '加賀FEI株式会社',
  'UBE株式会社',
  'エックスサーバー株式会社',
  '東洋警備保障株式会社',
  '三菱電機ソフトウエア株式会社（谷田）',
];

async function main() {
  mkdirSync(config.artifactsDir, { recursive: true });
  const rows: string[] = ['company,form_url,status,gate,screenshot'];
  const all = companies.all();
  for (const c of all.filter((x) => x.name && targets.includes(x.name))) {
    companies.setStatus(c.id, 'NEW');
  }
  for (const name of targets) {
    const company = companies.upsert({ name, domain: `${name.replace(/[^a-z0-9]+/gi, '').toLowerCase()}.example.com`, source: 'manual_evidence' });
    transition(company.id, 'DISCOVERING', { force: true });
    try {
      const disc = await discoverForm(company.domain);
      if (!disc.formUrl) {
        const marker = resolve(config.artifactsDir, `${company.id}_no_form.txt`);
        await writeFile(marker, `company=${name}\nform_url=none\nstatus=FORM_NOT_FOUND\n`);
        rows.push(`${name},,FORM_NOT_FOUND,,${marker}`);
        transition(company.id, 'FORM_NOT_FOUND', { force: true, detail: 'no confirmed form' });
        continue;
      }
      companies.setForm(company.id, disc.formUrl, disc.confidence);
      transition(company.id, 'FORM_FOUND', { force: true, detail: `${disc.method} conf=${disc.confidence}` });
      transition(company.id, 'PARSING', { force: true });
      const schema = await parseForm({ formUrl: disc.formUrl, formConfidence: disc.confidence });
      fieldMaps.save(company.id, schema);
      transition(company.id, 'PARSED', { force: true });
      const content = renderContent(company, schema);
      const plan = await planSubmission(company, schema, content);
      rows.push(`${name},${disc.formUrl},PLAN_READY,${schema.gate},${plan.screenshotPath}`);
      console.log(`[evidence] ${name} -> ${disc.formUrl} (${schema.gate})`);
    } catch (e) {
      const marker = resolve(config.artifactsDir, `${company.id}_error.txt`);
      await writeFile(marker, `company=${name}\nerror=${(e as Error).message}\n`);
      rows.push(`${name},,ERROR,,${marker}`);
      console.error(`[evidence] ${name} failed: ${(e as Error).message}`);
    }
  }

  writeFileSync(resolve(config.artifactsDir, 'form_evidence.csv'), rows.join('\n'));
  console.log(`saved evidence index: ${resolve(config.artifactsDir, 'form_evidence.csv')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
