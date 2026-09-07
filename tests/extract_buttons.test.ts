import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../src/browser/browser.js';
import { extractButtons, type ButtonInfo } from '../src/browser/extract.js';

/**
 * 本番で実際に押しに行っていた要素を再現する回帰テスト。
 *
 * 送信結果の `needs_review` 514 件のうち 241 件（46.9%）は click の 20 秒
 * タイムアウトで、その待ち先は `#cboxPrevious`（ライトボックスの「前へ」）、
 * `body > header > button`（ハンバーガーメニュー）、`#goog-gt-thumbUpButton`
 * （Google 翻訳ウィジェット）だった。いずれも非表示か、フォームの外にある。
 * 旧実装はページ全体のボタンを可視性を見ずに集め、呼び出し側が DOM 順の
 * 先頭を押していたため、こうなっていた。
 */

/** 典型的な企業サイトの問い合わせページ。ページ共通部品と装飾が乗っている。 */
const PAGE = `
<header>
  <button id="nav-toggle">メニュー</button>
</header>
<nav><div><button id="lang">English</button></div></nav>

<!-- Google 翻訳ウィジェット: 非表示のまま DOM に残る -->
<div id="goog-gt-tt" style="display:none">
  <button id="goog-gt-thumbUpButton" aria-label="良い翻訳">👍</button>
</div>

<!-- Colorbox ライトボックス: 閉じている間も DOM にいる -->
<div id="colorbox" style="display:none">
  <button id="cboxPrevious">前へ</button>
  <button id="cboxClose">閉じる</button>
</div>

<form action="/confirm" method="post">
  <input name="company">
  <textarea name="message"></textarea>
  <input type="button" id="reset-btn" value="リセット">
  <input type="submit" id="real-submit" value="入力内容を確認する">
</form>

<footer><button id="pagetop">ページ上部へ</button></footer>
`;

/**
 * ページは必ず BrowserSession 経由で開く。tsx (esbuild keepNames) は
 * page.evaluate に渡す関数へ `__name` 呼び出しを差し込むため、素の
 * chromium.newPage() では実行時に ReferenceError になる。BrowserSession が
 * 使う playwright-extra 側でこのヘルパが供給されるので、本番と同じ経路で
 * 開けば通る。本番コードは常にこちらを通る。
 */
async function buttonsOf(html: string): Promise<ButtonInfo[]> {
  const session = new BrowserSession({ seed: 7 });
  try {
    const page = await session.open();
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    return await extractButtons(page);
  } finally {
    await session.close();
  }
}

/** 本番コードと同じ選び方（l4_submit.pickButton と同じ規則）。 */
function pick(buttons: ButtonInfo[], kind: 'confirm' | 'submit'): ButtonInfo | undefined {
  const clickable = buttons.filter((b) => b.visible && !b.inChrome && !b.negative && !b.disabled);
  const named = clickable.find((b) => b.kind === kind && b.inForm) ?? clickable.find((b) => b.kind === kind);
  if (named || kind === 'confirm') return named;
  return clickable.find((b) => b.kind === 'other' && b.inForm);
}

test('非表示のライトボックス／翻訳ウィジェットのボタンを押せる候補にしない', async () => {
  const buttons = await buttonsOf(PAGE);
  const byId = (id: string) => buttons.find((b) => b.selector === `#${id}`);

  assert.equal(byId('cboxPrevious')?.visible, false, '#cboxPrevious は非表示のはず');
  assert.equal(byId('goog-gt-thumbUpButton')?.visible, false, 'Google翻訳ボタンは非表示のはず');

  const clickable = buttons.filter((b) => b.visible && !b.inChrome);
  for (const bad of ['cboxPrevious', 'goog-gt-thumbUpButton', 'nav-toggle', 'lang']) {
    assert.ok(
      !clickable.some((b) => b.selector === `#${bad}`),
      `${bad} が押せる候補に残っている`,
    );
  }
});

test('ページ共通部品（header / nav / footer）の中のボタンに印が付く', async () => {
  const buttons = await buttonsOf(PAGE);
  const byId = (id: string) => buttons.find((b) => b.selector === `#${id}`);
  assert.equal(byId('nav-toggle')?.inChrome, true);
  assert.equal(byId('lang')?.inChrome, true);
  assert.equal(byId('pagetop')?.inChrome, true);
  assert.equal(byId('real-submit')?.inChrome, false);
  assert.equal(byId('real-submit')?.inForm, true);
});

test('確認ボタンとして、フォーム内の本物だけが選ばれる', async () => {
  const buttons = await buttonsOf(PAGE);
  const chosen = pick(buttons, 'confirm');
  assert.equal(chosen?.selector, '#real-submit');
});

test('リセットボタンを送信ボタンとして選ばない（入力が消える）', async () => {
  const html = `<form><textarea name="message"></textarea>
    <input type="button" id="reset-btn" value="リセット">
    <button id="go">この内容で送信する</button></form>`;
  const buttons = await buttonsOf(html);
  const chosen = pick(buttons, 'submit');
  assert.equal(chosen?.selector, '#go');
  assert.equal(buttons.find((b) => b.selector === '#reset-btn')?.kind, 'other');
});

test('確認画面に「送信」と書かれたボタンが無くても、フォーム内なら拾う', async () => {
  const html = `<header><button id="menu">メニュー</button></header>
    <form><p>以下の内容でよろしいですか</p>
      <button id="back">修正する</button>
      <button id="go">はい</button></form>`;
  const buttons = await buttonsOf(html);
  const chosen = pick(buttons, 'submit');
  assert.equal(chosen?.selector, '#go', '「はい」を拾えていない');
});

test('押せるボタンが一つも無ければ、無いと答える（無関係な要素を押さない）', async () => {
  const html = `<header><button id="menu">メニュー</button></header>
    <div id="modal" style="display:none"><button id="x">送信</button></div>
    <p>お問い合わせは電話でお願いします</p>`;
  const buttons = await buttonsOf(html);
  assert.equal(pick(buttons, 'submit'), undefined);
});

test('送信ボタンらしい順に並んでいる（呼び出し側は先頭から試せる）', async () => {
  const buttons = await buttonsOf(PAGE);
  assert.equal(buttons[0].selector, '#real-submit');
});

test('同意チェック待ちで disabled のボタンは、候補から消さずに無効と印を付ける', async () => {
  // 日本企業のフォームに多い作り: 個人情報の同意にチェックが入るまで
  // 送信ボタンが disabled のまま。これを候補から消してしまうと
  // 「送信ボタンが存在しない」と報告され、実際の原因に辿り着けない。
  const html = `<form>
    <textarea name="message"></textarea>
    <label><input type="checkbox" name="agree"> 個人情報の取扱いに同意する</label>
    <button id="confirm-btn" disabled>確認画面へ</button>
  </form>`;
  const buttons = await buttonsOf(html);
  const btn = buttons.find((b) => b.selector === '#confirm-btn');
  assert.ok(btn, '無効なボタンが候補から消えている');
  assert.equal(btn!.disabled, true);
  assert.equal(btn!.visible, true, '無効でも画面には見えている');
  assert.equal(btn!.kind, 'confirm');
  // 押しはしない（押しても何も起きずタイムアウトするだけ）。
  assert.equal(pick(buttons, 'confirm'), undefined);
});

test('同意チェックを入れれば、同じボタンが押せる候補になる', async () => {
  const html = `<form>
    <label><input type="checkbox" id="agree"> 同意する</label>
    <button id="confirm-btn" disabled>確認画面へ</button>
    <script>document.getElementById('agree').addEventListener('change', function(){
      document.getElementById('confirm-btn').disabled = !this.checked;
    });</script>
  </form>`;
  const session = new BrowserSession({ seed: 9 });
  try {
    const page = await session.open();
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    assert.equal(pick(await extractButtons(page), 'confirm'), undefined, '未チェックでは押せないはず');
    await page.locator('#agree').check();
    const chosen = pick(await extractButtons(page), 'confirm');
    assert.equal(chosen?.selector, '#confirm-btn');
  } finally {
    await session.close();
  }
});
