import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleMap, mapFields } from '../src/layers/l2_parsing.js';
import { detectSplitFields } from '../src/layers/l2_split.js';
import { detectChoiceFields, pickOption } from '../src/layers/l2_choice.js';
import { renderContent, deriveAddressValues, buildSignature } from '../src/layers/l3_content.js';
import { isCoreRole, shouldFillField } from '../src/layers/fillPolicy.js';
import { personalize } from '../src/layers/l3_personalize.js';
import { config, splitAddress } from '../src/config.js';
import type { DetectedField, CompanyRow, FormSchema, FieldRole } from '../src/types.js';

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
    ambiguousChoice: false,
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

test('never fabricates an identity value: unset phone/department stay unset', () => {
  const previous = { ...config.sender };
  config.sender = { ...config.sender, person: '福井 聖', email: 'sho.fukui@example.com', phone: '', department: '' };

  const content = renderContent(mkCompany(), mkSchema());

  // A made-up 03-0000-0000 reaching a real recipient is worse than a blank
  // required field, which gates the form down to a human instead.
  assert.equal(content.values.phone, undefined);
  assert.equal(content.values.department, undefined);
  // Subject/body are template output, not identity claims — always present.
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

/* ------------------- required choice select/radio (課題C) ------------------- */

test('pickOption: prefers neutral keyword, skips placeholder', () => {
  assert.deepEqual(pickOption(['選択してください', '製品について', 'その他']), { value: 'その他', confident: true });
  assert.deepEqual(pickOption(['個人', '法人']), { value: '法人', confident: true });
});

test('pickOption: falls back to first non-placeholder (not confident)', () => {
  assert.deepEqual(pickOption(['選択してください', '資料請求', '見積依頼']), { value: '資料請求', confident: false });
  assert.equal(pickOption(['選択してください']), null); // nothing real
});

test('choice: required select auto-filled with neutral option', () => {
  const sel = field({ tag: 'select', type: null, selector: '#it', required: true, labelText: 'お問い合わせ種別', options: ['選択してください', '製品について', 'その他'] });
  const { mappings, ambiguous } = detectChoiceFields([sel], new Set());
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].role, 'choice');
  assert.equal(mappings[0].value, 'その他');
  assert.equal(ambiguous, false);
});

test('choice: fallback select flags ambiguous', () => {
  const sel = field({ tag: 'select', type: null, selector: '#it', required: true, options: ['選択してください', '資料請求', '見積依頼'] });
  const { mappings, ambiguous } = detectChoiceFields([sel], new Set());
  assert.equal(mappings[0].value, '資料請求');
  assert.equal(ambiguous, true);
});

test('choice: optional select is not touched', () => {
  const sel = field({ tag: 'select', type: null, selector: '#it', required: false, options: ['選択してください', 'その他'] });
  const { mappings } = detectChoiceFields([sel], new Set());
  assert.equal(mappings.length, 0);
});

test('choice: required radio group picks keyword match (法人)', () => {
  const r1 = field({ tag: 'input', type: 'radio', name: 'ptype', selector: '#r1', labelText: '法人', required: true });
  const r2 = field({ tag: 'input', type: 'radio', name: 'ptype', selector: '#r2', labelText: '個人' });
  const { mappings, ambiguous } = detectChoiceFields([r1, r2], new Set());
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].selector, '#r1');
  assert.equal(mappings[0].value, '法人');
  assert.equal(ambiguous, false);
});

test('choice: required radio with no keyword is NOT guessed (ambiguous)', () => {
  const r1 = field({ tag: 'input', type: 'radio', name: 'q', selector: '#r1', labelText: '要介護1', required: true });
  const r2 = field({ tag: 'input', type: 'radio', name: 'q', selector: '#r2', labelText: '要介護2' });
  const { mappings, ambiguous } = detectChoiceFields([r1, r2], new Set());
  assert.equal(mappings.length, 0);
  assert.equal(ambiguous, true);
});

test('choice: already-mapped select is skipped', () => {
  const sel = field({ tag: 'select', type: null, selector: '#dept', required: true, options: ['営業部', '総務部'] });
  const { mappings } = detectChoiceFields([sel], new Set(['#dept']));
  assert.equal(mappings.length, 0);
});

test('render: phone/name/kana/postal split values + email_confirm', () => {
  const previous = { ...config.sender };
  config.sender = {
    ...config.sender,
    company: '株式会社ネオキャリア',
    person: '福井 聖',
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
  assert.equal(content.values.name_mei, '聖');
  assert.equal(content.values.kana_sei, 'フクイ');
  assert.equal(content.values.kana_mei, 'ショウ');
  assert.equal(content.values.postal1, '150');
  assert.equal(content.values.postal2, '0043');
  assert.equal(content.values.email_confirm, content.values.email);
  config.sender = previous;
});

/* ------------------- フリガナ split: セイ/メイ (課題B) ------------------- */

test('split: form_lastKana / form_firstKana -> kana_sei / kana_mei', () => {
  // yokowo.co.jp — the reading marker is glued to the sei/mei token and the
  // fields carry no label at all. Before, the whole reading went into セイ.
  const r = splitRoles([
    field({ name: 'form_lastName', selector: '#ln' }),
    field({ name: 'form_firstName', selector: '#fn' }),
    field({ name: 'form_lastKana', selector: '#lk' }),
    field({ name: 'form_firstKana', selector: '#fk' }),
  ]);
  assert.equal(r.name_sei, '#ln');
  assert.equal(r.name_mei, '#fn');
  assert.equal(r.kana_sei, '#lk');
  assert.equal(r.kana_mei, '#fk');
});

test('split: セイ/メイ labels -> kana_sei/kana_mei, 姓/名 -> name_sei/name_mei', () => {
  // genma.co.jp shape.
  const r = splitRoles([
    field({ name: 'name-sei', labelText: '姓', selector: '#ns' }),
    field({ name: 'name-mei', labelText: '名', selector: '#nm' }),
    field({ name: 'ruby-sei', labelText: 'セイ', selector: '#ks' }),
    field({ name: 'ruby-mei', labelText: 'メイ', selector: '#km' }),
  ]);
  assert.equal(r.name_sei, '#ns');
  assert.equal(r.name_mei, '#nm');
  assert.equal(r.kana_sei, '#ks');
  assert.equal(r.kana_mei, '#km');
});

/* ------------------------- 住所分割 (都道府県/市区町村/番地) ------------------------- */

test('splitAddress: 都道府県 / 市区町村 / 番地', () => {
  assert.deepEqual(splitAddress('東京都新宿区西新宿1丁目22-2'), {
    prefecture: '東京都', city: '新宿区', street: '西新宿1丁目22-2',
  });
  assert.deepEqual(splitAddress('神奈川県横浜市青葉区あざみ野1-2-3'), {
    prefecture: '神奈川県', city: '横浜市青葉区', street: 'あざみ野1-2-3',
  });
  assert.deepEqual(splitAddress(''), { prefecture: '', city: '', street: '' });
});

test('address split: 都道府県+市区町村+番地・マンション名 (genma)', () => {
  const r = splitRoles([
    field({ name: 'add01', labelText: '都道府県', selector: '#a1' }),
    field({ name: 'add02', labelText: '市区町村', selector: '#a2' }),
    field({ name: 'add03', labelText: '番地・マンション名など', selector: '#a3' }),
  ]);
  assert.equal(r.address_pref, '#a1');
  assert.equal(r.address_city, '#a2');
  assert.equal(r.address_street, '#a3');
});

test('address split: 都道府県<select> + 市区町村 + 市区町村以降 (yokowo)', () => {
  // 「市区町村以降」 contains 市区町村 — it must still be recognised as 番地.
  const r = splitRoles([
    field({ tag: 'select', type: null, name: 'form_prefectures', labelText: '都道府県', selector: '#p',
      options: ['選択してください', '北海道', '東京都', '大阪府'] }),
    field({ name: 'form_address1', labelText: '市区町村 (例：千代田区)', selector: '#c' }),
    field({ name: 'form_address2', labelText: '市区町村以降 (例：□□町1-1-1 △△ビル 10F)', selector: '#s' }),
  ]);
  assert.equal(r.address_pref, '#p');
  assert.equal(r.address_city, '#c');
  assert.equal(r.address_street, '#s');
});

test('address split: a single 住所 box is not a split', () => {
  const { mappings } = detectSplitFields([
    field({ name: 'address', labelText: 'ご住所' }),
    field({ name: 'company', labelText: '会社名' }),
  ]);
  assert.equal(mappings.filter((m) => m.role.startsWith('address')).length, 0);
});

test('address split: 郵便番号 sharing the 住所 label stays with the postal role', () => {
  const r = splitRoles([
    field({ name: 'your-postalcode', labelText: 'ご住所', selector: '#zip' }),
    field({ name: 'your-pref', labelText: 'ご住所', selector: '#p', tag: 'select', type: null,
      options: ['北海道', '東京都', '大阪府'] }),
    field({ name: 'your-streetaddress01', labelText: 'ご住所', selector: '#s1' }),
  ]);
  assert.notEqual(r.address_pref, '#zip');
  assert.notEqual(r.address_city, '#zip');
  assert.notEqual(r.address_street, '#zip');
  assert.equal(r.address_pref, '#p');
});

test('address split: an extra box is consumed so `address` cannot paste the whole address', () => {
  // lassic.co.jp — streetaddress01/02/03 under one ご住所 label. Two get parts;
  // the third must NOT fall through to the generic `address` rule.
  const fields = [
    field({ name: 'your-pref', labelText: 'ご住所', selector: '#p', tag: 'select', type: null,
      options: ['北海道', '東京都', '大阪府'] }),
    field({ name: 'your-streetaddress01', labelText: 'ご住所', selector: '#s1' }),
    field({ name: 'your-streetaddress02', labelText: 'ご住所', selector: '#s2' }),
    field({ name: 'your-streetaddress03', labelText: 'ご住所', selector: '#s3' }),
  ];
  const split = detectSplitFields(fields);
  const { mappings } = ruleMap(fields, { skip: split.consumed });
  assert.equal(mappings.some((m) => m.role === 'address'), false);
});

test('deriveAddressValues: every component lands somewhere, exactly once', () => {
  const addr = '東京都新宿区西新宿1丁目22-2';
  const all = deriveAddressValues(addr, { pref: true, city: true, street: true });
  assert.deepEqual(all, { address_pref: '東京都', address_city: '新宿区', address_street: '西新宿1丁目22-2' });

  // No 市区町村 box: 番地 absorbs it (sengoku / hattoris shape).
  assert.deepEqual(deriveAddressValues(addr, { pref: true, city: false, street: true }), {
    address_pref: '東京都', address_street: '新宿区西新宿1丁目22-2',
  });
  // No 都道府県 box: 市区町村 absorbs it.
  assert.deepEqual(deriveAddressValues(addr, { pref: false, city: true, street: true }), {
    address_city: '東京都新宿区', address_street: '西新宿1丁目22-2',
  });
  // 都道府県 never receives more than the prefecture (it is usually a <select>).
  assert.deepEqual(deriveAddressValues(addr, { pref: true, city: true, street: false }), {
    address_pref: '東京都', address_city: '新宿区西新宿1丁目22-2',
  });
});

test('会社名欄には宛先企業ではなく自社名が入る', () => {
  const previous = { ...config.sender };
  config.sender = { ...config.sender, company: '株式会社ネオキャリア', person: '福井 聖' };

  const content = renderContent({ ...mkCompany(), name: '株式会社ヨコオ' }, mkSchema());
  // フォームの「会社名」は問い合わせている側の欄。宛先企業名を入れると、
  // 受信者は自社名が会社名欄に入った問い合わせを受け取ることになる。
  assert.equal(content.values.company, '株式会社ネオキャリア');
  // 宛先企業名は本文の書き出しに使う。
  assert.match(content.body, /^株式会社ヨコオ/);

  config.sender = previous;
});

test('電話番号欄には署名の連絡先番号が入る（本社代表番号ではない）', () => {
  const previous = { ...config.sender };
  config.sender = { ...config.sender, phone: '080-6813-0780', officePhone: '03-5908-8405' };

  const content = renderContent(mkCompany(), mkSchema());
  assert.equal(content.values.phone, '080-6813-0780');
  // 分割3欄フォームにも同じ番号が配分される。
  assert.equal(content.values.phone1, '080');
  assert.equal(content.values.phone2, '6813');
  assert.equal(content.values.phone3, '0780');

  // 署名では連絡先＝携帯、本社ブロック＝代表番号、と役割が分かれる。
  const sig = buildSignature();
  assert.match(sig, /携帯電話：080-6813-0780/);
  assert.match(sig, /電話：03-5908-8405/);

  // 固定電話を連絡先に設定した場合はラベルが「電話」になる（署名が嘘にならない）。
  config.sender = { ...config.sender, phone: '03-5908-8405' };
  assert.match(buildSignature(), /\n電話：03-5908-8405/);

  config.sender = previous;
});

test('company: 属性名だけの企業・団体名欄も拾う（ラベルなし form_office）', () => {
  const { mappings } = mapFields([
    field({ name: 'form_office', labelText: '', selector: '#office' }),
    field({ name: 'form_message', labelText: '', selector: '#msg', tag: 'textarea', type: null }),
  ]);
  assert.equal(mappings.find((m) => m.role === 'company')?.selector, '#office');
});

test('company: office_address / office_tel は会社名として奪わない', () => {
  // 広いキーワードが複合欄でより具体的なルールを out-score しないこと。
  const { mappings } = mapFields([
    field({ name: 'office_name', labelText: '会社名', selector: '#c' }),
    field({ name: 'office_address', labelText: '所在地', selector: '#a' }),
    field({ name: 'office_tel', labelText: '電話番号', selector: '#t' }),
  ]);
  const roleOf = (sel: string) => mappings.find((m) => m.selector === sel)?.role;
  assert.equal(roleOf('#c'), 'company');
  assert.equal(roleOf('#a'), 'address');
  assert.equal(roleOf('#t'), 'phone');
});

test('fill policy: 住所・郵便番号は任意欄でも本社所在地を入力する', () => {
  // yokowo.co.jp — 郵便番号/都道府県/市区町村/市区町村以降 がすべて「任意」。
  // 以前は任意の住所欄を一律スキップしていたため、全部空欄で送信していた。
  const addr = (name: string, label: string, required: boolean) =>
    field({ name, labelText: label, selector: `#${name}`, required });
  const fields = [
    addr('form_postCode', '郵便番号 (例：000-0000)', false),
    field({ tag: 'select', type: null, name: 'form_prefectures', labelText: '都道府県', selector: '#form_prefectures',
      required: false, options: ['選択してください', '北海道', '東京都', '大阪府'] }),
    addr('form_address1', '市区町村 (例：千代田区)', false),
    addr('form_address2', '市区町村以降 (例：□□町1-1-1)', false),
  ];
  for (const role of ['postal', 'address_pref', 'address_city', 'address_street'] as FieldRole[]) {
    assert.equal(isCoreRole(role), true, `${role} should be core`);
    assert.equal(shouldFillField(fields[0], role), true, `${role} should fill even when optional`);
  }
  // 部署は従来どおり「必須のときだけ」入力する。
  assert.equal(shouldFillField(fields[0], 'department'), false);
  assert.equal(shouldFillField({ ...fields[0], required: true }, 'department'), true);
});

/* --------------- 非営業フォーム（迷惑メール通報など）の保護 --------------- */

test('off-topic: 迷惑メール report fields are never mapped', () => {
  // arara.com/contact/arara-form-spam — a 【入力者情報】 block that looks like a
  // normal contact form, plus a 【迷惑メールの内容】 block. Filling the latter
  // files a spam report against ourselves.
  const fields = [
    field({ name: 'v311', labelText: '【入力者情報】会社名', required: true }),
    field({ name: 'v314', type: 'email', labelText: '【入力者情報】メールアドレス', required: true }),
    field({ tag: 'textarea', type: null, name: 'v315', labelText: '【入力者情報】お問い合わせ内容', required: true }),
    field({ name: 'v316', type: 'email', labelText: '【迷惑メールの内容】配信停止希望メールアドレス', required: true }),
    field({ tag: 'textarea', type: null, name: 'v317', labelText: '【迷惑メールの内容】迷惑メールの件名', required: true }),
    field({ tag: 'textarea', type: null, name: 'v318', labelText: '【迷惑メールの内容】迷惑メールの本文', required: true }),
    field({ tag: 'textarea', type: null, name: 'v320', labelText: '【迷惑メールの内容】配信元企業・団体名', required: true }),
  ];
  const { mappings, offTopic } = mapFields(fields);
  assert.equal(offTopic.size, 4);

  const mappedLabels = mappings.map(
    (m) => fields.find((f) => f.selector === m.selector)?.labelText ?? '',
  );
  for (const label of mappedLabels) assert.equal(/迷惑メール/.test(label), false, `mapped ${label}`);
  // The legitimate 【入力者情報】 half still maps normally.
  assert.equal(mappings.some((m) => m.role === 'message'), true);
  assert.equal(mappings.some((m) => m.role === 'company'), true);
});

/* ---------------------- consent vs. category checkboxes ---------------------- */

test('agree: a category checkbox group is not consent, and only one box is ticked', () => {
  // sengokujp.co.jp — お問い合わせ内容 as 5 checkboxes. Ticking all five (which a
  // bare type=checkbox match did) is both wrong and obviously automated.
  const fields = [
    field({ type: 'checkbox', name: 'checkBox_inp[data][]', labelText: 'OEMについて', selector: '#c1' }),
    field({ type: 'checkbox', name: 'checkBox_inp[data][]', labelText: '部品事業について', selector: '#c2' }),
    field({ type: 'checkbox', name: 'checkBox_inp[data][]', labelText: 'メディア・取材について', selector: '#c3' }),
    field({ type: 'checkbox', name: 'checkBox_inp[data][]', labelText: 'その他', selector: '#c4' }),
    field({ type: 'checkbox', name: '個人情報保護方針[data][]', labelText: '', selector: '#privacy' }),
  ];
  const { mappings } = mapFields(fields);
  const agree = mappings.filter((m) => m.role === 'agree');
  assert.deepEqual(agree.map((m) => m.selector), ['#privacy']);

  const choice = mappings.filter((m) => m.role === 'choice');
  assert.equal(choice.length, 1);
  assert.equal(choice[0].selector, '#c4'); // 「その他」 — the neutral option
});

test('agree: consent checkboxes are still recognised by name alone', () => {
  for (const name of ['policy', 'acceptance-442', 'your-acceptance']) {
    const { mappings } = mapFields([field({ type: 'checkbox', name, labelText: '', selector: '#a' })]);
    assert.equal(mappings.some((m) => m.role === 'agree'), true, `${name} should map to agree`);
  }
});

/* ------------------------------ 文面・署名 ------------------------------ */

test('signature: built from the configured identity, no dangling labels', () => {
  const previous = { ...config.sender };
  config.sender = {
    ...config.sender,
    company: '株式会社ネオキャリア', department: '事業開発本部 事業開発部',
    person: '福井 聖', personRomaji: 'Sho Fukui', email: 'sho.fukui@neo-career.co.jp',
    phone: '080-6813-0780', officePhone: '03-5908-8405', fax: '03-5908-8158',
    url: 'http://www.neo-career.co.jp', postal: '160-0023',
    address: '東京都新宿区西新宿1丁目22-2', office: '新宿本社',
  };
  const sig = buildSignature();
  assert.match(sig, /株式会社ネオキャリア/);
  assert.match(sig, /事業開発本部　事業開発部/);
  assert.match(sig, /福井聖／Sho Fukui/); // 署名では姓名を詰める
  assert.match(sig, /携帯電話：080-6813-0780/);
  assert.match(sig, /〒160-0023 東京都新宿区西新宿1丁目22-2/);
  assert.match(sig, /電話：03-5908-8405/);
  assert.match(sig, /FAX ：03-5908-8158/);

  // An unset field drops its whole line rather than printing "FAX ：".
  config.sender = { ...config.sender, fax: '', url: '' };
  const noFax = buildSignature();
  assert.equal(/FAX/.test(noFax), false);
  assert.equal(/URL/.test(noFax), false);

  config.sender = previous;
});

test('personalize: industry-specific reason, generic when unknown', () => {
  const logistics = personalize({ ...mkCompany(), name: '福山通運株式会社', domain: 'fukutsu.co.jp' });
  assert.equal(logistics.industry, '運輸・物流');
  assert.match(logistics.reason, /運輸・物流/);
  assert.match(logistics.reason, /福山通運株式会社/);

  const unknown = personalize({ ...mkCompany(), name: 'あいうえお', domain: 'aiueo.example' });
  assert.equal(unknown.industry, '');
  assert.match(unknown.reason, /あいうえお/);
  // Never asserts a fact about a company we know nothing about.
  assert.equal(/分野で/.test(unknown.reason), false);
});

test('render: body carries the personalised reason and the full signature', () => {
  const previous = { ...config.sender };
  config.sender = {
    ...config.sender,
    company: '株式会社ネオキャリア', person: '福井 聖', personRomaji: 'Sho Fukui',
    email: 'sho.fukui@neo-career.co.jp', phone: '080-6813-0780', officePhone: '03-5908-8405',
    department: '事業開発本部 事業開発部', postal: '160-0023',
    address: '東京都新宿区西新宿1丁目22-2', office: '新宿本社',
  };
  const content = renderContent({ ...mkCompany(), name: '福山通運株式会社', domain: 'fukutsu.co.jp' }, mkSchema());
  assert.match(content.body, /運輸・物流/);
  assert.match(content.body, /■━/);
  assert.match(content.body, /sho\.fukui@neo-career\.co\.jp/);
  assert.equal(content.body.includes('ネオキャリア株式会社'), false); // 旧社名が残っていない
  config.sender = previous;
});

test('render: body is shrunk to fit a maxlength, keeping the signature', () => {
  const previous = { ...config.sender };
  config.sender = {
    ...config.sender,
    company: '株式会社ネオキャリア', person: '福井 聖', email: 'sho.fukui@neo-career.co.jp',
    phone: '080-6813-0780', officePhone: '03-5908-8405', department: '事業開発本部 事業開発部',
    postal: '160-0023', address: '東京都新宿区西新宿1丁目22-2', office: '新宿本社',
  };
  const withLimit = (maxLength: number | null): FormSchema => ({
    ...mkSchema(),
    fields: [field({ tag: 'textarea', type: null, name: 'msg', selector: '#msg', labelText: 'お問い合わせ内容', maxLength })],
    mappings: [{ role: 'message' as FieldRole, selector: '#msg', confidence: 0.9, source: 'rule' }],
  });

  const full = renderContent(mkCompany(), withLimit(null)).body;
  const trimmed = renderContent(mkCompany(), withLimit(800)).body;
  assert.ok(trimmed.length < full.length, 'body should shrink');
  assert.ok(trimmed.length <= 800, `trimmed=${trimmed.length}`);
  // §9: the signature must survive the shrink — a truncated message with no
  // sender contact details must never be sent.
  assert.match(trimmed, /■━/);
  assert.match(trimmed, /sho\.fukui@neo-career\.co\.jp/);
  config.sender = previous;
});
