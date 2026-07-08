import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleMap } from '../src/layers/l2_parsing.js';
import { renderContent } from '../src/layers/l3_content.js';
import { config } from '../src/config.js';
import type { DetectedField, CompanyRow, FormSchema } from '../src/types.js';

function field(overrides: Partial<DetectedField>): DetectedField {
  return {
    selector: 'input',
    tag: 'input',
    type: 'text',
    name: null,
    id: null,
    labelText: null,
    placeholder: null,
    required: false,
    honeypot: false,
    ...overrides,
  };
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
