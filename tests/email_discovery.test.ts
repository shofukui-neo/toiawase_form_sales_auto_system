import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLocalPart,
  deobfuscate,
  extractEmailsFromHtml,
  guessRoleAddresses,
  isAcceptableAddress,
} from '../src/layers/l0_email_parse.js';

/**
 * メールアドレス自動探索の抽出・除外規則のテスト。
 *
 * ネットワークに出る部分（クロール・MX 参照）はここでは扱わない。誤検出が
 * そのまま誤送信になるのは抽出とフィルタの側なので、そこを固める:
 * 画像パスや解析タグのアドレスを拾えば、無関係な相手に営業メールが飛び、
 * バウンスが積み上がって送信ドメインの評価まで落ちる。
 */

const DOMAIN = 'kaisha.co.jp';
const PAGE = 'https://kaisha.co.jp/company';

const emails = (html: string, domain = DOMAIN): string[] =>
  extractEmailsFromHtml(html, PAGE, domain).map((e) => e.email).sort();

/* ------------------------------ 拾うべきもの ------------------------------ */

test('会社概要ページの本文からアドレスを拾う', () => {
  const html = `<body>
    <p>お問い合わせ：info@kaisha.co.jp</p>
    <p>採用について：recruit@kaisha.co.jp</p></body>`;
  assert.deepEqual(emails(html), ['info@kaisha.co.jp', 'recruit@kaisha.co.jp']);
});

test('mailto: リンクを拾い、本文よりも高く評価する', () => {
  const html = `<body>
    <a href="mailto:contact@kaisha.co.jp">お問い合わせ</a>
    <p>info@kaisha.co.jp</p></body>`;
  const found = extractEmailsFromHtml(html, PAGE, DOMAIN);
  const link = found.find((e) => e.email === 'contact@kaisha.co.jp');
  const text = found.find((e) => e.email === 'info@kaisha.co.jp');
  assert.ok(link && text);
  // mailto は「人間向けに置かれた窓口」なので、同じ種別なら本文より確実。
  assert.ok(link.confidence > 0, 'mailto が拾えていない');
  assert.equal(link.roleKind, 'contact');
  assert.equal(text.roleKind, 'info');
});

test('mailto の件名パラメータを宛先に含めない', () => {
  const html = '<body><a href="mailto:info@kaisha.co.jp?subject=お問い合わせ">メール</a></body>';
  assert.deepEqual(emails(html), ['info@kaisha.co.jp']);
});

test('採用窓口を最優先にする（新卒採用の提案なので）', () => {
  const html = `<body>
    <p>sales@kaisha.co.jp</p><p>info@kaisha.co.jp</p><p>recruit@kaisha.co.jp</p></body>`;
  const found = extractEmailsFromHtml(html, PAGE, DOMAIN).sort((a, b) => b.confidence - a.confidence);
  assert.equal(found[0].email, 'recruit@kaisha.co.jp');
  assert.equal(found.at(-1)?.email, 'sales@kaisha.co.jp');
});

/* ----------------------------- 拾ってはいけない ----------------------------- */

test('画像・スクリプトのパスをアドレスと誤認しない', () => {
  const html = `<body>
    <img src="https://cdn.kaisha.co.jp/logo@2x.png">
    <link href="/assets/font@1.woff2">
    <script src="//code.jquery.com/jquery@3.6.0.js"></script></body>`;
  assert.deepEqual(emails(html), []);
});

test('解析タグ・CMS 由来のアドレスを拾わない', () => {
  const html = `<body>
    <p>o1234@sentry.io</p>
    <p>support@wixpress.com</p>
    <p>info@kaisha.co.jp</p></body>`;
  assert.deepEqual(emails(html), ['info@kaisha.co.jp']);
});

test('送信してはいけないローカル部を除外する', () => {
  const html = `<body>
    <p>noreply@kaisha.co.jp</p><p>postmaster@kaisha.co.jp</p>
    <p>abuse@kaisha.co.jp</p><p>info@kaisha.co.jp</p></body>`;
  assert.deepEqual(emails(html), ['info@kaisha.co.jp']);
});

test('似た綴りの正当なアドレスまで巻き込まない', () => {
  // `noreply` は除外するが `noren@`（暖簾）のような実在の窓口は残す。
  assert.equal(isAcceptableAddress('noreply@kaisha.co.jp'), false);
  assert.equal(isAcceptableAddress('noren@kaisha.co.jp'), true);
  assert.equal(isAcceptableAddress('rootpower@kaisha.co.jp'), true);
});

test('他社ドメインのアドレスは確度を大きく下げる', () => {
  const html = `<body>
    <p>info@kaisha.co.jp</p>
    <p>info@seisaku-gaisha.co.jp</p></body>`;
  const found = extractEmailsFromHtml(html, PAGE, DOMAIN);
  const own = found.find((e) => e.domain === 'kaisha.co.jp')!;
  const other = found.find((e) => e.domain === 'seisaku-gaisha.co.jp')!;
  // 制作会社・ASP のアドレスに営業をかけても意味がない。
  assert.ok(own.confidence > other.confidence * 2, `${own.confidence} vs ${other.confidence}`);
});

test('サブドメインは自社扱いにする', () => {
  const html = '<body><p>info@recruit.kaisha.co.jp</p></body>';
  const found = extractEmailsFromHtml(html, PAGE, DOMAIN);
  assert.ok(found[0].confidence >= 0.9, `確度が下がっている: ${found[0].confidence}`);
});

/* -------------------------------- 難読化 -------------------------------- */

test('全角＠や (at) の難読化を戻せる', () => {
  assert.equal(deobfuscate('info＠kaisha.co.jp'), 'info@kaisha.co.jp');
  assert.equal(deobfuscate('info (at) kaisha.co.jp'), 'info@kaisha.co.jp');
  assert.equal(deobfuscate('info［アット］kaisha.co.jp'), 'info@kaisha.co.jp');
  assert.equal(deobfuscate('info (at) kaisha (dot) co.jp'), 'info@kaisha.co.jp');
});

test('難読化されたアドレスも抽出できる', () => {
  const html = '<body><p>お問い合わせ：info＠kaisha.co.jp</p></body>';
  assert.deepEqual(emails(html), ['info@kaisha.co.jp']);
});

test('数値文字参照による難読化 (&#64;) も戻せる', () => {
  // クローラ避けに `&#64;` で @ を書くサイトは珍しくない。
  const html = '<body><p>info&#64;kaisha.co.jp</p></body>';
  assert.deepEqual(emails(html), ['info@kaisha.co.jp']);
});

test('script/style の中身をアドレスとして拾わない', () => {
  const html = `<body>
    <script>var contact="tracker@analytics-vendor.com";</script>
    <style>/* design@studio.example.jp */</style>
    <p>info@kaisha.co.jp</p></body>`;
  assert.deepEqual(emails(html), ['info@kaisha.co.jp']);
});

test('隣接要素のアドレスを連結しない（壊れた宛先を作らない）', () => {
  // cheerio の text() は区切りを入れないので、素直に連結すると
  // `kaisha.co.jprecruit@kaisha.co.jp` という実在しない宛先ができる。
  // ドメインは正しいので MX 確認も通ってしまい、ハードバウンスになる。
  const html = '<body><p>info@kaisha.co.jp</p><p>recruit@kaisha.co.jp</p></body>';
  assert.deepEqual(emails(html), ['info@kaisha.co.jp', 'recruit@kaisha.co.jp']);
});

/* ------------------------------ 窓口の分類 ------------------------------ */

test('窓口の種別を判定する', () => {
  assert.equal(classifyLocalPart('info'), 'info');
  assert.equal(classifyLocalPart('recruit'), 'recruit');
  assert.equal(classifyLocalPart('saiyo'), 'recruit');
  assert.equal(classifyLocalPart('contact'), 'contact');
  assert.equal(classifyLocalPart('otoiawase'), 'contact');
  assert.equal(classifyLocalPart('inquiry'), 'inquiry');
  assert.equal(classifyLocalPart('sales'), 'sales');
  assert.equal(classifyLocalPart('support'), 'support');
  assert.equal(classifyLocalPart('t.yamada'), 'other');
});

/* ------------------------------ 推測アドレス ------------------------------ */

test('推測アドレスは guessed 印と低い確度で作られる', () => {
  const g = guessRoleAddresses(DOMAIN);
  assert.deepEqual(g.map((e) => e.email), ['info@kaisha.co.jp', 'contact@kaisha.co.jp']);
  // 掲載の裏づけが無いので、掲載アドレスと同列に扱ってはいけない。
  for (const e of g) {
    assert.equal(e.source, 'guessed');
    assert.equal(e.pageUrl, null, '根拠ページが無いことが分かる状態であるべき');
    assert.ok(e.confidence < 0.3, `確度が高すぎる: ${e.confidence}`);
  }
});

test('抽出したアドレスは published 印になる（掲載の根拠が残る）', () => {
  const found = extractEmailsFromHtml('<body><p>info@kaisha.co.jp</p></body>', PAGE, DOMAIN);
  assert.equal(found[0].source, 'published');
  assert.equal(found[0].pageUrl, PAGE);
});
