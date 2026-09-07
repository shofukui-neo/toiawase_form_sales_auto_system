import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { CompanyRow, FormSchema, RenderedContent, FieldRole, DetectedField } from '../types.js';
import { config } from '../config.js';
import { BrowserSession, withBrowserSlot } from '../browser/browser.js';
import { extractButtons, type ButtonInfo } from '../browser/extract.js';
import { judgeResult, type Judgment } from './l5_result.js';
import { shouldFillField, resolveFieldValue } from './fillPolicy.js';
import { logger } from '../utils/logger.js';

const log = logger('L4');

/**
 * L4 — Input & submit (spec §4-L4). Implements the "Plan approve -> re-run"
 * pattern: never hold a session waiting for a human. Plan does a dry run and
 * screenshots a preview; Execute re-fills from scratch and sends for real.
 */

/** Text roles we type into the form (agree/postal/phone get special handling). */
const TEXT_ROLES: FieldRole[] = [
  'company',
  'name', 'name_sei', 'name_mei',
  'kana', 'kana_sei', 'kana_mei',
  'email', 'email_confirm',
  'phone', 'phone1', 'phone2', 'phone3',
  'postal', 'postal1', 'postal2',
  'address', 'address_pref', 'address_city', 'address_street',
  'department', 'subject', 'message',
  // FAX は必須指定のフォームでのみ入る (shouldFillField が非コア役割を
  // 必須欄に限定する)。任意の FAX 欄には入力しない。
  'fax',
];

/**
 * Roles whose value may be split across several adjacent boxes:
 * phone 03-1234-5678, postal 160-0023, name 姓/名, kana セイ/メイ. Splitting only
 * happens when ≥2 sibling inputs are actually present, so single-field forms
 * (one 氏名 box) keep the whole value.
 */
const SPLITTABLE = new Set<FieldRole>(['phone', 'postal', 'name', 'kana']);

/**
 * Fill a value that may be split across sibling inputs (phone: 市外/市内/番号,
 * postal: 上3桁/下4桁). Detects a group of ≥2 visible small inputs in the same
 * container and distributes the hyphen/space-separated parts; otherwise returns
 * false so the caller types the whole value normally. Extra parts pack into the
 * last box so we never drop digits.
 */
async function fillSplit(
  page: Page,
  selector: string,
  value: string,
  reserved: string[],
): Promise<boolean> {
  // Note: split on whitespace + hyphen variants, but NOT the katakana long-vowel
  // 'ー' (U+30FC), which is a valid character inside kana values (コーポレーション).
  const parts = value.split(/[\s　\-‐－―]+/).filter(Boolean);
  if (parts.length < 2) return false;
  return page.evaluate(
    ({ sel, parts, reserved }) => {
      const setVal = (input: HTMLInputElement, v: string) => {
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) return false;
      const container = el.closest('tr, .form-row, .form-group, dd, li, fieldset, p, div') || el.parentElement;
      if (!container) return false;
      const inputs = (Array.from(container.querySelectorAll('input')) as HTMLInputElement[]).filter((i) => {
        const t = (i.getAttribute('type') || 'text').toLowerCase();
        if (!['text', 'tel', 'number'].includes(t)) return false;
        const st = window.getComputedStyle(i);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        // A sibling that belongs to another role (都道府県 / 市区町村 / 番地 sitting
        // in the same <div> as 郵便番号) must never receive a fragment of this
        // value — that is how "160" ends up in the 住所 box.
        return !reserved.some((r) => {
          try {
            return i.matches(r);
          } catch {
            return false;
          }
        });
      });
      if (inputs.length < 2) return false;
      const n = inputs.length;
      for (let i = 0; i < n; i++) {
        setVal(inputs[i], i < n - 1 ? parts[i] ?? '' : parts.slice(n - 1).join(''));
      }
      return true;
    },
    { sel: selector, parts, reserved },
  );
}

/**
 * Selectors that belong to some *other* control — every other mapped field plus
 * every honeypot. Passed to {@link fillSplit} so a value is only ever spread
 * across boxes that nothing else claims.
 */
function reservedSelectors(schema: FormSchema, own: string): string[] {
  const out = new Set<string>();
  for (const m of schema.mappings) if (m.selector !== own) out.add(m.selector);
  for (const f of schema.fields) if (f.honeypot) out.add(f.selector);
  return [...out];
}

/** Fill every mapped, non-honeypot field. Shared by Plan and Execute so text is identical. */
/** どの役割の欄が実際に埋まったか。送信可否の判断に使う。 */
export interface FillReport {
  failed: FieldRole[];
}

export async function fillForm(
  session: BrowserSession,
  page: Page,
  schema: FormSchema,
  content: RenderedContent,
): Promise<FillReport> {
  const failed: FieldRole[] = [];
  for (const role of TEXT_ROLES) {
    const mapping = schema.mappings.find((m) => m.role === role);
    if (!mapping) continue;
    // Guard: never fill a field flagged as honeypot (defense in depth; ④).
    const field = schema.fields.find((f) => f.selector === mapping.selector);
    if (field?.honeypot) {
      log.warn(`skipping honeypot-flagged selector for role ${role}`);
      continue;
    }
    // Fill policy: required + core identity only; skip optional付帯欄 (§承認済み).
    if (!shouldFillField(field, role)) continue;
    // Shared with the approval preview so the two can never diverge.
    const value = resolveFieldValue(field, role, content.values);
    if (!value) continue;
    try {
      if (field?.tag === 'select') {
        await page.locator(mapping.selector).first().selectOption({ label: value }).catch(async () => {
          // fall back to first non-empty option
          const opts = field.options ?? [];
          const pick = opts.find((o) => o && !/選択|please|--/.test(o));
          if (pick) await page.locator(mapping.selector).first().selectOption({ label: pick });
        });
      } else if (
        SPLITTABLE.has(role) &&
        (await fillSplit(page, mapping.selector, value, reservedSelectors(schema, mapping.selector)))
      ) {
        // handled as a split group
      } else {
        await session.humanType(page, mapping.selector, value);
      }
      await session.humanDelay(120, 400);
    } catch (e) {
      // 失敗した欄を必ず持ち帰る。ここで握りつぶすと、本文が空のまま送信ボタンを
      // 押してしまい、相手には氏名とメールだけの空の問い合わせが届く。しかも
      // 完了ページには遷移するので L5 は「成功」と記録する。
      failed.push(role);
      log.warn(`fill failed role=${role} selector=${mapping.selector}: ${(e as Error).message}`);
    }
  }

  // Required select/radio auto-selection (課題C). Value was resolved at parse
  // time (l2_choice) and carried on the mapping.
  for (const m of schema.mappings.filter((x) => x.role === 'choice')) {
    const field = schema.fields.find((f) => f.selector === m.selector);
    try {
      if (field?.tag === 'select') {
        const loc = page.locator(m.selector).first();
        await loc.selectOption({ label: m.value ?? '' }).catch(async () => {
          // label may not match exactly (whitespace/decoration) — try first real option
          const pick = (field.options ?? []).find((o) => o && !/選択|指定なし|please|--/.test(o));
          if (pick) await loc.selectOption({ label: pick });
        });
      } else {
        // radio (or radio-like): check the chosen control
        await page.locator(m.selector).first().check({ timeout: 5000 });
      }
      await session.humanDelay(120, 400);
    } catch (e) {
      log.warn(`choice fill failed ${m.selector}: ${(e as Error).message}`);
    }
  }

  // Safety net: satisfy any *required, unmapped* choice fields (category selects /
  // radio groups) the parser did not resolve above, so validation still passes;
  // prefers a neutral 「その他」 option, else the first. Skips already-mapped fields.
  await satisfyRequiredChoices(page, schema).catch((e) =>
    log.warn(`satisfyRequiredChoices failed: ${(e as Error).message}`),
  );

  // Consent checkboxes (agree). Many JP forms custom-style the checkbox and hide
  // the real <input> (display:none), which even Playwright force-check refuses to
  // toggle. So: try a normal/force check first, then fall back to setting checked
  // + dispatching input/change events via the DOM (works regardless of
  // visibility and still fires framework handlers that enable the submit button).
  for (const m of schema.mappings.filter((x) => x.role === 'agree')) {
    const loc = page.locator(m.selector).first();
    try {
      await loc.check({ force: true, timeout: 3000 });
    } catch {
      /* hidden custom checkbox — fall through to DOM toggle */
    }
    const checked = await loc.isChecked().catch(() => false);
    if (!checked) {
      try {
        await loc.evaluate((el: HTMLInputElement) => {
          el.checked = true;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('click', { bubbles: true }));
        });
      } catch (e) {
        log.warn(`agree check failed ${m.selector}: ${(e as Error).message}`);
      }
    }
  }

  return { failed };
}

/**
 * 送信前に、本文が本当にフォームへ入っているかを DOM から読み戻して確かめる。
 *
 * 例外が出なかったことは「入った」ことを意味しない。入力途中でフォームが
 * 再描画されればロケータは剥がれ、ブラウザが落ちれば途中までしか入らない。
 * それでも送信ボタンは押せてしまい、相手には氏名とメールだけの空の問い合わせが
 * 届く。完了ページには遷移するので L5 は「成功」と記録し、返信が来ないまま
 * 「アポ率 0%」として数えられる。**送る前にこちらから確認する。**
 */
export async function verifyBodyLanded(
  page: Page,
  schema: FormSchema,
  content: RenderedContent,
): Promise<{ ok: boolean; detail: string }> {
  const mapping = schema.mappings.find((m) => m.role === 'message');
  if (!mapping) return { ok: true, detail: 'message欄なし' };

  const actual = await page
    .locator(mapping.selector)
    .first()
    .inputValue({ timeout: 5000 })
    .catch(() => '');

  const flat = (t: string) => t.replace(/[\s　]+/g, '');
  const want = flat(content.body);
  const got = flat(actual);
  if (!got) return { ok: false, detail: '本文欄が空のまま' };

  // maxlength で切り詰められる分は許容する（L3 が事前に縮めているが、
  // フォーム側の実装差で数文字ずれることがある）。欠けが大きいものだけ止める。
  const ratio = got.length / Math.max(want.length, 1);
  if (ratio < 0.9) {
    return { ok: false, detail: `本文が途中までしか入っていない (${got.length}/${want.length}字)` };
  }
  return { ok: true, detail: `本文 ${got.length}字` };
}

/** A dropdown's default "please choose" style option (must be changed to validate). */
const isPlaceholderOpt = (s: string): boolean => {
  const t = (s || '').trim();
  return !t || /^(選択|お選び|ご選択|下記より|please|choose|select|--|―|▼|指定なし|未選択|なし)/i.test(t);
};

/** True when the options look like a Japanese prefecture picker. */
function isPrefectureList(labels: string[]): boolean {
  return labels.some((o) => o.includes('北海道')) && labels.some((o) => /東京都|大阪府/.test(o));
}

/** Prefecture parsed from the sender's configured address (e.g. 東京都), or null. */
function senderPrefecture(): string | null {
  const m = config.sender.address.match(/(東京都|北海道|京都府|大阪府|.{2,3}県)/);
  return m ? m[1] : null;
}

/**
 * Choose the best option index for a category/prefecture choice:
 *   1. prefecture list -> match the sender's prefecture
 *   2. a recruitment-related option (最適: 採用/新卒/人事…) — ideal for our pitch
 *   3. a neutral 「その他」
 *   4. first non-placeholder
 */
function pickChoiceIndex(labels: string[]): number {
  if (isPrefectureList(labels)) {
    const pref = senderPrefecture();
    if (pref) {
      const i = labels.findIndex((o) => o.includes(pref));
      if (i >= 0) return i;
    }
  }
  const recruit = labels.findIndex(
    (o) => /採用|新卒|中途|人事|人材|リクルート|エントリー|recruit|hr/i.test(o) && !isPlaceholderOpt(o),
  );
  if (recruit >= 0) return recruit;
  const other = labels.findIndex((o) => /その他|other|下記以外/i.test(o) && !isPlaceholderOpt(o));
  if (other >= 0) return other;
  return labels.findIndex((o) => !isPlaceholderOpt(o));
}

/**
 * Ensure unmapped choice fields (category selects & radio groups) hold a value so
 * client/server validation passes. A select is filled when it is required OR its
 * first option is a placeholder (「選択してください」等) — those must be changed. A
 * radio group is filled when required. Picks the most relevant option (see
 * pickChoiceIndex); a human reviews the preview, so a best-effort choice is safe.
 * Never touches honeypots or already-mapped fields.
 */
async function satisfyRequiredChoices(page: Page, schema: FormSchema): Promise<void> {
  const mapped = new Set(schema.mappings.map((m) => m.selector));

  // 1. <select> that is required, or defaults to a placeholder option.
  for (const f of schema.fields) {
    if (f.honeypot || f.tag !== 'select' || mapped.has(f.selector)) continue;
    const opts = f.options ?? [];
    const needsPick = f.required || (opts.length > 1 && isPlaceholderOpt(opts[0]));
    if (!needsPick) continue;
    const idx = pickChoiceIndex(opts);
    if (idx < 0) continue;
    try {
      await page.locator(f.selector).first().selectOption({ label: opts[idx] });
    } catch (e) {
      log.warn(`select fill failed ${f.selector}: ${(e as Error).message}`);
    }
  }

  // 2. Required radio groups (by name) with nothing checked -> check one option.
  const groups = new Map<string, DetectedField[]>();
  for (const f of schema.fields) {
    if (f.honeypot || (f.type || '') !== 'radio') continue;
    const key = f.name || f.selector;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  for (const group of groups.values()) {
    if (!group.some((f) => f.required)) continue;
    if (group.some((f) => mapped.has(f.selector))) continue;
    const idx = Math.max(0, pickChoiceIndex(group.map((f) => f.labelText ?? '')));
    const target = group[idx] ?? group[0];
    const loc = page.locator(target.selector).first();
    try {
      await loc.check({ force: true, timeout: 3000 });
      if (!(await loc.isChecked().catch(() => false))) {
        await loc.evaluate((el: HTMLInputElement) => {
          el.checked = true;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('click', { bubbles: true }));
        });
      }
    } catch (e) {
      log.warn(`required radio fill failed ${target.selector}: ${(e as Error).message}`);
    }
  }
}

export interface PlanResult {
  screenshotPath: string;
  /** True when a confirm screen was reached (button was safe to click). */
  reachedConfirmScreen: boolean;
  /** Diagnostic: which button strategy Plan used. */
  strategy: 'confirm-clicked' | 'filled-only';
}

/**
 * PLAN phase (dry run). Fills the form, clicks a confirm button if present
 * (never a final submit), screenshots the preview, then DISCARDS the session.
 * Absolutely never performs a final submit (spec §4-L4 step 3).
 */
export async function planSubmission(
  company: CompanyRow,
  schema: FormSchema,
  content: RenderedContent,
): Promise<PlanResult> {
  // プランは取り込み側の処理。送信 (Execute) に枠を譲る通常優先度で待つ。
  return withBrowserSlot(() => planSubmissionInSlot(company, schema, content));
}

async function planSubmissionInSlot(
  company: CompanyRow,
  schema: FormSchema,
  content: RenderedContent,
): Promise<PlanResult> {
  mkdirSync(config.artifactsDir, { recursive: true });
  const session = new BrowserSession({ seed: company.id + 1 });
  try {
    const page = await session.open();
    await page.goto(schema.formUrl, { waitUntil: 'domcontentloaded' });
    await fillForm(session, page, schema, content);

    const buttons = await extractButtons(page);
    const confirmBtn = pickButton(buttons, 'confirm');

    let reachedConfirmScreen = false;
    let strategy: PlanResult['strategy'] = 'filled-only';

    if (confirmBtn) {
      // A confirm button does NOT send — safe to click to reach the preview screen.
      try {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
          page.locator(confirmBtn.selector).first().click(),
        ]);
        await session.humanDelay(500, 1200);
        reachedConfirmScreen = true;
        strategy = 'confirm-clicked';
      } catch (e) {
        log.warn(`confirm click failed: ${(e as Error).message}`);
      }
    }
    // If only a submit button exists (1-step form), we do NOT click it — the
    // filled form itself is the preview.

    const screenshotPath = resolve(config.artifactsDir, `plan_${company.id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log.info(`plan ready company=${company.id} strategy=${strategy} shot=${screenshotPath}`);
    return { screenshotPath, reachedConfirmScreen, strategy };
  } finally {
    // Step 3: discard the session. Never keep it alive for approval.
    await session.close();
  }
}

/**
 * 送信直後の画面を残す。証拠が無い送信は検証できず、検証できない数字では
 * 何を変えれば返信が増えるのか判断できない。撮影の失敗は送信結果より軽いので
 * 例外は握りつぶし、パスが取れなければ null を返す。
 */
async function captureResult(page: Page, companyId: number, tag: string): Promise<string | null> {
  const path = resolve(config.artifactsDir, `result_${companyId}.png`);
  try {
    await page.screenshot({ path, fullPage: true, timeout: 10000 });
    return path;
  } catch (e) {
    log.warn(`result screenshot failed company=${companyId} (${tag}): ${(e as Error).message}`);
    return null;
  }
}

/**
 * 押してよいボタンを選ぶ。
 *
 * 旧実装の最終手段は「戻る/修正 以外の最初のボタン」だった。これはページ上の
 * どのボタンでも該当してしまい、実際にはハンバーガーメニューや Google 翻訳
 * ウィジェットを押しに行っていた（`needs_review` 241 件の click タイムアウト）。
 * 見えないボタン・フォームの外のボタンは、どれだけ他に候補が無くても押さない。
 * 押せる候補が無いなら「無い」と報告するほうが、無関係な要素を押して 20 秒
 * 待たされたうえで失敗するより速く、原因も残る。
 */
export function pickButton(buttons: ButtonInfo[], kind: 'confirm' | 'submit'): ButtonInfo | undefined {
  // 見えていないものと、押すと入力が消えるもの（戻る/修正/リセット）を先に落とす。
  // 非表示要素の click は actionability 待ちで必ず 20 秒溶かすし、「修正する」を
  // 押せば入力が失われたうえで送信済みに見える画面になりかねない。
  const clickable = buttons.filter((b) => b.visible && !b.inChrome && !b.negative && !b.disabled);
  const named = clickable.find((b) => b.kind === kind && b.inForm) ?? clickable.find((b) => b.kind === kind);
  if (named || kind === 'confirm') return named;
  // 確認画面には「送信」と書かれていないボタン（例: 「この内容でよろしければ」）
  // しか無いことがある。ただしフォームの内側にあるものに限る。
  return clickable.find((b) => b.kind === 'other' && b.inForm);
}

export interface ExecuteResult {
  judgment: Judgment;
  finalUrl: string;
  /**
   * 送信直後の画面のスクリーンショット。**これが無いと「成功」と記録された行を
   * 後から検証する手段が一切ない。** 実際、旧実装では plan の 2,256 枚に対し
   * 結果の証拠は 0 枚で、届いていない送信を成功として数え続けていた。
   */
  resultScreenshotUrl: string | null;
}

/**
 * EXECUTE phase. Fresh session, re-fills identically, then drives
 * confirm -> final submit (or direct submit on 1-step forms) and judges (L5).
 */
export async function executeSubmission(
  company: CompanyRow,
  schema: FormSchema,
  content: RenderedContent,
): Promise<ExecuteResult> {
  // 送信は優先枠。送信可能時間帯 (§9) と日次上限の中でしか動けないので、
  // 何時間走ってもよい取り込み側の発見処理の後ろに並ばせない。
  return withBrowserSlot(() => executeSubmissionInSlot(company, schema, content), {
    priority: true,
  });
}

async function executeSubmissionInSlot(
  company: CompanyRow,
  schema: FormSchema,
  content: RenderedContent,
): Promise<ExecuteResult> {
  const session = new BrowserSession({ seed: company.id + 1 });
  try {
    const page = await session.open();
    await page.goto(schema.formUrl, { waitUntil: 'domcontentloaded' });
    const beforeUrl = page.url();
    const fill = await fillForm(session, page, schema, content);

    // 本文が入っていないなら送らない。空の問い合わせを送るくらいなら
    // 送らずに人へ回すほうがよい。相手に一度でも空文を送れば、その企業は
    // 二度と使えなくなる（抑制リストに載り、印象も最悪になる）。
    const bodyCheck = await verifyBodyLanded(page, schema, content);
    if (!bodyCheck.ok || fill.failed.includes('message')) {
      const shot = await captureResult(page, company.id, 'nobody');
      return {
        judgment: {
          status: 'needs_review',
          detail: `送信中止: ${bodyCheck.detail}${fill.failed.length ? ` / 入力失敗=${fill.failed.join(',')}` : ''}`,
        },
        finalUrl: page.url(),
        resultScreenshotUrl: shot,
      };
    }

    let buttons = await extractButtons(page);
    const confirmBtn = pickButton(buttons, 'confirm');

    if (confirmBtn) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        // タイムアウトを 20 秒から 8 秒へ。押せない要素を選んでしまった場合に
        // 20 秒待つ意味は無く、その間ブラウザ枠を占有して 1 日の送信数を削る。
        page.locator(confirmBtn.selector).first().click({ timeout: 8000 }),
      ]);
      await session.humanDelay(600, 1400);
      // On the confirm screen, find the final submit button.
      buttons = await extractButtons(page);
    }

    const submitBtn = pickButton(buttons, 'submit');

    if (!submitBtn) {
      const shot = await captureResult(page, company.id, 'nosubmit');
      // どのボタンが候補にすら挙がらなかったのかを残す。これが無いと、
      // フォームが iframe の中にあるのか、画像ボタンなのか、単に文言が
      // 想定外なのかを後から切り分けられない。
      const seen = buttons
        .slice(0, 6)
        .map(
          (b) =>
            `${b.text.slice(0, 12) || '(無題)'}[${b.kind}${b.visible ? '' : ',不可視'}` +
            `${b.disabled ? ',無効' : ''}${b.inForm ? '' : ',フォーム外'}]`,
        )
        .join(' / ');
      // 送信ボタンが disabled のまま残っているなら、ボタンが無いのではなく
      // 「同意チェックが入っていない」possibility が高い。原因が違えば直し方も
      // 違うので、同じ needs_review でも区別できる文言にする。
      const blockedByConsent = buttons.some((b) => b.disabled && b.visible && !b.negative);
      const reason = blockedByConsent
        ? '送信ボタンが無効のまま（同意チェック未完了の可能性）'
        : '送信ボタンを特定できず';
      return {
        judgment: {
          status: 'needs_review',
          detail: `${reason}（候補 ${buttons.length} 件: ${seen || 'なし'}）`,
        },
        finalUrl: page.url(),
        resultScreenshotUrl: shot,
      };
    }

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
      page.locator(submitBtn.selector).first().click({ timeout: 8000 }),
    ]);
    await session.humanDelay(800, 1800);

    const judgment = await judgeResult({
      page,
      beforeUrl,
      captchaPresent: schema.hasCaptcha !== 'none',
      // 入力した本文が送信後のページに残っているかを見るため L5 に渡す。
      sentBody: content.body,
    });
    // 判定の後で撮る。判定が例外を投げても送信自体は済んでいるので、
    // 証拠取得の失敗で結果を握りつぶさないよう captureResult は投げない。
    const resultScreenshotUrl = await captureResult(page, company.id, judgment.status);
    log.info(`execute company=${company.id} -> ${judgment.status} (${judgment.detail})`);
    return { judgment, finalUrl: page.url(), resultScreenshotUrl };
  } finally {
    await session.close();
  }
}
