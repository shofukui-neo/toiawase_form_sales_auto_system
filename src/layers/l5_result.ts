import type { Page } from 'playwright';
import type { SubmissionStatus } from '../types.js';
import { getVisibleText } from '../browser/extract.js';
import { logger } from '../utils/logger.js';

const log = logger('L5');

/**
 * L5 — 送信結果の判定 (spec §4-L5)。
 *
 * **なぜ書き直したか。** 旧実装は「ページ本文に成功文言が含まれる」だけで
 * `submitted_success` にしていた。日本企業のサイトでは「ありがとうございます」
 * 「お問い合わせいただきありがとうございます」はフォーム画面そのものの見出し・
 * 定型挨拶として常時出ている。その結果、**1度も画面が遷移していない送信**が
 * 成功として 155/494 件記録されていた（＝実際には届いていない可能性が高い）。
 * さらに成功判定をエラー判定より先に行っていたため、バリデーションで弾かれた
 * 画面も成功になり得た。
 *
 * 判定の原則を「画面に成功文言があるか」から
 * **「送信前の状態から実際に変化したという証拠があるか」** に変える。
 * 最も強い証拠は *入力した本文がページから消えたこと*。フォームに自分の
 * 1000 字の本文がまだ表示されているなら、何が書いてあろうと送信されていない。
 *
 * 判定できないものは `uncertain` に落とす。成功と偽られた行が混ざった母数では
 * 返信率もアポ率も計算できず、改善の試行錯誤が成立しないため、
 * 「分からない」を正直に別バケットへ出すこと自体が計測の前提になる。
 */

const SUCCESS_URL = /(thanks|thank-you|thankyou|complete|completed|finish|success|done|sent|受付|完了)/i;

/**
 * 「これが出ていれば送信された」と言い切れる文言。フォーム画面の常設コピーには
 * まず現れない（送信という動作の完了を述べている）ものだけを置く。
 */
const STRONG_SUCCESS_TEXT = [
  '送信が完了',
  '送信完了',
  '送信いたしました',
  '送信しました',
  '受け付けました',
  '受付けました',
  '受付を完了',
  'お問い合わせを受け付',
  'お問い合わせありがとうございました',
  '正常に送信',
  '自動返信',
  'send complete',
  'has been sent',
  'successfully sent',
  'submission received',
];

/**
 * 単体では何の証拠にもならない文言。フォーム画面の挨拶文としてありふれている
 * ため、**画面が変化したこと**と併せてのみ成功の補強に使う。
 */
const WEAK_SUCCESS_TEXT = ['ありがとうございました', 'ありがとうございます', 'thank you'];

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
  'もう一度',
];

/**
 * 確認画面の文言。ここで止まっている＝最後の「送信する」を押せていない。
 * 確認画面は URL に /confirm/ を含み本文が消えていないことも多く、旧実装では
 * 「遷移した＋フォーム要素なし」で成功と誤判定され得た。届いていないので
 * 成功に数えてはならない。
 */
const CONFIRM_SCREEN_TEXT = [
  'この内容で送信',
  '内容をご確認',
  '内容を確認',
  '下記の内容で',
  '以下の内容で',
  '確認画面',
  '入力内容の確認',
  'ご確認ください',
];
const CONFIRM_URL = /(confirm|kakunin|check|preview)/i;

export interface JudgeInput {
  page: Page;
  /** URL of the form before final submit — used to detect navigation. */
  beforeUrl: string;
  /** Whether a CAPTCHA was detected on the form (from L2 schema). */
  captchaPresent: boolean;
  /**
   * 実際に入力した本文。送信後のページにこれが残っているかどうかが
   * 「本当に送ったのか」の最も信頼できる指標になる。
   */
  sentBody?: string;
}

export interface Judgment {
  status: SubmissionStatus;
  detail: string;
  /** 送信後ページの可視テキスト（先頭のみ）。後から人が監査するための証拠。 */
  evidenceText?: string;
}

/**
 * 本文の「指紋」。全文一致を見ると改行やスペースの正規化で外れるので、
 * 装飾や社名を含まない中盤の一節を取り、空白を落として比較する。
 */
function bodyFingerprint(body: string): string | null {
  const flat = body.replace(/[\s　]+/g, '');
  if (flat.length < 60) return null;
  return flat.slice(20, 60);
}

export async function judgeResult(input: JudgeInput): Promise<Judgment> {
  const { page, beforeUrl, captchaPresent, sentBody } = input;
  let afterUrl = beforeUrl;
  let text = '';
  let formCount = 0;
  let filledCount = 0;
  try {
    afterUrl = page.url();
    text = await getVisibleText(page);
    formCount = await page.locator('form').count();
    // 値の入ったテキストエリアが残っているか。残っていれば入力画面のまま。
    filledCount = await page
      .$$eval('textarea', (els) => els.filter((e) => (e as HTMLTextAreaElement).value.trim().length > 30).length)
      .catch(() => 0);
  } catch (e) {
    return { status: 'needs_review', detail: `page read failed: ${(e as Error).message}` };
  }

  const evidenceText = text.replace(/\s+/g, ' ').trim().slice(0, 600);
  const norm = (u: string) => u.replace(/\/$/, '');
  const navigated = norm(afterUrl) !== norm(beforeUrl);

  // 送信した本文がページから消えたか。消えていれば入力画面を離れている。
  const fp = sentBody ? bodyFingerprint(sentBody) : null;
  const flatPage = text.replace(/[\s　]+/g, '');
  const bodyStillOnPage = fp ? flatPage.includes(fp) : false;
  const bodyGone = fp ? !bodyStillOnPage : false;

  const successUrl = SUCCESS_URL.test(afterUrl);
  const strongSuccess = STRONG_SUCCESS_TEXT.some((t) => text.includes(t));
  const weakSuccess = WEAK_SUCCESS_TEXT.some((t) => text.includes(t));
  const errorText = ERROR_TEXT.some((t) => text.includes(t));
  const confirmScreen =
    (CONFIRM_SCREEN_TEXT.some((t) => text.includes(t)) || CONFIRM_URL.test(afterUrl)) && !strongSuccess;

  const sig =
    `nav=${navigated} url=${successUrl} strong=${strongSuccess} weak=${weakSuccess} ` +
    `err=${errorText} confirm=${confirmScreen} forms=${formCount} filled=${filledCount} bodyGone=${bodyGone}`;

  // ---- 1. 入力画面のまま：まだ何も送れていない ------------------------------
  // 本文がページに残っている／値の入ったテキストエリアが残っているなら、
  // 画面に何が書いてあろうと送信は成立していない。成功文言より先に判定する。
  if (bodyStillOnPage || filledCount > 0) {
    if (errorText)
      return { status: 'failed', detail: `入力画面のまま＋エラー文言: ${sig}; url=${afterUrl}`, evidenceText };
    if (confirmScreen)
      return {
        status: 'uncertain',
        detail: `確認画面で停止（最終送信に到達せず）: ${sig}; url=${afterUrl}`,
        evidenceText,
      };
    if (captchaPresent)
      return { status: 'captcha', detail: `入力画面のまま＋CAPTCHA: ${sig}`, evidenceText };
    return { status: 'uncertain', detail: `入力内容が画面に残ったまま: ${sig}; url=${afterUrl}`, evidenceText };
  }

  // ---- 2. エラーを成功より先に見る -----------------------------------------
  // 旧実装は成功文言を先に見ていたため、「ありがとうございます（挨拶）」と
  // 「必須項目が未入力です（エラー）」が同じ画面にある場合に成功としていた。
  if (formCount > 0 && errorText && !strongSuccess) {
    return { status: 'failed', detail: `validation/error text present: ${sig}; url=${afterUrl}`, evidenceText };
  }

  // ---- 3. 確認画面で止まっている -------------------------------------------
  if (confirmScreen) {
    return { status: 'uncertain', detail: `確認画面と判断（未送信の可能性）: ${sig}; url=${afterUrl}`, evidenceText };
  }

  // ---- 4. 成功：状態が変わった証拠を伴う場合のみ ----------------------------
  const stateChanged = navigated || bodyGone || formCount === 0;
  const success =
    (navigated && successUrl) ||
    (strongSuccess && stateChanged) ||
    (weakSuccess && navigated && formCount === 0) ||
    (bodyGone && navigated && formCount === 0);

  if (success) {
    log.info(`success: ${sig}`);
    if (captchaPresent) {
      // reCAPTCHA v3 はサーバ側で黙って捨てられても画面は成功に見える (§11)。
      return {
        status: 'submitted_success',
        detail: `${sig}; NOTE captcha present — possible v3 silent-fail`,
        evidenceText,
      };
    }
    return { status: 'submitted_success', detail: sig, evidenceText };
  }

  // ---- 5. CAPTCHA で止められた ---------------------------------------------
  if (formCount > 0 && captchaPresent) {
    return { status: 'captcha', detail: `form remained with captcha present: ${sig}`, evidenceText };
  }

  // ---- 6. 判定できない：成功に混ぜない -------------------------------------
  return { status: 'uncertain', detail: `判定不能: ${sig}; url=${afterUrl}`, evidenceText };
}
