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
process.env.SENDER_COMPANY = '株式会社ネオキャリア';
process.env.SENDER_PERSON = '福井 聖';
process.env.SENDER_PERSON_ROMAJI = 'Sho Fukui';
process.env.SENDER_EMAIL = 'sho.fukui@example.com';
process.env.SENDER_PHONE = '03-1234-5678';
process.env.SENDER_OFFICE_PHONE = '03-9999-9999';
process.env.SENDER_KANA_SEI = 'フクイ';
process.env.SENDER_KANA_MEI = 'ショウ';
process.env.SENDER_POSTAL = '150-0043';
process.env.SENDER_ADDRESS = '東京都渋谷区道玄坂1-2-3';
process.env.SENDER_DEPARTMENT = '事業開発本部 事業開発部';
process.env.SENDER_OFFICE = '本社';
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
    check('split: name split', contentS.values.name_sei === '福井' && contentS.values.name_mei === '聖');
    check('split: kana from config', contentS.values.kana_sei === 'フクイ' && contentS.values.kana_mei === 'ショウ');
    check('split: email_confirm == email', contentS.values.email_confirm === contentS.values.email);
    const choiceMaps = schemaS.mappings.filter((m) => m.role === 'choice');
    check('split: required select+radio auto-selected (2 choices)', choiceMaps.length === 2, choiceMaps.map((m) => m.value).join(','));
    check('split: choice picked neutral values (その他/法人)', choiceMaps.some((m) => m.value === 'その他') && choiceMaps.some((m) => m.value === '法人'));
    check('split: confident choices keep gate=high (no ambiguity)', schemaS.ambiguousChoice === false && schemaS.gate === 'high', `gate=${schemaS.gate} ambiguous=${schemaS.ambiguousChoice}`);
    const execS = await executeSubmission(companyS, schemaS, contentS);
    check('split: execute succeeded (all parts validated server-side)', execS.judgment.status === 'submitted_success', execS.judgment.detail);

    /* ---------- 住所分割 + カナ接尾辞 + 種別チェックボックス ---------- */
    console.log('\n[case] 住所分割（都道府県/市区町村/番地）+ form_lastKana + 種別チェックボックス群');
    const schemaA = await parseForm({ formUrl: `${url}/address`, formConfidence: 0.9 });
    const rolesA = new Set(schemaA.mappings.map((m) => m.role));
    for (const r of ['company', 'name_sei', 'name_mei', 'kana_sei', 'kana_mei',
      'postal1', 'postal2', 'address_pref', 'address_city', 'address_street', 'email', 'message']) {
      check(`address: mapped ${r}`, rolesA.has(r as any), [...rolesA].join(','));
    }
    const companyA = { ...mkCompany(1004), form_url: `${url}/address` };
    const contentA = renderContent(companyA, schemaA);
    check('address: 都道府県', contentA.values.address_pref === '東京都', contentA.values.address_pref);
    check('address: 市区町村', contentA.values.address_city === '渋谷区', contentA.values.address_city);
    check('address: 番地・マンション名', contentA.values.address_street === '道玄坂1-2-3', contentA.values.address_street);
    check('address: フリガナ セイ/メイ', contentA.values.kana_sei === 'フクイ' && contentA.values.kana_mei === 'ショウ');
    // 同意欄は policy のみ。種別チェックボックス群は agree ではなく choice で1つだけ。
    const agreeA = schemaA.mappings.filter((m) => m.role === 'agree');
    check('address: 同意欄だけが agree', agreeA.length === 1 && /policy/.test(agreeA[0].selector),
      agreeA.map((m) => m.selector).join(','));
    const choiceA = schemaA.mappings.filter((m) => m.role === 'choice');
    check('address: 種別は「その他」1つだけ選択', choiceA.some((m) => m.value === 'その他'),
      choiceA.map((m) => `${m.value}`).join(','));
    const execA = await executeSubmission(companyA, schemaA, contentA);
    check('address: execute succeeded (サーバ側で各欄を個別検証)',
      execA.judgment.status === 'submitted_success', execA.judgment.detail);

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
