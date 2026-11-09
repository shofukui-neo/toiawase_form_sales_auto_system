import { config } from '../config.js';
import { currentWeights } from './learning.js';
import { activeVariants, controlVariant, variantByName, type Variant } from './variants.js';

export { variantByName, type Variant };

/**
 * 文面の割り当て（PDCA の Do）。
 *
 * **なぜ要るか。** 全社に同一の文面を送っていると、返信が無かったときに
 * 「文面が悪い」のか「届いていない」のか「相手が違う」のかを切り分けられない。
 * 比較対象が無い限り、文面をどう変えても良くなったのかは分からない。
 *
 * **配分は学習で動く。** 各文面の比率は learning.ts が結果から毎回引き直す
 * （勝っていそうな文面ほど多く、ただし最低限は残す）。
 *
 * **それでも割り当ては決定的。** 企業 ID から [0,1) の位置を決め、その時点の
 * 配分の累積で文面を選ぶ（乱数を使わない）。さらにプラン時に選んだ文面は
 * submissions.variant に書き残し、送信時はそれを読み直す。だから配分が
 * 後から変わっても、承認画面で見た文面と実際に送る文面は食い違わない。
 */

/** 実験を止めたいときは EXPERIMENT_ENABLED=false で対照群だけになる。 */
function enabled(): boolean {
  return process.env.EXPERIMENT_ENABLED !== 'false';
}

/**
 * 企業 ID を [0,1) に散らす。ID をそのまま使うと、取り込み順（＝業種や名簿の
 * 並び）が文面に相関しかねないので、一度混ぜる。
 */
function hash(id: number): number {
  let h = id >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 配分比率から文面を選ぶ。比率に無い文面（追加直後）は均等扱いにする。 */
export function pickByWeights(companyId: number, active: Variant[], weights: Record<string, number>): Variant {
  if (active.length === 1) return active[0];
  const raw = active.map((v) => (weights[v.name] && weights[v.name] > 0 ? weights[v.name] : 1 / active.length));
  const sum = raw.reduce((s, x) => s + x, 0);
  const u = hash(companyId) / 4294967296;
  let acc = 0;
  for (let i = 0; i < active.length; i++) {
    acc += raw[i] / sum;
    if (u < acc) return active[i];
  }
  return active[active.length - 1];
}

export function assignVariant(companyId: number): Variant {
  if (!enabled()) return controlVariant();
  const active = activeVariants();
  if (active.length === 0) return controlVariant();
  return pickByWeights(companyId, active, currentWeights());
}

/** 日程調整リンクが未設定だと short 群の唯一の依頼が消えるので、先に気づけるようにする。 */
export function experimentWarnings(): string[] {
  const out: string[] = [];
  if (!config.sender.bookingUrl) {
    out.push('SENDER_BOOKING_URL が未設定です。日程調整だけを依頼する文面は唯一の依頼を失い、比較になりません。');
  }
  if (activeVariants().length < 2) {
    out.push('配信中の文面が 1 本だけです。比較相手が無いので学習が進みません（`toiawase learn --generate`）。');
  }
  return out;
}
