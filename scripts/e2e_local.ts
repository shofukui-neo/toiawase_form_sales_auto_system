/**
 * P0 E2E: drives discover(assumed)->parse->render->Plan->Execute against the
 * local test server. Verifies the whole L2-L5 path including:
 *   - field mapping (company/name/email/message)
 *   - honeypot detection & non-fill (the server rejects if the honeypot is filled)
 *   - confirm-screen handling in Plan (screenshot) and Execute (confirm->send)
 *   - success judgment (L5)
 * No external network; safe to run in CI.
 */

// Sender identity must be set before config is imported (config reads env at load).
process.env.SENDER_COMPANY ||= 'ネオキャリア株式会社';
process.env.SENDER_PERSON ||= '福井 翔';
process.env.SENDER_EMAIL ||= 'sho.fukui@example.com';
process.env.SENDER_PHONE ||= '03-1234-5678';
process.env.SENDER_KANA_SEI ||= 'フクイ';
process.env.SENDER_KANA_MEI ||= 'ショウ';
process.env.SENDER_POSTAL ||= '150-0043';
process.env.HEADLESS ||= 'true';
process.env.LOG_LEVEL ||= 'info';

import type { CompanyRow } from '../src/types.js';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${extra ? ' — ' + extra : ''}`);
}

async function main() {
  const { startServer } = await import('./test_form_server.js');
  const { parseForm } = await import('../src/layers/l2_parsing.js');
  const { renderContent } = await import('../src/layers/l3_content.js');
  const { planSubmission, executeSubmission } = await import('../src/layers/l4_submit.js');

  const { server, url } = await startServer(0);
  console.log(`test server: ${url}`);

  const mkCompany = (id: number): CompanyRow => ({
    id,
    name: 'テスト株式会社',
    domain: '127.0.0.1',
    icp_score: 0.7,
    source: 'e2e',
    status: 'FORM_FOUND',
    form_url: `${url}/contact`,
    form_confidence: 0.9,
    created_at: '',
    updated_at: '',
  });

  try {
    /* ---------- 2-step form (confirm screen) ---------- */
    console.log('\n[case] 2-step form with confirm screen + honeypot');
    const schema = await parseForm({ formUrl: `${url}/contact`, formConfidence: 0.9 });
    const roles = new Set(schema.mappings.map((m) => m.role));
    check('mapped company', roles.has('company'));
    check('mapped name', roles.has('name'));
    check('mapped email', roles.has('email'));
    check('mapped message', roles.has('message'));
    check('detected confirm screen', schema.hasConfirmScreen === true);
    check('detected honeypot', schema.hasHoneypot === true);
    check('honeypot NOT mapped', !schema.mappings.some((m) => /url_check/.test(m.selector)));
    check('gate computed', ['high', 'mid', 'low', 'block'].includes(schema.gate), `gate=${schema.gate}`);

    const company = mkCompany(1001);
    const content = renderContent(company, schema);
    check('content has company name', content.body.includes('テスト株式会社'));
    check('content has sender company', content.body.includes(process.env.SENDER_COMPANY!));

    const plan = await planSubmission(company, schema, content);
    const fs = await import('node:fs');
    check('plan screenshot written', fs.existsSync(plan.screenshotPath), plan.screenshotPath);
    check('plan reached confirm screen', plan.reachedConfirmScreen === true, `strategy=${plan.strategy}`);

    const exec = await executeSubmission(company, schema, content);
    check('execute succeeded (2-step)', exec.judgment.status === 'submitted_success', exec.judgment.detail);

    /* ---------- split-field form (課題A/B/D) ---------- */
    console.log('\n[case] split-field form (姓名/セイメイ/郵便2分割/電話3分割/メール確認)');
    const schemaS = await parseForm({ formUrl: `${url}/split`, formConfidence: 0.9 });
    const rolesS = new Set(schemaS.mappings.map((m) => m.role));
    for (const r of ['company', 'name_sei', 'name_mei', 'kana_sei', 'kana_mei', 'postal1', 'postal2', 'phone1', 'phone2', 'phone3', 'email', 'email_confirm', 'message']) {
      check(`split: mapped ${r}`, rolesS.has(r as any), [...rolesS].join(','));
    }
    check('split: gate not low/block on required', schemaS.gate === 'high' || schemaS.gate === 'mid', `gate=${schemaS.gate}`);
    const companyS = { ...mkCompany(1003), form_url: `${url}/split` };
    const contentS = renderContent(companyS, schemaS);
    check('split: phone split into 3 parts', contentS.values.phone1 === '03' && contentS.values.phone2 === '1234' && contentS.values.phone3 === '5678', `${contentS.values.phone1}/${contentS.values.phone2}/${contentS.values.phone3}`);
    check('split: name split', contentS.values.name_sei === '福井' && contentS.values.name_mei === '翔');
    check('split: kana from config', contentS.values.kana_sei === 'フクイ' && contentS.values.kana_mei === 'ショウ');
    check('split: email_confirm == email', contentS.values.email_confirm === contentS.values.email);
    const choiceMaps = schemaS.mappings.filter((m) => m.role === 'choice');
    check('split: required select+radio auto-selected (2 choices)', choiceMaps.length === 2, choiceMaps.map((m) => m.value).join(','));
    check('split: choice picked neutral values (その他/法人)', choiceMaps.some((m) => m.value === 'その他') && choiceMaps.some((m) => m.value === '法人'));
    check('split: confident choices keep gate=high (no ambiguity)', schemaS.ambiguousChoice === false && schemaS.gate === 'high', `gate=${schemaS.gate} ambiguous=${schemaS.ambiguousChoice}`);
    const execS = await executeSubmission(companyS, schemaS, contentS);
    check('split: execute succeeded (all parts validated server-side)', execS.judgment.status === 'submitted_success', execS.judgment.detail);

    /* ---------- 1-step form (direct submit) ---------- */
    console.log('\n[case] 1-step form (no confirm screen)');
    const schema2 = await parseForm({ formUrl: `${url}/simple`, formConfidence: 0.9 });
    check('1-step: no confirm screen', schema2.hasConfirmScreen === false);
    const company2 = { ...mkCompany(1002), form_url: `${url}/simple` };
    const content2 = renderContent(company2, schema2);
    const plan2 = await planSubmission(company2, schema2, content2);
    check('1-step plan filled-only', plan2.strategy === 'filled-only', `strategy=${plan2.strategy}`);
    const exec2 = await executeSubmission(company2, schema2, content2);
    check('execute succeeded (1-step)', exec2.judgment.status === 'submitted_success', exec2.judgment.detail);
  } finally {
    server.close();
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
