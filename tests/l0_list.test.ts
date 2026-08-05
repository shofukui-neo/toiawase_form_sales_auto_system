import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompaniesCsv, detectColumns } from '../src/layers/l0_list.js';
import { normalizeDomain } from '../src/utils/url.js';

/**
 * A real SFA/CRM lead export: the company website lives in `Webサイト`, while
 * `リードURL` is the CRM's own per-lead page — same host on every row. Mapping
 * the latter as the domain collapses the entire list onto one company
 * (companies.domain is UNIQUE), which is how a whole import can vanish before
 * ever reaching the approval queue.
 */
const CRM_CSV = `会社名,電話,担当者姓,担当者名,役職,部署,リードステージ,リード所有者,従業員規模,業種,都道府県,コール日時,コールコメント,Webサイト,リードURL,リードID
アララ株式会社,03-5414-3611,奥原,杏奈,,,05：コンバート,,,,東京都,2026-07-03 11:10,音声案内、問い合わせ,https://www.arara.com,https://mochica.balescloud.jp/app/lead-list?callTargetId=6205386,6205386
サムテック株式会社,072-977-8851,小林,,,,99：アーカイブ,,,,大阪府,2025-01-21 11:13,"小林さん 男性、ネオ他部署と付き合いあり",http://www.samtech.co.jp,https://mochica.balescloud.jp/app/lead-list?callTargetId=15262341,15262341
センコー情報システム株式会社,06-7709-1129,山内,,,,リサイクル,,,,,2025-12-18 17:13,東京の本社で採用行っている,,https://mochica.balescloud.jp/app/lead-list?callTargetId=6482953,6482953`;

test('CRM export: 会社サイト列を読み、リードURL列は無視する', () => {
  const rows = parseCompaniesCsv(CRM_CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['アララ株式会社', 'サムテック株式会社', 'センコー情報システム株式会社'],
  );
  assert.deepEqual(
    rows.map((r) => normalizeDomain(r.domain)),
    ['arara.com', 'samtech.co.jp', ''],
  );
  // Distinct domains — the collapse-onto-one-company failure must not recur.
  const filled = rows.map((r) => normalizeDomain(r.domain)).filter(Boolean);
  assert.equal(new Set(filled).size, filled.length);
  assert.ok(filled.every((d) => !d.includes('balescloud')));
});

test('CRM export: 企業属性の列だけを拾い、担当者・コール列は拾わない', () => {
  const cols = detectColumns(CRM_CSV);
  assert.equal(cols.name, '会社名');
  assert.equal(cols.domain, 'Webサイト');
  assert.equal(cols.industry, '業種');
  assert.equal(cols.employees, '従業員規模');
  assert.equal(cols.prefecture, '都道府県');
  const rows = parseCompaniesCsv(CRM_CSV);
  assert.deepEqual(rows.map((r) => r.prefecture), ['東京都', '大阪府', undefined]);
  // 担当者名/リードステージ が名前や出典に混入していないこと。
  assert.ok(rows.every((r) => !r.source));
});

test('ヘッダ無し・名前だけのリストは1社目を落とさない', () => {
  const rows = parseCompaniesCsv('株式会社アルファ\n有限会社ベータ\nガンマ工業株式会社');
  assert.deepEqual(rows.map((r) => r.name), ['株式会社アルファ', '有限会社ベータ', 'ガンマ工業株式会社']);
  assert.ok(rows.every((r) => !r.domain));
});

test('ヘッダ無し 会社名,ドメイン の位置指定は従来どおり', () => {
  const rows = parseCompaniesCsv('株式会社アルファ,alpha.co.jp\n有限会社ベータ,beta.jp');
  assert.deepEqual(rows.map((r) => r.domain), ['alpha.co.jp', 'beta.jp']);
});

test('会社URL は domain 側に割り当てられ name を奪わない', () => {
  const rows = parseCompaniesCsv('企業名,会社URL,業種\nテスト株式会社,https://test.example.jp,IT');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'テスト株式会社');
  assert.equal(normalizeDomain(rows[0].domain), 'test.example.jp');
  assert.equal(rows[0].industry, 'IT');
});

test('英語ヘッダも従来どおり動く', () => {
  const rows = parseCompaniesCsv('name,website,industry,employees\nAcme Inc,https://acme.example.com,SaaS,320');
  assert.equal(rows[0].name, 'Acme Inc');
  assert.equal(normalizeDomain(rows[0].domain), 'acme.example.com');
  assert.equal(rows[0].employees, 320);
});
