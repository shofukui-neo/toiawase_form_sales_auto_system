import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import type { CompanyRow, FormSchema, RenderedContent, FieldRole } from '../types.js';
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

/** Roles we actually type into the form (agree handled as a checkbox). */
const TEXT_ROLES: FieldRole[] = [
  'company', 'name', 'kana', 'email', 'phone', 'department', 'subject', 'message',
];

/** Fill every mapped, non-honeypot field. Shared by Plan and Execute so text is identical. */
async function fillForm(
  session: BrowserSession,
  page: Page,
  schema: FormSchema,
  content: RenderedContent,
): Promise<void> {
  for (const role of TEXT_ROLES) {
    const mapping = schema.mappings.find((m) => m.role === role);
    const value = content.values[role];
    if (!mapping || !value) continue;
    // Guard: never fill a field flagged as honeypot (defense in depth; ④).
    const field = schema.fields.find((f) => f.selector === mapping.selector);
    if (field?.honeypot) {
      log.warn(`skipping honeypot-flagged selector for role ${role}`);
      continue;
    }
    try {
      if (field?.tag === 'select') {
        await page.locator(mapping.selector).first().selectOption({ label: value }).catch(async () => {
          // fall back to first non-empty option
          const opts = field.options ?? [];
          const pick = opts.find((o) => o && !/選択|please|--/.test(o));
          if (pick) await page.locator(mapping.selector).first().selectOption({ label: pick });
        });
      } else {
        await session.humanType(page, mapping.selector, value);
      }
      await session.humanDelay(120, 400);
    } catch (e) {
      log.warn(`fill failed role=${role} selector=${mapping.selector}: ${(e as Error).message}`);
    }
  }

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
