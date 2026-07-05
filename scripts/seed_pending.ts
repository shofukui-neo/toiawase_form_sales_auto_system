/** Seed one company into PENDING_APPROVAL for dashboard smoke-testing. */
import { resolve } from 'node:path';
import { config } from '../src/config.js';
import { companies, fieldMaps, submissions } from '../src/db/repositories.js';
import { transition } from '../src/core/stateMachine.js';
import type { FormSchema } from '../src/types.js';

const c = companies.upsert({ name: 'デモ介護サービス株式会社', domain: 'demo-kaigo.example.jp', source: 'seed', icpScore: 0.8 });
companies.setForm(c.id, 'https://demo-kaigo.example.jp/contact', 0.9);

const schema: FormSchema = {
  formUrl: 'https://demo-kaigo.example.jp/contact',
  formSelector: 'form',
  fields: [],
  mappings: [
    { role: 'company', selector: '#company', confidence: 0.9, source: 'rule' },
    { role: 'name', selector: '#name', confidence: 0.8, source: 'rule' },
    { role: 'email', selector: '#email', confidence: 0.92, source: 'rule' },
    { role: 'message', selector: '#message', confidence: 0.9, source: 'rule' },
  ],
  hasConfirmScreen: true,
  hasCaptcha: 'none',
  hasHoneypot: true,
  noSalesPolicy: false,
  mappingConfidence: 0.78,
  gate: 'mid',
};

// walk the state machine to PARSED, then create a plan + PENDING_APPROVAL
for (const s of ['DISCOVERING', 'FORM_FOUND', 'PARSING', 'PARSED'] as const) {
  try { transition(c.id, s); } catch { /* already past */ }
}
fieldMaps.save(c.id, schema);
transition(c.id, 'PLAN_READY');
submissions.createPlan({
  companyId: c.id,
  contentRendered: 'デモ介護サービス株式会社 採用ご担当者様\n\nネオキャリア株式会社の福井です。MOCHICA のご案内です…（デモ文面）',
  planScreenshotUrl: resolve(config.artifactsDir, 'plan_1001.png'),
});
transition(c.id, 'PENDING_APPROVAL');
console.log(`seeded company #${c.id} at PENDING_APPROVAL`);
