import { prep, tx } from '../db/db.js';
import { logger } from '../utils/logger.js';
import { activeVariants, allVariants, registryKey, setVariantStatus, type Variant } from './variants.js';

const log = logger('learning');

/**
 * 文面の学習ループ（PDCA の Check → Act）。
 *
 * **なぜ固定の A/B ではないのか。** 50:50 で割り続けると、明らかに負けている
 * 文面にも最後まで半分の企業を使ってしまう。フォーム営業は 1 社に一度しか
 * 送れない（同じ企業に文面を変えて送り直せない）ので、負け文面に配った企業は
 * そのまま失われる。そこで送るたびに結果を読み直し、勝っていそうな文面ほど
 * 多く配る（Thompson sampling）。ただし最低限の割合は残し、学習が早とちりで
 * 固まらないようにする。
 *
 * **何を「成果」とみなすか。** 目的はアポなので、アポ = 1、アポに至らない
 * 前向きな返信 = REPLY_WEIGHT。お断り・配信停止は成果 0 で、別途「苦情率」と
 * してガードレールに使う（返信率だけ上げる煽り文面を勝たせないため）。
 *
 * **返信待ちの扱い。** 送ったばかりの企業はまだ返信していないだけかもしれない。
 * これを「反応なし」と数えると、新しい文面ほど不当に低く見える。反応が無い
 * 送信は経過日数 / 返信待ち期間 の重みでだけ分母に入れる（反応があった送信は 1）。
 */

export const LEARNING = {
  /** 返信を待つ期間（日）。これを過ぎて反応が無ければ「反応なし」と確定する。 */
  windowDays: num('LEARNING_RESPONSE_WINDOW_DAYS', 14),
  /** アポに至らない前向きな返信の価値（アポ = 1）。 */
  replyWeight: num('LEARNING_REPLY_WEIGHT', 0.3),
  /** 各文面に残す最低配分。探索を止めないため。 */
  minShare: num('LEARNING_MIN_SHARE', 0.1),
  /** これ未満の文面は、勝敗に関係なく均等配分で様子を見る。 */
  burnIn: num('LEARNING_BURN_IN', 60),
  /** 引退・確定の判断に必要な分母（重み付き送信数）。 */
  decisionMin: num('LEARNING_DECISION_MIN', 200),
  /** 最良である確率がこれを下回ったら引退。 */
  retireBelow: num('LEARNING_RETIRE_BELOW', 0.02),
  /** 最良である確率がこれを超えたら勝ち確定（次の挑戦者の親になる）。 */
  championAbove: num('LEARNING_CHAMPION_ABOVE', 0.95),
  /** 成果率の事前分布 Beta(a, b)。平均 ≒ 1%（フォーム営業の現実的な水準）。 */
  prior: { a: 0.5, b: 50 },
  /** 苦情率（お断り + 配信停止）の事前分布。 */
  complaintPrior: { a: 0.5, b: 20 },
  /** 苦情率が他の文面の何倍を超えたら止めるか。 */
  complaintRatio: num('LEARNING_COMPLAINT_RATIO', 1.5),
  complaintMin: num('LEARNING_COMPLAINT_MIN', 80),
  draws: 20000,
};

function num(key: string, dflt: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && process.env[key] !== '' && process.env[key] !== undefined ? v : dflt;
}

export function learningEnabled(): boolean {
  return process.env.LEARNING_ENABLED !== 'false';
}

/* -------------------------------- 集計 (Check) ------------------------------- */

export interface ArmStats {
  name: string;
  /** 到達した送信数（bounce を除く）。 */
  delivered: number;
  /** 返信待ちを割り引いた分母。 */
  exposure: number;
  appointments: number;
  /** アポ以外の前向きな返信。 */
  positiveReplies: number;
  refusals: number;
  optouts: number;
  bounces: number;
  /** 成果の合計（アポ 1 + 前向き返信 replyWeight）。 */
  reward: number;
  /** 苦情（お断り or 配信停止）のあった送信数。 */
  complaints: number;
}

interface SubRow {
  id: number;
  company_id: number;
  variant: string;
  submitted_at: string;
}
interface OutRow {
  company_id: number;
  submission_id: number | null;
  kind: string;
  occurred_at: string;
}

const julian = (s: string) => Date.parse(`${s.replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'}`);

/**
 * 文面パターンごとの成果。outcome は submission_id があればその送信に、
 * 無ければ「反応の時点で最後に送っていた送信」に帰属させる。
 */
export function collectStats(now: Date = new Date()): Map<string, ArmStats> {
  const subs = prep(
    `SELECT id, company_id, variant, submitted_at FROM submissions
      WHERE status = 'submitted_success' AND variant IS NOT NULL
        AND variant NOT LIKE 'manual:%' AND submitted_at IS NOT NULL
      ORDER BY submitted_at ASC, id ASC`,
  ).all() as SubRow[];
  const outs = prep(
    'SELECT company_id, submission_id, kind, occurred_at FROM outcomes ORDER BY id ASC',
  ).all() as OutRow[];

  const byCompany = new Map<number, SubRow[]>();
  const byId = new Map<number, SubRow>();
  for (const s of subs) {
    byId.set(s.id, s);
    const list = byCompany.get(s.company_id) ?? [];
    list.push(s);
    byCompany.set(s.company_id, list);
  }

  const flags = new Map<number, Set<string>>();
  for (const o of outs) {
    let target: SubRow | undefined = o.submission_id != null ? byId.get(o.submission_id) : undefined;
    if (!target) {
      const list = byCompany.get(o.company_id);
      if (!list) continue;
      const at = julian(o.occurred_at);
      target = [...list].reverse().find((s) => julian(s.submitted_at) <= at) ?? list[list.length - 1];
    }
    const f = flags.get(target.id) ?? new Set<string>();
    f.add(o.kind);
    flags.set(target.id, f);
  }

  const stats = new Map<string, ArmStats>();
  const nowMs = now.getTime();
  for (const s of subs) {
    const a =
      stats.get(s.variant) ??
      ({
        name: s.variant,
        delivered: 0,
        exposure: 0,
        appointments: 0,
        positiveReplies: 0,
        refusals: 0,
        optouts: 0,
        bounces: 0,
        reward: 0,
        complaints: 0,
      } satisfies ArmStats);
    stats.set(s.variant, a);
    const f = flags.get(s.id) ?? new Set<string>();
    if (f.has('bounce') && !f.has('reply') && !f.has('appointment')) {
      a.bounces++;
      continue; // 届いていないものは文面の評価に入れない
    }
    a.delivered++;
    const complained = f.has('refusal') || f.has('optout');
    if (f.has('refusal')) a.refusals++;
    if (f.has('optout')) a.optouts++;
    if (complained) a.complaints++;

    if (f.has('appointment')) {
      a.appointments++;
      a.reward += 1;
    } else if (f.has('reply') && !complained) {
      a.positiveReplies++;
      a.reward += LEARNING.replyWeight;
    }
    const responded = f.size > 0;
    const ageDays = (nowMs - julian(s.submitted_at)) / 86_400_000;
    a.exposure += responded ? 1 : Math.max(0, Math.min(1, ageDays / LEARNING.windowDays));
  }
  return stats;
}

/* ------------------------------ 推定 (Thompson) ------------------------------ */

/** 決定的な乱数（同じ集計からは同じ配分が出る = 再実行で割り当てが揺れない）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Marsaglia–Tsang。shape < 1 は shape+1 から引いて補正する。 */
function gamma(shape: number, r: () => number): number {
  if (shape < 1) return gamma(shape + 1, r) * Math.pow(r() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function beta(a: number, b: number, r: () => number): number {
  const x = gamma(a, r);
  const y = gamma(b, r);
  return x / (x + y);
}

function strSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface ArmResult extends ArmStats {
  /** 成果率の事後平均。 */
  rate: number;
  /** 95% 信用区間。 */
  low: number;
  high: number;
  /** この文面が最良である確率。 */
  pBest: number;
  complaintRate: number;
  /** 苦情率が他より明らかに高い確率。 */
  pComplaintHigh: number;
  share: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

/** 配信中の文面について、最良である確率と配分比率を出す。 */
export function estimate(arms: ArmStats[], seed: number): ArmResult[] {
  const r = rng(seed);
  const k = arms.length;
  const { prior, complaintPrior, draws } = LEARNING;
  const wins = new Array(k).fill(0);
  const highComplaint = new Array(k).fill(0);
  const samples: number[][] = arms.map(() => []);
  const sampleEvery = Math.max(1, Math.floor(draws / 2000));

  const totalComplaints = arms.reduce((s, a) => s + a.complaints, 0);
  const totalExposure = arms.reduce((s, a) => s + a.delivered, 0);

  for (let i = 0; i < draws; i++) {
    let best = -1;
    let bestV = -1;
    for (let j = 0; j < k; j++) {
      const a = arms[j];
      const v = beta(prior.a + a.reward, prior.b + Math.max(0, a.exposure - a.reward), r);
      if (v > bestV) {
        bestV = v;
        best = j;
      }
      if (i % sampleEvery === 0) samples[j].push(v);
      if (k > 1) {
        // 自分以外をまとめた苦情率と比べる。
        const otherC = totalComplaints - a.complaints;
        const otherN = totalExposure - a.delivered;
        const mine = beta(complaintPrior.a + a.complaints, complaintPrior.b + a.delivered - a.complaints, r);
        const others = beta(complaintPrior.a + otherC, complaintPrior.b + otherN - otherC, r);
        if (mine > others * LEARNING.complaintRatio) highComplaint[j]++;
      }
    }
    wins[best]++;
  }

  const results: ArmResult[] = arms.map((a, j) => {
    const s = samples[j].sort((x, y) => x - y);
    return {
      ...a,
      rate: (prior.a + a.reward) / (prior.a + prior.b + a.exposure),
      low: quantile(s, 0.025),
      high: quantile(s, 0.975),
      pBest: wins[j] / draws,
      complaintRate: a.delivered ? a.complaints / a.delivered : 0,
      pComplaintHigh: k > 1 ? highComplaint[j] / draws : 0,
      share: 0,
    };
  });

  // 配分 = 最低配分 + 残りを「最良である確率」で按分。様子見中の文面は均等以上。
  // 様子見中の文面はちょうど 1/k を確保し、残りを他の文面で按分する。
  const floor = Math.min(LEARNING.minShare, 0.5 / Math.max(1, k));
  const warming = results.map((a) => a.exposure < LEARNING.burnIn);
  const reserved = warming.filter(Boolean).length / k;
  const base = results.map((a, j) => (warming[j] ? 0 : floor + (1 - k * floor) * a.pBest));
  const baseSum = base.reduce((s, x) => s + x, 0);
  results.forEach((a, j) => {
    a.share = warming[j] ? 1 / k : baseSum > 0 ? (base[j] / baseSum) * (1 - reserved) : (1 - reserved) / k;
  });
  return results;
}

/* ------------------------------- 判断 (Act) -------------------------------- */

export interface LearningAction {
  kind: 'retire' | 'pause' | 'champion' | 'suggest';
  variant?: string;
  reason: string;
}

export interface LearningRound {
  id?: number;
  fingerprint: string;
  weights: Record<string, number>;
  arms: ArmResult[];
  actions: LearningAction[];
  createdAt?: string;
}

/**
 * 結果に応じて文面の状態を変える。自動で行うのは「止める」方向だけで、
 * 新しい文面を配信に入れるのは必ず人（`variant activate`）。
 */
function decide(arms: ArmResult[]): LearningAction[] {
  const actions: LearningAction[] = [];
  let remaining = arms.length;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  for (const a of [...arms].sort((x, y) => x.pBest - y.pBest)) {
    if (remaining <= 1) break;
    if (a.delivered >= LEARNING.complaintMin && a.pComplaintHigh > 0.95) {
      actions.push({
        kind: 'pause',
        variant: a.name,
        reason: `お断り・配信停止が他の文面より明らかに多い（${pct(a.complaintRate)}、確率 ${pct(a.pComplaintHigh)}）`,
      });
      remaining--;
      continue;
    }
    if (a.exposure >= LEARNING.decisionMin && a.pBest < LEARNING.retireBelow) {
      actions.push({
        kind: 'retire',
        variant: a.name,
        reason: `最良である確率 ${pct(a.pBest)}（送信 ${a.delivered}・アポ ${a.appointments}・返信 ${a.positiveReplies}）`,
      });
      remaining--;
    }
  }

  const champ = arms.find((a) => a.pBest >= LEARNING.championAbove && a.exposure >= LEARNING.decisionMin);
  if (champ) {
    actions.push({
      kind: 'champion',
      variant: champ.name,
      reason: `最良である確率 ${pct(champ.pBest)} — これを親に次の挑戦者を作る段階`,
    });
  }
  if (remaining <= 1 || champ) {
    actions.push({
      kind: 'suggest',
      reason:
        (champ ? '勝ちが確定したので、これ以上同じ比較を続けても学べることは少ない。' : '比較相手が足りない。') +
        '`toiawase learn --generate` で次の挑戦者文面を作り、確認して `variant activate` する',
    });
  }
  return actions;
}

/* ------------------------------ 実行と保存 ------------------------------ */

/** 学習結果が今のデータに対して有効かを表す指紋。どれかが変われば学習し直す。 */
export function fingerprint(now: Date = new Date()): string {
  const maxOutcome = Number((prep('SELECT COALESCE(MAX(id), 0) n FROM outcomes').get() as { n: number }).n);
  const delivered = Number(
    (prep(`SELECT COUNT(*) n FROM submissions WHERE status = 'submitted_success'`).get() as { n: number }).n,
  );
  // 返信待ちの重みは日ごとに変わるので日付も含める。
  return `${maxOutcome}|${delivered}|${now.toISOString().slice(0, 10)}|${registryKey()}`;
}

export function latestRound(): LearningRound | null {
  const row = prep('SELECT * FROM learning_rounds ORDER BY id DESC LIMIT 1').get() as
    | { id: number; fingerprint: string; weights_json: string; arms_json: string; actions_json: string; created_at: string }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    weights: JSON.parse(row.weights_json),
    arms: JSON.parse(row.arms_json),
    actions: JSON.parse(row.actions_json),
    createdAt: row.created_at,
  };
}

function emptyArm(name: string): ArmStats {
  return {
    name,
    delivered: 0,
    exposure: 0,
    appointments: 0,
    positiveReplies: 0,
    refusals: 0,
    optouts: 0,
    bounces: 0,
    reward: 0,
    complaints: 0,
  };
}

/**
 * 一回分の学習。集計 → 推定 → 判断 → （apply なら）状態変更と保存。
 * 状態を変えた場合は配信中の文面が変わるので、配分を引き直してから保存する。
 */
export function learn(opts: { apply?: boolean; now?: Date } = {}): LearningRound {
  const apply = opts.apply !== false;
  const now = opts.now ?? new Date();
  const stats = collectStats(now);

  const run = (active: Variant[]) => {
    const arms = active.map((v) => stats.get(v.name) ?? emptyArm(v.name));
    return estimate(arms, strSeed(`${fingerprint(now)}`));
  };

  let active = activeVariants();
  let arms = run(active);
  const actions = learningEnabled() ? decide(arms) : [];

  if (apply && learningEnabled()) {
    const changes = actions.filter((a) => a.kind === 'retire' || a.kind === 'pause');
    if (changes.length) {
      tx(() => {
        for (const c of changes) {
          setVariantStatus(c.variant!, c.kind === 'retire' ? 'retired' : 'paused', c.reason, 'learning');
          log.info(`文面 ${c.variant} を${c.kind === 'retire' ? '引退' : '停止'}: ${c.reason}`);
        }
      });
      active = activeVariants();
      arms = run(active);
    }
  }

  // 引退・停止した文面の実績も記録には残す（後から「何が負けたか」を読むため）。
  const inactive = allVariants()
    .filter((v) => v.status !== 'active' && stats.has(v.name))
    .map((v): ArmResult => {
      const s = stats.get(v.name)!;
      return {
        ...s,
        rate: (LEARNING.prior.a + s.reward) / (LEARNING.prior.a + LEARNING.prior.b + s.exposure),
        low: 0,
        high: 0,
        pBest: 0,
        complaintRate: s.delivered ? s.complaints / s.delivered : 0,
        pComplaintHigh: 0,
        share: 0,
      };
    });

  const weights: Record<string, number> = {};
  for (const a of arms) weights[a.name] = learningEnabled() ? a.share : 1 / arms.length;

  const round: LearningRound = { fingerprint: fingerprint(now), weights, arms: [...arms, ...inactive], actions };
  if (apply) {
    const info = prep(
      `INSERT INTO learning_rounds (fingerprint, weights_json, arms_json, actions_json) VALUES (?, ?, ?, ?)`,
    ).run(round.fingerprint, JSON.stringify(weights), JSON.stringify(round.arms), JSON.stringify(actions));
    round.id = Number(info.lastInsertRowid);
    round.createdAt = (prep('SELECT created_at FROM learning_rounds WHERE id = ?').get(round.id) as {
      created_at: string;
    }).created_at;
    _cache = null;
  }
  return round;
}

/* ------------------------- 割り当てから使う現在の配分 ------------------------- */

let _cache: { at: number; round: LearningRound } | null = null;
const CACHE_MS = 60_000;

/**
 * 現在の配分比率。送るたびに学習が効くよう、データが前回の学習から
 * 変わっていれば（新しい送信・反応・日付・台帳の変更）その場で学習し直す。
 * 一斉送信中に毎社 SQL を叩かないよう、1 分だけ手元に持つ。
 */
export function currentWeights(): Record<string, number> {
  const nowMs = Date.now();
  if (_cache && nowMs - _cache.at < CACHE_MS) return _cache.round.weights;
  const fp = fingerprint();
  let round = latestRound();
  if (!round || round.fingerprint !== fp) round = learn({ apply: true });
  _cache = { at: nowMs, round };
  return round.weights;
}

/** テスト・台帳変更後に配分の手元キャッシュを捨てる。 */
export function resetLearningCache(): void {
  _cache = null;
}

/* ---------------------------------- 表示 ---------------------------------- */

export function formatRound(round: LearningRound): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const out: string[] = [];
  out.push(`=== 文面の学習 ${round.createdAt ? `(${round.createdAt})` : '(未保存)'} ===`);
  out.push(
    `成果 = アポ 1 + 前向きな返信 ${LEARNING.replyWeight} / 返信待ち ${LEARNING.windowDays} 日（未反応の送信はその割合でだけ分母に入る）`,
  );
  out.push('');
  out.push('文面          状態   送信  アポ 返信 断/停  成果率(95%区間)          最良の確率  次の配分');
  const all = allVariants();
  for (const a of round.arms) {
    const v = all.find((x) => x.name === a.name);
    const status = v?.status ?? '?';
    out.push(
      `${a.name.padEnd(13)} ${status.padEnd(6)} ${String(a.delivered).padStart(4)}  ${String(a.appointments).padStart(4)} ` +
        `${String(a.positiveReplies).padStart(4)} ${String(a.refusals + a.optouts).padStart(5)}  ` +
        `${pct(a.rate).padStart(6)} (${pct(a.low)}–${pct(a.high)})`.padEnd(27) +
        `${pct(a.pBest).padStart(9)}  ${a.share ? pct(a.share).padStart(7) : '      —'}`,
    );
  }
  const totalDelivered = round.arms.reduce((s, a) => s + a.delivered, 0);
  const totalOutcomes = round.arms.reduce((s, a) => s + a.appointments + a.positiveReplies + a.refusals + a.optouts, 0);
  if (totalDelivered > 0 && totalOutcomes === 0) {
    out.push('', '⚠ 反応が 1 件も記録されていない。学習は配分を均等のまま動かせない。');
    out.push('  `toiawase import-replies <dir> --apply` か `toiawase outcome` で返信・アポを記録すること。');
  }
  if (round.actions.length) {
    out.push('', '--- 判断 ---');
    const label = { retire: '引退', pause: '停止', champion: '勝ち確定', suggest: '次の一手' } as const;
    for (const a of round.actions) out.push(`  [${label[a.kind]}] ${a.variant ? `${a.variant}: ` : ''}${a.reason}`);
  }
  const drafts = all.filter((v) => v.status === 'draft');
  if (drafts.length) {
    out.push('', '--- 承認待ちの挑戦者文面 ---');
    for (const d of drafts) out.push(`  ${d.name} (${d.template}) — ${d.hypothesis}`);
    out.push('  確認後 `toiawase variant activate <name>` で配信に入る。');
  }
  return out.join('\n');
}
