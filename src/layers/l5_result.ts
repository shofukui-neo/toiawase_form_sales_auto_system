import type { Page } from 'playwright';
import type { SubmissionStatus } from '../types.js';
import { getVisibleText } from '../browser/extract.js';
import { logger } from '../utils/logger.js';

const log = logger('L5');

const SUCCESS_URL = /(thanks|thank-you|thankyou|complete|completed|finish|success|done|sent|受付|完了)/i;
const SUCCESS_TEXT = [
  '送信が完了',
  '送信完了',
  'ありがとうございました',
  'ありがとうございます',
  '受け付けました',
  '受付けました',
  '受付を完了',
  'お問い合わせを受け付',
  '正常に送信',
  'send complete',
  'thank you',
  'has been sent',
];
const ERROR_TEXT = [
  '必須',
  '入力してください',
  '選択してください',
  'エラー',
  '正しく入力',
  '未入力',
  'error',
  'required',
  'invalid',
  '確認してください',
];

export interface JudgeInput {
  page: Page;
  /** URL of the form before final submit — used to detect navigation. */
  beforeUrl: string;
  /** Whether a CAPTCHA was detected on the form (from L2 schema). */
  captchaPresent: boolean;
}

export interface Judgment {
  status: SubmissionStatus;
  detail: string;
}

/**
 * L5 — judge the outcome of an Execute submission (spec §4-L5).
 * Known limit: reCAPTCHA v3 silent failure is undetectable here (§11) — a v3
 * form that "looks successful" may still be dropped server-side.
 */
export async function judgeResult(input: JudgeInput): Promise<Judgment> {
  const { page, beforeUrl, captchaPresent } = input;
  let afterUrl = beforeUrl;
  let text = '';
  let formCount = 0;
  try {
    afterUrl = page.url();
    text = await getVisibleText(page);
    formCount = await page.locator('form').count();
  } catch (e) {
    return { status: 'needs_review', detail: `page read failed: ${(e as Error).message}` };
  }

  const navigated = afterUrl.replace(/\/$/, '') !== beforeUrl.replace(/\/$/, '');
  const successUrl = SUCCESS_URL.test(afterUrl);
  const successText = SUCCESS_TEXT.some((t) => text.includes(t));
  const errorText = ERROR_TEXT.some((t) => text.includes(t));

  // Success: navigated to a thanks page, or a success message, or the form vanished.
  if ((navigated && successUrl) || successText || (navigated && formCount === 0)) {
    const detail = `success signals: nav=${navigated} url=${successUrl} text=${successText} formGone=${formCount === 0}`;
    log.info(detail);
    // Honest caveat for v3 (§11): flag it in the detail for later calibration.
    if (captchaPresent) {
      return { status: 'submitted_success', detail: `${detail}; NOTE captcha present — possible v3 silent-fail` };
    }
    return { status: 'submitted_success', detail };
  }

  // Failure: still on the form with validation/error text.
  if (formCount > 0 && errorText) {
    return { status: 'failed', detail: `validation/error text present; url=${afterUrl}` };
  }

  // CAPTCHA blocked: form remained and captcha was present.
  if (formCount > 0 && captchaPresent) {
    return { status: 'captcha', detail: `form remained with captcha present; url=${afterUrl}` };
  }

  return {
    status: 'needs_review',
    detail: `indeterminate: navigated=${navigated} url=${afterUrl} forms=${formCount}`,
  };
}
