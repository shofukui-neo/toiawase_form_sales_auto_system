import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHomepage, registrableDomain, candidateDomain, coreName } from '../src/layers/l0_homepage.js';
import { scoreIcp } from '../src/layers/l0_list.js';
import type { IcpConfig } from '../src/config.js';
import type { SearchResult } from '../src/layers/websearch.js';

/** Build a fake search backend from a fixed result list. */
function fakeSearch(results: SearchResult[]) {
  return async (_q: string) => results;
}
/** Build a fake homepage fetcher keyed by host (www + apex both hit). */
function fakeFetch(pages: Record<string, string>) {
  return async (url: string) => {
    const host = new URL(url).host.replace(/^www\./, '');
    const html = pages[host];
    return html === undefined ? { status: 404, html: '', finalUrl: url } : { status: 200, html, finalUrl: url };
  };
}

test('registrableDomain: handles co.jp / jp / com and www', () => {
  assert.equal(registrableDomain('www.care21.co.jp'), 'care21.co.jp');
  assert.equal(registrableDomain('recruit.okaken.co.jp'), 'okaken.co.jp');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('sub.example.jp'), 'example.jp');
});

test('candidateDomain: keeps company subdomain on shared hosting, collapses otherwise', () => {
  // ISP-hosted company (komeri) must NOT collapse to the ISP domain.
  assert.equal(candidateDomain('www.komeri.bit.or.jp'), 'komeri.bit.or.jp');
  // Normal corporate domains collapse subdomains to the registrable apex.
  assert.equal(candidateDomain('recruit.okaken.co.jp'), 'okaken.co.jp');
  assert.equal(candidateDomain('www.care21.co.jp'), 'care21.co.jp');
});

test('resolveHomepage: shared-hosting company resolves to its subdomain, not the ISP', async () => {
  const results: SearchResult[] = [
    { title: 'ホームセンター｜株式会社コメリの公式企業サイト', url: 'https://www.komeri.bit.or.jp/', snippet: '' },
    { title: '企業概要｜株式会社コメリの公式企業サイト', url: 'https://www.komeri.bit.or.jp/company/', snippet: '' },
    { title: 'コメリ - Wikipedia', url: 'https://ja.wikipedia.org/wiki/コメリ', snippet: '' },
  ];
  const hp = await resolveHomepage('株式会社コメリ', { industry: 'ホームセンター' }, {
    search: fakeSearch(results), queryDelayMs: 0,
    fetchHtml: fakeFetch({ 'komeri.bit.or.jp': '<title>株式会社コメリの公式企業サイト</title><body>会社概要</body>' }),
  });
  assert.ok(hp);
  assert.equal(hp!.domain, 'komeri.bit.or.jp');
  assert.notEqual(hp!.domain, 'bit.or.jp');
  assert.equal(hp!.method, 'search+verified');
});

test('coreName: strips legal tokens', () => {
  assert.equal(coreName('株式会社ケア21'), 'ケア21');
  assert.equal(coreName('岡山県貨物運送株式会社'), '岡山県貨物運送');
  assert.equal(coreName('医療法人社団 めぐみ会'), 'めぐみ会');
});

test('resolveHomepage: picks + verifies the official site, rejects aggregators', async () => {
  const results: SearchResult[] = [
    { title: '岡山県貨物運送株式会社の会社概要【2026最新】', url: 'https://salesnow.jp/db/companies/9063', snippet: '' },
    { title: '岡山県貨物運送 - Wikipedia', url: 'https://ja.wikipedia.org/wiki/岡山県貨物運送', snippet: '' },
    { title: '会社案内 | 岡山県貨物運送株式会社', url: 'https://www.okaken.co.jp/company/', snippet: '' },
  ];
  const hp = await resolveHomepage(
    '岡山県貨物運送株式会社',
    { industry: '物流' },
    {
      search: fakeSearch(results), queryDelayMs: 0,
      fetchHtml: fakeFetch({
        'okaken.co.jp': '<title>岡山県貨物運送株式会社</title><body>会社概要 事業内容 お問い合わせ</body>',
      }),
    },
  );
  assert.ok(hp, 'should resolve');
  assert.equal(hp!.domain, 'okaken.co.jp');
  assert.equal(hp!.method, 'search+verified');
  // Aggregators must never be chosen.
  assert.ok(!hp!.alternatives.includes('salesnow.jp'));
  assert.ok(!hp!.alternatives.includes('wikipedia.org'));
});

test('resolveHomepage: unverified when homepage shows neither name nor corporate signal', async () => {
  const results: SearchResult[] = [
    { title: 'ランダム商事', url: 'https://random-shoji.co.jp/', snippet: '' },
    { title: 'ランダム商事 別ページ', url: 'https://random-shoji.co.jp/x', snippet: '' },
  ];
  const hp = await resolveHomepage('ランダム商事株式会社', {}, {
    search: fakeSearch(results), queryDelayMs: 0,
    fetchHtml: fakeFetch({ 'random-shoji.co.jp': '<title>Welcome</title><body>hello world</body>' }),
  });
  assert.ok(hp);
  assert.equal(hp!.method, 'search+unverified');
});

test('resolveHomepage: parked/for-sale domain is not verified', async () => {
  const results: SearchResult[] = [
    { title: 'つぶれた会社', url: 'https://gone.co.jp/', snippet: '' },
    { title: 'つぶれた会社 2', url: 'https://gone.co.jp/a', snippet: '' },
  ];
  const hp = await resolveHomepage('つぶれた会社', {}, {
    search: fakeSearch(results), queryDelayMs: 0,
    fetchHtml: fakeFetch({ 'gone.co.jp': '<title>お名前.com</title><body>このドメインは お名前.com で取得されています</body>' }),
  });
  assert.equal(hp!.method, 'search+unverified');
});

test('resolveHomepage: returns null when only blocked hosts are found', async () => {
  const results: SearchResult[] = [
    { title: 'x', url: 'https://ja.wikipedia.org/wiki/x', snippet: '' },
    { title: 'y', url: 'https://mynavi.jp/company/y', snippet: '' },
    { title: 'z', url: 'https://facebook.com/z', snippet: '' },
  ];
  const hp = await resolveHomepage('架空株式会社', {}, {
    search: fakeSearch(results), queryDelayMs: 0,
    fetchHtml: fakeFetch({}),
  });
  assert.equal(hp, null);
});

test('scoreIcp: sweet band + soft penalty (ICP v2)', () => {
  const icp: IcpConfig = {
    employees: { min: 100, max: 2000 },
    employeesSweet: { min: 300, max: 500 },
    targetIndustries: ['流通', '小売'],
    signals: ['新卒'],
    excludeKeywords: ['採用代行'],
    penalizeKeywords: ['スーパーマーケット'],
    competitorAts: ['HERP'],
  };
  const sweet = scoreIcp({ name: 'A流通', domain: 'a.co.jp', industry: '流通・小売・物販', employees: 400 }, icp);
  const plain = scoreIcp({ name: 'B流通', domain: 'b.co.jp', industry: '流通・小売・物販', employees: 1500 }, icp);
  assert.ok(sweet.score > plain.score, 'sweet band scores higher');

  const penalized = scoreIcp({ name: 'Cスーパーマーケット', domain: 'c.co.jp', industry: '流通・小売', employees: 400 }, icp);
  assert.ok(penalized.score < sweet.score, 'soft-exclude label is penalized');
  assert.equal(penalized.excluded, false, 'soft exclude is NOT a hard drop');

  const hard = scoreIcp({ name: 'D採用代行', domain: 'd.co.jp', industry: 'サービス' }, icp);
  assert.equal(hard.excluded, true);
});
