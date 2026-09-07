import { config } from '../config.js';

/**
 * 文面の A/B 割り当て。
 *
 * **なぜ要るか。** これまで全社に同一の文面を送っていたため、返信が無かった
 * ときに「文面が悪い」のか「そもそも届いていない」のか「相手が違う」のかを
 * 切り分ける手段が無かった。比較対象が無い限り、文面をどう変えても
 * 良くなったのか悪くなったのかは分からない。
 *
 * 割り当ては企業 ID から決まる（乱数を使わない）。同じ企業は何度実行しても
 * 同じ文面になるので、
 *   - プラン画面で見た文面と実際に送る文面が食い違わない
 *   - 途中で処理が止まって再開しても、割り当てが入れ替わらない
 * という二つの性質が保たれる。承認フローがある以上、ここが揺れてはいけない。
 */

export interface Variant {
  /** 記録に残る名前。funnel の集計軸になる。 */
  name: string;
  /** config/templates/<template>.md */
  template: string;
  /** 何を検証しているのか。後から結果を読む人のために残す。 */
  hypothesis: string;
}

/**
 * 現在走らせている実験。
 *
 * 最初の実験は「長さと依頼の数」にする。既定の文面は約 1,050 字あり、
 * 依頼が「本フォームへの返信」「資料送付」「日程調整リンク」の三つに
 * 分かれている。問い合わせ窓口に届く長文の営業文は読まれずに消えやすく、
 * 依頼が複数あると受け手はどれにも動かない、という仮説を確かめる。
 * 検証したい差を一つに絞るため、腕は 2 本だけにする。
 */
export const VARIANTS: Variant[] = [
  {
    name: 'default',
    template: 'mochica_default',
    hypothesis: '対照群。約1,050字・依頼3つ（返信/資料送付/日程調整）。',
  },
  {
    name: 'short',
    template: 'mochica_short',
    hypothesis: '約半分の長さ・依頼は日程調整リンクの一つだけ。',
  },
];

/** 実験を止めたいときは EXPERIMENT_ENABLED=false で対照群だけになる。 */
function enabled(): boolean {
  return process.env.EXPERIMENT_ENABLED !== 'false';
}

/**
 * 企業 ID を腕数で割り振る。ID をそのまま剰余で割ると、取り込み順
 * （＝業種や名簿の並び）が腕に相関しかねないので、一度混ぜてから割る。
 */
function hash(id: number): number {
  let h = id >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function assignVariant(companyId: number): Variant {
  if (!enabled()) return VARIANTS[0];
  return VARIANTS[hash(companyId) % VARIANTS.length];
}

/** 記録された名前から復元する。過去の割り当てを再現するために使う。 */
export function variantByName(name: string | null | undefined): Variant {
  return VARIANTS.find((v) => v.name === name) ?? VARIANTS[0];
}

/** 日程調整リンクが未設定だと short 群の唯一の依頼が消えるので、先に気づけるようにする。 */
export function experimentWarnings(): string[] {
  const out: string[] = [];
  if (!config.sender.bookingUrl) {
    out.push('SENDER_BOOKING_URL が未設定です。short 群は唯一の依頼（日程調整リンク）を失い、比較になりません。');
  }
  return out;
}
