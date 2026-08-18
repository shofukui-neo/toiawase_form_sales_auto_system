/**
 * 一斉送信（全項目クリアのみ / 随時送信）の実動作確認。
 * ローカルのテストフォームサーバに対して実際に送信まで行う。外部ネットワーク不要。
 */
process.env.DB_PATH = './data/smoke-bulk.db';
process.env.SENDER_COMPANY = '株式会社ネオキャリア';
process.env.SENDER_PERSON = '福井 翔';
process.env.SENDER_EMAIL = 'sho.fukui@example.com';
process.env.SENDER_PHONE = '03-1234-5678';
process.env.SENDER_KANA_SEI = 'フクイ';
process.env.SENDER_KANA_MEI = 'ショウ';
process.env.SENDER_POSTAL = '150-0043';
process.env.SENDER_ADDRESS = '東京都渋谷区道玄坂1-2-3';
process.env.SENDER_DEPARTMENT = '事業開発本部';
process.env.HEADLESS = 'true';
process.env.LOG_LEVEL ||= 'info';
process.env.SEND_WINDOW_START = '0';
process.env.SEND_WINDOW_END = '24';
process.env.DAILY_SEND_LIMIT = '9999';
process.env.SEND_MIN_INTERVAL_MS = '200';
process.env.SEND_MAX_INTERVAL_MS = '400';

import { rmSync } from 'node:fs';
import type { DetectedField, FormSchema } from '../src/types.js';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
}

async function main() {
  for (const f of ['', '-wal', '-shm']) rmSync(`./data/smoke-bulk.db${f}`, { force: true });

  const { startServer } = await import('./test_form_server.js');
  const { companies, fieldMaps } = await import('../src/db/repositories.js');
  const { transition } = await import('../src/core/stateMachine.js');
  const { parseForm } = await import('../src/layers/l2_parsing.js');
  const { buildPlan } = await import('../src/pipeline/pipeline.js');
  const { startBulkSend, bulkStatus } = await import('../src/pipeline/bulkSend.js');
  const { assessSendReadiness } = await import('../src/pipeline/readiness.js');

  const { server, url } = await startServer(0);
  console.log(`test server: ${url}`);

  const prepare = async (name: string, domain: string): Promise<number> => {
    const c = companies.upsert({ name, domain, source: 'smoke', icpScore: 0.8 });
    transition(c.id, 'DISCOVERING');
    companies.setForm(c.id, `${url}/contact`, 0.9);
    transition(c.id, 'FORM_FOUND');
    transition(c.id, 'PARSING');
    fieldMaps.save(c.id, await parseForm({ formUrl: `${url}/contact`, formConfidence: 0.9 }));
    transition(c.id, 'PARSED');
    await buildPlan(c.id, { autoHighGate: false }); // 常に承認待ちに置く
    return c.id;
  };

  try {
    const cleanId = await prepare('クリーン株式会社', 'clean.example.test');
    const brokenId = await prepare('問題あり株式会社', 'broken.example.test');

    // 「問題あり」側に、埋められない必須項目を後から足す（＝全項目クリアではない）。
    const schema = fieldMaps.latest(brokenId)!;
    const extra: DetectedField = {
      selector: '#meeting_date', tag: 'input', type: 'text', name: 'meeting_date', id: 'meeting_date',
      labelText: 'ご希望の面談日', placeholder: null, required: true, honeypot: false,
      maxLength: null, autocomplete: null,
    };
    const broken: FormSchema = { ...schema, fields: [...schema.fields, extra] };
    fieldMaps.save(brokenId, broken);

    check('クリーンは送信可', assessSendReadiness(companies.byId(cleanId)!).ready);
    const brokenCheck = assessSendReadiness(companies.byId(brokenId)!);
    check('問題ありは送信対象外', !brokenCheck.ready, brokenCheck.issues.map((i) => i.label).join(' / '));
    check('両社とも承認待ち', companies.byId(cleanId)!.status === 'PENDING_APPROVAL' && companies.byId(brokenId)!.status === 'PENDING_APPROVAL');

    // follow=true でも、取り込みが動いていなければ対象を出し切った時点で終了する。
    const started = startBulkSend({ follow: true, actor: 'smoke' });
    check('一斉送信を開始', started.started, started.message);
    for (;;) {
      const s = bulkStatus();
      if (!s.running) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const fin = bulkStatus();
    console.log('\nbulk:', {
      success: fin.success, failed: fin.failed, skipped: fin.skipped,
      scanned: fin.scanned, blocked: fin.blocked, stopReason: fin.stopReason,
    });
    console.log('results:', fin.results);

    check('送信成功は 1 社', fin.success === 1, `success=${fin.success} failed=${fin.failed}`);
    check('クリーンは送信済み', companies.byId(cleanId)!.status === 'SUBMITTED_SUCCESS', companies.byId(cleanId)!.status);
    check('問題ありは未送信のまま', companies.byId(brokenId)!.status === 'PENDING_APPROVAL', companies.byId(brokenId)!.status);
    check('問題ありは送信対象として数えられている', fin.blocked === 1, `blocked=${fin.blocked}`);
    check('取り込み停止中は自然終了する', fin.stopReason === '送信対象がなくなりました', String(fin.stopReason));
  } finally {
    server.close();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
