import { config } from '../config.js';
import type { CompanyRow, FormSchema, RenderedContent } from '../types.js';
import { messageLimit } from '../layers/l3_content.js';

/**
 * 送信内容の最終検証（誤送信ガード）。
 *
 * ここまでの各ゲート（coverage / eligibility / readiness）は「フォームの側」を
 * 見ている — 必須が埋まるか、入力できる形か。だが実際に起きた誤送信は
 * **入れる値そのもの** が壊れているパターンだった:
 *
 *   - 差出人名が古いまま（旧姓・誤字）で送られる
 *   - 電話番号が設定と食い違う（手直しの取り消し漏れ・分割欄の再導出漏れ）
 *   - 日程調整 URL が本文から落ちている（テンプレ差し替え・本文の手直し）
 *   - 未置換の `{{company}}` や `<!--optional:1-->` がそのまま本文に残る
 *   - 手直しした本文を別の会社に使い回して宛名が違う
 *
 * これらは `content_overrides`（② 確認・承認での手直し）を通ると
 * すべてのフォーム側チェックをすり抜ける。値は「入力できる」からだ。
 *
 * そこで **実際に送信する {@link RenderedContent} そのもの** を、送信直前に
 * 設定 (.env) と突き合わせる。判定は DB を変更せず、同じ関数を
 *
 *   1. ダッシュボードの送信可否判定 (readiness) — 事前に「保留」へ落とす
 *   2. `runExecute` の直前ゲート — 何があっても素通りさせない
 *
 * の両方で使う。1 だけだと、判定から送信までの間に手直しが入った場合や
 * readiness を経由しない単発送信を取りこぼす。
 */

export type ContentIssueCode =
  /* --- 文面 --- */
  | 'body_empty'
  | 'body_too_short'
  | 'placeholder_left'
  | 'template_marker_left'
  | 'recipient_missing'
  | 'sender_company_missing'
  | 'body_over_limit'
  /* --- 氏名 --- */
  | 'name_missing'
  | 'name_mismatch'
  | 'name_split_mismatch'
  | 'name_not_in_body'
  /* --- 電話番号 --- */
  | 'phone_missing'
  | 'phone_mismatch'
  | 'phone_split_mismatch'
  | 'phone_malformed'
  | 'phone_not_in_body'
  /* --- 日程調整 URL --- */
  | 'booking_url_missing';

export interface ContentIssue {
  code: ContentIssueCode;
  label: string;
  detail?: string;
}

export interface ContentVerdict {
  ok: boolean;
  issues: ContentIssue[];
}

/** 本文がこれより短いのは、手直しの事故（消しすぎ・空欄）とみなす。 */
const MIN_BODY_CHARS = 60;

/** `{{company}}` のような未置換プレースホルダ。 */
const PLACEHOLDER_RE = /\{\{\s*\w+\s*\}\}/;
/** `<!--optional:1-->` `<!--/if-->` などのテンプレート制御マーカー。 */
const TEMPLATE_MARKER_RE = /<!--\s*\/?\s*(?:optional|if)\b[^>]*-->/i;

/** 空白（半角・全角）を落として比較する。「福井 聖」と「福井聖」を同一視する。 */
const squash = (v: string | undefined): string => (v ?? '').replace(/[\s　]+/g, '');
/** 数字だけ取り出す。ハイフン有無・全角半角の違いを吸収する。 */
const digitsOf = (v: string | undefined): string =>
  (v ?? '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, '');

/** 本文に含まれるか（そのままの表記 → だめなら空白無視で再判定）。 */
function bodyHas(body: string, needle: string): boolean {
  if (!needle) return true;
  return body.includes(needle) || squash(body).includes(squash(needle));
}

/**
 * 送信直前の内容検証。DB は読まない・変更しない — 渡された内容だけを見る。
 *
 * @param company 宛先企業（宛名の照合に使う）
 * @param schema  フォーム定義（本文の入力上限の確認に使う）
 * @param content 実際に送信する内容（`renderContent` の戻り値そのもの）
 */
export function verifyContent(
  company: Pick<CompanyRow, 'name'>,
  schema: FormSchema | undefined,
  content: RenderedContent,
): ContentVerdict {
  const s = config.sender;
  const issues: ContentIssue[] = [];
  const body = content.body ?? '';
  const values = content.values ?? {};

  /* ------------------------------ ① 文面 ------------------------------ */

  if (!body.trim()) {
    issues.push({ code: 'body_empty', label: '本文が空です' });
  } else if (body.trim().length < MIN_BODY_CHARS) {
    issues.push({
      code: 'body_too_short',
      label: `本文が短すぎます（${body.trim().length}文字）`,
      detail: '手直しで本文を消しすぎている可能性があります',
    });
  }

  const ph = body.match(PLACEHOLDER_RE);
  if (ph) {
    issues.push({
      code: 'placeholder_left',
      label: '本文に未置換の差し込み項目が残っています',
      detail: ph[0],
    });
  }
  const marker = body.match(TEMPLATE_MARKER_RE);
  if (marker) {
    issues.push({
      code: 'template_marker_left',
      label: '本文にテンプレートの制御タグが残っています',
      detail: marker[0],
    });
  }

  // 宛名。手直しした本文を別の会社に使い回すと、ここで止まる。
  if (body.trim() && company.name && !bodyHas(body, company.name)) {
    issues.push({
      code: 'recipient_missing',
      label: '本文に宛先の企業名がありません',
      detail: `「${company.name}」が本文に見当たりません（他社の文面の使い回しの可能性）`,
    });
  }

  // 差出人（§9 コンプライアンス: 発信者の明示）。
  if (s.company && body.trim() && !bodyHas(body, s.company)) {
    issues.push({
      code: 'sender_company_missing',
      label: '本文に差出人の会社名がありません',
      detail: s.company,
    });
  }

  // 入力上限。手直し後の本文は自動短縮を経ていないので、ここで初めて超える。
  const limit = messageLimit(schema);
  const message = values.message ?? body;
  if (limit && message.length > limit) {
    issues.push({
      code: 'body_over_limit',
      label: `本文が入力上限を超えています（${message.length}/${limit}文字）`,
      detail: '途中で切れた状態で送信されます',
    });
  }

  /* ------------------------------ ② 氏名 ------------------------------ */

  const expectedName = squash(s.person);
  if (expectedName) {
    if (!values.name) {
      issues.push({ code: 'name_missing', label: '氏名が入力値に入っていません' });
    } else if (squash(values.name) !== expectedName) {
      issues.push({
        code: 'name_mismatch',
        label: '氏名が設定と一致しません',
        detail: `入力値「${values.name}」/ 設定「${s.person}」`,
      });
    }

    // 姓・名が別欄のフォーム。手直しで基準値だけ直して分割欄が古いままだと、
    // 送信先には旧姓名が届く。
    if (values.name_sei || values.name_mei) {
      const joined = squash(`${values.name_sei ?? ''}${values.name_mei ?? ''}`);
      if (joined !== expectedName) {
        issues.push({
          code: 'name_split_mismatch',
          label: '姓名の分割欄が氏名と一致しません',
          detail: `姓「${values.name_sei ?? ''}」名「${values.name_mei ?? ''}」/ 設定「${s.person}」`,
        });
      }
    }

    // 署名に古い氏名が焼き付いた本文を手直しで持ち込んだケース。
    if (body.trim() && !bodyHas(body, s.person)) {
      issues.push({
        code: 'name_not_in_body',
        label: '本文の署名に氏名がありません',
        detail: `「${s.person}」が本文に見当たりません`,
      });
    }
  }

  /* ---------------------------- ③ 電話番号 ---------------------------- */

  const expectedPhone = digitsOf(s.phone);
  if (expectedPhone) {
    const actualPhone = digitsOf(values.phone);
    if (!values.phone) {
      issues.push({ code: 'phone_missing', label: '電話番号が入力値に入っていません' });
    } else if (actualPhone !== expectedPhone) {
      issues.push({
        code: 'phone_mismatch',
        label: '電話番号が設定と一致しません',
        detail: `入力値「${values.phone}」/ 設定「${s.phone}」`,
      });
    } else if (actualPhone.length !== 10 && actualPhone.length !== 11) {
      // 設定自体が壊れている場合。桁が合わない番号はフォーム側で弾かれるか、
      // 通じない番号のまま相手に残る。
      issues.push({
        code: 'phone_malformed',
        label: `電話番号の桁数が不正です（${actualPhone.length}桁）`,
        detail: s.phone,
      });
    }

    // 3分割・2分割の電話欄。
    if (values.phone1 || values.phone2 || values.phone3) {
      const joined = digitsOf(`${values.phone1 ?? ''}${values.phone2 ?? ''}${values.phone3 ?? ''}`);
      if (joined !== expectedPhone) {
        issues.push({
          code: 'phone_split_mismatch',
          label: '分割された電話番号欄が設定と一致しません',
          detail: `${values.phone1 ?? ''}-${values.phone2 ?? ''}-${values.phone3 ?? ''} / 設定「${s.phone}」`,
        });
      }
    }

    if (body.trim() && !digitsOf(body).includes(expectedPhone)) {
      issues.push({
        code: 'phone_not_in_body',
        label: '本文の署名に電話番号がありません',
        detail: s.phone,
      });
    }
  }

  /* -------------------------- ④ 日程調整 URL -------------------------- */

  // 未設定なら本文からも消えているのが正しい（テンプレートの <!--if:bookingUrl-->）
  // ので、設定されているときだけ「載っているか」を要求する。
  if (s.bookingUrl && body.trim() && !body.includes(s.bookingUrl)) {
    issues.push({
      code: 'booking_url_missing',
      label: '日程調整URLが本文にありません',
      detail: s.bookingUrl,
    });
  }

  return { ok: issues.length === 0, issues };
}

/** 監査ログ・保留理由用の 1 行要約。 */
export function summarizeIssues(issues: readonly ContentIssue[], max = 3): string {
  const head = issues.slice(0, max).map((i) => i.label).join(' / ');
  return issues.length > max ? `${head} ほか${issues.length - max}件` : head;
}
