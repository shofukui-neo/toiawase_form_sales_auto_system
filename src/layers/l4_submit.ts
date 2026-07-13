import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { CompanyRow, FormSchema, RenderedContent, FieldRole, DetectedField } from '../types.js';
import { config } from '../config.js';
import { BrowserSession } from '../browser/browser.js';
import { extractButtons } from '../browser/extract.js';
import { judgeResult, type Judgment } from './l5_result.js';
import { logger } from '../utils/logger.js';

const log = logger('L4');

/**
 * L4 — Input & submit (spec §4-L4). Implements the "Plan approve -> re-run"
 * pattern: never hold a session waiting for a human. Plan does a dry run and
 * screenshots a preview; Execute re-fills from scratch and sends for real.
 */

/** Text roles we type into the form (agree/postal/phone get special handling). */
const TEXT_ROLES: FieldRole[] = [
  'company', 'name', 'kana', 'email', 'email_confirm',
  'phone', 'department', 'subject', 'message', 'postal', 'address',
];

/** Convert katakana to hiragana (フクイ -> ふくい); leaves 'ー', spaces, other chars. */
function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Some forms label the reading 「ふりがな」and expect hiragana; detect from label/placeholder. */
function kanaWantsHiragana(field: DetectedField | undefined): boolean {
  if (!field) return false;
  const hint = `${field.labelText || ''} ${field.name || ''} ${field.id || ''}`;
  if (/フリガナ|カナ/.test(hint)) return false; // katakana explicitly requested
  return /ふりがな|ひらがな/.test(hint) || /[ぁ-ゖ]/.test(field.placeholder || '');
}

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
async function fillSplit(page: Page, selector: string, value: string): Promise<boolean> {
  // Note: split on whitespace + hyphen variants, but NOT the katakana long-vowel
  // 'ー' (U+30FC), which is a valid character inside kana values (コーポレーション).
  const parts = value.split(/[\s　\-‐－―]+/).filter(Boolean);
  if (parts.length < 2) return false;
  return page.evaluate(
    ({ sel, parts }) => {
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
        return st.display !== 'none' && st.visibility !== 'hidden';
      });
      if (inputs.length < 2) return false;
      const n = inputs.length;
      for (let i = 0; i < n; i++) {
        setVal(inputs[i], i < n - 1 ? parts[i] ?? '' : parts.slice(n - 1).join(''));
      }
      return true;
    },
    { sel: selector, parts },
  );
}

/** Fill every mapped, non-honeypot field. Shared by Plan and Execute so text is identical. */
async function fillForm(
  session: BrowserSession,
  page: Page,
  schema: FormSchema,
  content: RenderedContent,
): Promise<void> {
  for (const role of TEXT_ROLES) {
    const mapping = schema.mappings.find((m) => m.role === role);
    let value = content.values[role];
    if (!mapping || !value) continue;
    // Guard: never fill a field flagged as honeypot (defense in depth; ④).
    const field = schema.fields.find((f) => f.selector === mapping.selector);
    if (field?.honeypot) {
      log.warn(`skipping honeypot-flagged selector for role ${role}`);
      continue;
    }
    // Reading fields labelled 「ふりがな」expect hiragana, not katakana.
    if (role === 'kana' && kanaWantsHiragana(field)) value = toHiragana(value);
    try {
      if (field?.tag === 'select') {
        await page.locator(mapping.selector).first().selectOption({ label: value }).catch(async () => {
          // fall back to first non-empty option
          const opts = field.options ?? [];
          const pick = opts.find((o) => o && !/選択|please|--/.test(o));
          if (pick) await page.locator(mapping.selector).first().selectOption({ label: pick });
        });
      } else if (SPLITTABLE.has(role) && (await fillSplit(page, mapping.selector, value))) {
        // handled as a split group
      } else {
        await session.humanType(page, mapping.selector, value);
      }
      await session.humanDelay(120, 400);
    } catch (e) {
      log.warn(`fill failed role=${role} selector=${mapping.selector}: ${(e as Error).message}`);
    }
  }

  // Satisfy required, unmapped choice fields (category selects / radio groups)
  // so validation passes; prefers a neutral 「その他」 option, else the first.
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
  mkdirSync(config.artifactsDir, { recursive: true });
  const session = new BrowserSession({ seed: company.id + 1 });
  try {
    const page = await session.open();
    await page.goto(schema.formUrl, { waitUntil: 'domcontentloaded' });
    await fillForm(session, page, schema, content);

    const buttons = await extractButtons(page);
    const confirmBtn = buttons.find((b) => b.kind === 'confirm');

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

export interface ExecuteResult {
  judgment: Judgment;
  finalUrl: string;
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
  const session = new BrowserSession({ seed: company.id + 1 });
  try {
    const page = await session.open();
    await page.goto(schema.formUrl, { waitUntil: 'domcontentloaded' });
    const beforeUrl = page.url();
    await fillForm(session, page, schema, content);

    let buttons = await extractButtons(page);
    const confirmBtn = buttons.find((b) => b.kind === 'confirm');

    if (confirmBtn) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        page.locator(confirmBtn.selector).first().click(),
      ]);
      await session.humanDelay(600, 1400);
      // On the confirm screen, find the final submit button.
      buttons = await extractButtons(page);
    }

    const submitBtn =
      buttons.find((b) => b.kind === 'submit') ??
      // last resort on confirm screen: a lone button that's not "戻る/修正"
      buttons.find((b) => b.kind === 'other' && !/戻|修正|back|edit/i.test(b.text));

    if (!submitBtn) {
      return {
        judgment: { status: 'needs_review', detail: 'no submit button found after fill/confirm' },
        finalUrl: page.url(),
      };
    }

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
      page.locator(submitBtn.selector).first().click(),
    ]);
    await session.humanDelay(800, 1800);

    const judgment = await judgeResult({
      page,
      beforeUrl,
      captchaPresent: schema.hasCaptcha !== 'none',
    });
    log.info(`execute company=${company.id} -> ${judgment.status} (${judgment.detail})`);
    return { judgment, finalUrl: page.url() };
  } finally {
    await session.close();
  }
}
