/** 送信可否ゲート + /api/sendable の動作確認（ブラウザ・送信なし）。 */
process.env.DB_PATH = './data/smoke-readiness.db';
process.env.SENDER_COMPANY ||= 'ネオキャリア株式会社';
process.env.SENDER_PRODUCT ||= 'MOCHICA';
process.env.SENDER_PERSON ||= '福井 聖';
process.env.SENDER_EMAIL ||= 'sho.fukui@neo-career.co.jp';
process.env.SENDER_PHONE ||= '03-0000-0000';
process.env.LOG_LEVEL ||= 'warn';
process.env.SEND_WINDOW_START = '0';
process.env.SEND_WINDOW_END = '24';

import { rmSync } from 'node:fs';
import type { DetectedField, FormSchema } from '../src/types.js';

async function main() {
  rmSync('./data/smoke-readiness.db', { force: true });
  rmSync('./data/smoke-readiness.db-wal', { force: true });
  rmSync('./data/smoke-readiness.db-shm', { force: true });

  const { companies, fieldMaps, submissions } = await import('../src/db/repositories.js');
  const { transition } = await import('../src/core/stateMachine.js');
  const { sendabilitySnapshot, assessSendReadiness } = await import('../src/pipeline/readiness.js');
  const { createServer } = await import('../src/web/server.js');

  const field = (f: Partial<DetectedField> & { selector: string }): DetectedField => ({
    tag: 'input', type: 'text', name: null, id: null, labelText: null, placeholder: null,
    required: false, honeypot: false, maxLength: null, autocomplete: null, ...f,
  });

  const clean: FormSchema = {
    formUrl: 'https://clean.example.jp/contact',
    formSelector: 'form',
    fields: [
      field({ selector: '#company', labelText: '会社名', required: true }),
      field({ selector: '#name', labelText: 'お名前', required: true }),
      field({ selector: '#email', labelText: 'メールアドレス', type: 'email', required: true }),
      field({ selector: '#message', labelText: 'お問い合わせ内容', tag: 'textarea', type: null, required: true }),
    ],
    mappings: [
      { role: 'company', selector: '#company', confidence: 0.9, source: 'rule' },
      { role: 'name', selector: '#name', confidence: 0.9, source: 'rule' },
      { role: 'email', selector: '#email', confidence: 0.9, source: 'rule' },
      { role: 'message', selector: '#message', confidence: 0.9, source: 'rule' },
    ],
    hasConfirmScreen: true, hasCaptcha: 'none', hasHoneypot: false, noSalesPolicy: false,
    ambiguousChoice: false, mappingConfidence: 0.9, gate: 'high',
  };

  // 必須なのに埋められない項目（誕生日）を持つ → 送信対象外になるはず。
  const broken: FormSchema = {
    ...clean,
    formUrl: 'https://broken.example.jp/contact',
    fields: [...clean.fields, field({ selector: '#nyusha', labelText: 'ご希望の面談日', required: true })],
  };

  const mk = (name: string, domain: string, schema: FormSchema, status: 'PENDING_APPROVAL' | 'APPROVED') => {
    const c = companies.upsert({ name, domain, source: 'smoke', icpScore: 0.8 });
    transition(c.id, 'DISCOVERING');
    companies.setForm(c.id, schema.formUrl, 0.9);
    transition(c.id, 'FORM_FOUND');
    transition(c.id, 'PARSING');
    fieldMaps.save(c.id, schema);
    transition(c.id, 'PARSED');
    transition(c.id, 'PLAN_READY');
    submissions.createPlan({ companyId: c.id, contentRendered: '（プレビュー本文）', planScreenshotUrl: null });
    transition(c.id, 'PENDING_APPROVAL');
    if (status === 'APPROVED') transition(c.id, 'APPROVED');
    return c.id;
  };

  const cleanId = mk('クリーン株式会社', 'clean.example.jp', clean, 'PENDING_APPROVAL');
  const approvedId = mk('承認済み株式会社', 'approved.example.jp', clean, 'APPROVED');
  const brokenId = mk('問題あり株式会社', 'broken.example.jp', broken, 'PENDING_APPROVAL');

  // プラン未作成（＝プレビューなし）のケース
  const noPlan = companies.upsert({ name: 'プラン無し株式会社', domain: 'noplan.example.jp', icpScore: 0.5 });
  transition(noPlan.id, 'DISCOVERING');
  companies.setForm(noPlan.id, clean.formUrl, 0.9);
  transition(noPlan.id, 'FORM_FOUND');
  transition(noPlan.id, 'PARSING');
  fieldMaps.save(noPlan.id, clean);
  transition(noPlan.id, 'PARSED');
  transition(noPlan.id, 'PLAN_READY');
  transition(noPlan.id, 'PENDING_APPROVAL');

  for (const id of [cleanId, approvedId, brokenId, noPlan.id]) {
    const r = assessSendReadiness(companies.byId(id)!);
    console.log(`#${id} ${r.name.padEnd(12)} ready=${r.ready} 未承認=${r.needsApproval} ` +
      `issues=[${r.issues.map((i) => i.label + (i.detail ? `(${i.detail})` : '')).join(' , ')}] ` +
      `warn=[${r.warnings.map((w) => w.label).join(' , ')}]`);
  }

  const snap = sendabilitySnapshot(50);
  console.log(`\nsnapshot: ready=${snap.readyCount} blocked=${snap.blockedCount} candidates=${snap.candidateTotal}`);

  const app = createServer();
  const server = app.listen(45991);
  const get = async (p: string) => (await fetch(`http://127.0.0.1:45991${p}`)).json();
  const post = async (p: string, body?: unknown) =>
    (await fetch(`http://127.0.0.1:45991${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })).json();

  const api = (await get('/api/sendable?limit=50')) as any;
  console.log('/api/sendable ->', {
    readyCount: api.readyCount, blockedCount: api.blockedCount, paceAllowed: api.paceAllowed,
    ready: api.ready.map((r: any) => r.name),
    blocked: api.blocked.map((r: any) => `${r.name}: ${r.issues.map((i: any) => i.label).join('/')}`),
  });

  // 送信不可の企業に単体送信 → 400 で理由が返る（送信されない）
  const blockedSend = await post(`/api/companies/${brokenId}/send`);
  console.log('single send (blocked) ->', blockedSend);
  console.log('status after ->', companies.byId(brokenId)!.status);

  const stopped = await post('/api/execute-all/stop');
  console.log('/api/execute-all/stop (idle) ->', stopped);
  console.log('/api/execute-all/status ->', await get('/api/execute-all/status'));

  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
