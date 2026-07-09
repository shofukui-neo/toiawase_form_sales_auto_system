import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleMap } from '../src/layers/l2_parsing.js';
import { detectSplitFields } from '../src/layers/l2_split.js';
import { renderContent } from '../src/layers/l3_content.js';
import { config } from '../src/config.js';
import type { DetectedField, CompanyRow, FormSchema } from '../src/types.js';

let seq = 0;
function field(overrides: Partial<DetectedField>): DetectedField {
  return {
    selector: `#f${seq++}`,
    tag: 'input',
    type: 'text',
    name: null,
    id: null,
    labelText: null,
    placeholder: null,
    required: false,
    honeypot: false,
    maxLength: null,
    autocomplete: null,
    ...overrides,
  };
}

function mkCompany(): CompanyRow {
  return {
    id: 1,
    name: 'テスト株式会社',
    domain: 'example.com',
    icp_score: 0.8,
    source: 'test',
    status: 'NEW',
    form_url: null,
    form_confidence: null,
    created_at: '',
    updated_at: '',
  };
}
function mkSchema(): FormSchema {
  return {
    formUrl: 'https://example.com/form',
    formSelector: 'form',
    fields: [],
    mappings: [],
    hasConfirmScreen: false,
    hasCaptcha: 'none',
    hasHoneypot: false,
    noSalesPolicy: false,
    mappingConfidence: 0.9,
    gate: 'high',
  };
}
/** Map role -> selector for a split detection result. */
function splitRoles(fields: DetectedField[]): Record<string, string> {
  const { mappings } = detectSplitFields(fields);
  return Object.fromEntries(mappings.map((m) => [m.role, m.selector]));
}

test('maps common Japanese inquiry labels including a bare 問い合わせ field', () => {
  const fields = [
    field({ labelText: '会社名', selector: '#company' }),
    field({ labelText: 'お名前', selector: '#name' }),
    field({ labelText: 'メールアドレス', selector: '#email' }),
    field({ labelText: '問い合わせ', selector: '#message' }),
  ];

  const { mappings } = ruleMap(fields);
  const roles = mappings.map((m) => m.role);

  assert.deepEqual(roles.includes('company'), true);
  assert.deepEqual(roles.includes('name'), true);
  assert.deepEqual(roles.includes('email'), true);
  assert.deepEqual(roles.includes('message'), true);
});

test('renders non-empty fallback values for phone and department', () => {
  const previous = { ...config.sender };
  config.sender.person = '福井 翔';
  config.sender.email = 'sho.fukui@example.com';
  config.sender.phone = '';

  const company: CompanyRow = {
    id: 1,
    name: 'テスト株式会社',
    domain: 'example.com',
    icp_score: 0.8,
    source: 'test',
    status: 'NEW',
    form_url: null,
    form_confidence: null,
    created_at: '',
    updated_at: '',
  };
  const schema: FormSchema = {
    formUrl: 'https://example.com/form',
    formSelector: 'form',
    fields: [],
    mappings: [],
    hasConfirmScreen: false,
    hasCaptcha: 'none',
    hasHoneypot: false,
    noSalesPolicy: false,
    mappingConfidence: 0.9,
    gate: 'high',
  };

  const content = renderContent(company, schema);

  assert.match(content.values.phone ?? '', /.+/);
  assert.match(content.values.department ?? '', /.+/);
  assert.match(content.values.subject ?? '', /.+/);
  assert.match(content.values.message ?? '', /.+/);

  config.sender = previous;
});

/* ------------------- split-field detection (課題A/B/D) ------------------- */

test('split: phone tel1/tel2/tel3 -> phone1/phone2/phone3 in order', () => {
  const r = splitRoles([
    field({ name: 'tel1', id: 'tel1', selector: '#tel1', type: 'tel', labelText: '電話番号' }),
    field({ name: 'tel2', id: 'tel2', selector: '#tel2', type: 'tel', labelText: '電話番号' }),
    field({ name: 'tel3', id: 'tel3', selector: '#tel3', type: 'tel', labelText: '電話番号' }),
  ]);
  assert.equal(r.phone1, '#tel1');
  assert.equal(r.phone2, '#tel2');
  assert.equal(r.phone3, '#tel3');
});

test('split: sei/mei name attributes -> name_sei/name_mei (not kana)', () => {
  const r = splitRoles([
    field({ name: 'sei', labelText: '姓' }),
    field({ name: 'mei', labelText: '名' }),
  ]);
  assert.ok(r.name_sei && r.name_mei);
  assert.equal(r.kana_sei, undefined);
});

test('split: sei_kana/mei_kana -> kana_sei/kana_mei', () => {
  const r = splitRoles([
    field({ name: 'sei_kana', labelText: 'セイ' }),
    field({ name: 'mei_kana', labelText: 'メイ' }),
  ]);
  assert.ok(r.kana_sei && r.kana_mei);
  assert.equal(r.name_sei, undefined);
});

test('split: lastname/firstname (romaji) -> name_sei/name_mei', () => {
  const r = splitRoles([
    field({ name: 'lastname', labelText: 'Last name' }),
    field({ name: 'firstname', labelText: 'First name' }),
  ]);
  assert.ok(r.name_sei && r.name_mei);
});

test('split: zip1/zip2 -> postal1/postal2', () => {
  const r = splitRoles([
    field({ name: 'zip1', labelText: '郵便番号', maxLength: 3 }),
    field({ name: 'zip2', labelText: '郵便番号', maxLength: 4 }),
  ]);
  assert.ok(r.postal1 && r.postal2);
});

test('split: email + confirm box -> email_confirm claims only the confirm box', () => {
  const { mappings, consumed } = detectSplitFields([
    field({ name: 'email', type: 'email', labelText: 'メールアドレス' }), // idx 0
    field({ name: 'email2', type: 'email', labelText: 'メールアドレス（確認）' }), // idx 1
  ]);
  const roles = mappings.map((m) => m.role);
  assert.equal(roles.includes('email_confirm'), true);
  // primary email must remain free for the generic rule mapper
  assert.equal(consumed.has(0), false);
  assert.equal(consumed.has(1), true);
});

test('split: structural adjacency — 3 boxes sharing 電話番号 label -> phone1/2/3', () => {
  const r = splitRoles([
    field({ name: 'a', type: 'text', labelText: '電話番号' }),
    field({ name: 'b', type: 'text', labelText: '電話番号' }),
    field({ name: 'c', type: 'text', labelText: '電話番号' }),
  ]);
  assert.ok(r.phone1 && r.phone2 && r.phone3);
});

test('no false split: a normal single-field form yields no split roles', () => {
  const { mappings } = detectSplitFields([
    field({ name: 'company', labelText: '会社名' }),
    field({ name: 'name', labelText: 'お名前' }),
    field({ name: 'email', type: 'email', labelText: 'メールアドレス' }),
    field({ name: 'tel', type: 'tel', labelText: '電話番号' }),
    field({ tag: 'textarea', type: null, name: 'message', labelText: 'お問い合わせ内容' }),
  ]);
  assert.equal(mappings.length, 0);
});

test('parse integration: split fields + ruleMap coexist without double-mapping', () => {
  const fields = [
    field({ name: 'company', labelText: '会社名' }),
    field({ name: 'sei', labelText: '姓' }),
    field({ name: 'mei', labelText: '名' }),
    field({ name: 'email', type: 'email', labelText: 'メールアドレス' }),
    field({ name: 'tel1', type: 'tel', labelText: '電話番号' }),
    field({ name: 'tel2', type: 'tel', labelText: '電話番号' }),
    field({ name: 'tel3', type: 'tel', labelText: '電話番号' }),
    field({ tag: 'textarea', type: null, name: 'message', labelText: 'お問い合わせ内容' }),
  ];
  const split = detectSplitFields(fields);
  const { mappings } = ruleMap(fields, { skip: split.consumed });
  const all = [...split.mappings, ...mappings].map((m) => m.role);
  // every field claimed exactly once, correct roles present
  for (const role of ['company', 'name_sei', 'name_mei', 'email', 'phone1', 'phone2', 'phone3', 'message']) {
    assert.equal(all.includes(role as any), true, `missing ${role} in ${all.join(',')}`);
  }
  // generic phone must NOT appear (all phone boxes were split)
  assert.equal(all.includes('phone' as any), false);
});

test('render: phone/name/kana/postal split values + email_confirm', () => {
  const previous = { ...config.sender };
  config.sender = {
    ...config.sender,
    company: 'ネオキャリア株式会社',
    person: '福井 翔',
    email: 'sho.fukui@example.com',
    phone: '03-1234-5678',
    kanaSei: 'フクイ',
    kanaMei: 'ショウ',
    postal: '150-0043',
    department: '営業部',
  };
  const content = renderContent(mkCompany(), mkSchema());
  assert.equal(content.values.phone1, '03');
  assert.equal(content.values.phone2, '1234');
  assert.equal(content.values.phone3, '5678');
  assert.equal(content.values.name_sei, '福井');
  assert.equal(content.values.name_mei, '翔');
  assert.equal(content.values.kana_sei, 'フクイ');
  assert.equal(content.values.kana_mei, 'ショウ');
  assert.equal(content.values.postal1, '150');
  assert.equal(content.values.postal2, '0043');
  assert.equal(content.values.email_confirm, content.values.email);
  config.sender = previous;
});
