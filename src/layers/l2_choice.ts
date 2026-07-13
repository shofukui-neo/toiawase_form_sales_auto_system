import type { DetectedField, FieldMapping } from '../types.js';

/**
 * L2 required-choice auto-selection (spec §4-L2 課題C).
 *
 * Real B2B inquiry forms often have a required <select>（お問い合わせ種別 等）or a
 * required radio group（法人/個人 等）that carries no sender-identity value — the
 * rule/split mappers leave them untouched and the form then fails its required
 * validation. We pick a neutral, brand-safe option here.
 *
 * Safety posture (ブランドを燃やさない):
 *   - <select>: prefer a keyword-matched neutral option; else the first
 *     non-placeholder option. Fallback picks flag the form as `ambiguous`.
 *   - radio group: ONLY auto-select when a preferred keyword matches. If nothing
 *     matches we do NOT guess a radio (could be 介護状況/性別 on a consumer form);
 *     we flag it ambiguous and leave it for the human.
 *   Any ambiguity caps the gate below 'high' (see gate.ts).
 */

export interface ChoiceResult {
  mappings: FieldMapping[];
  /** A required choice was filled by fallback, or a required radio was skipped. */
  ambiguous: boolean;
}

/** Placeholder / non-answer option text we must never submit. */
const PLACEHOLDER =
  /選択して|お選び|指定なし|未選択|該当なし|please\s*select|^-+$|^\s*$|^select$|▼|choose|selectbox/i;

/**
 * Preferred option keywords, most-to-least specific. "法人/企業" is strongly
 * correct for us (we are a company); "その他" is the universal safe neutral.
 */
const PREFERRED = [
  '法人',
  '企業',
  'その他',
  'サービス',
  '製品',
  '導入',
  'お問い合わせ',
  'ご相談',
  'ご質問',
];

function norm(s: string | null | undefined): string {
  return (s || '').trim();
}

/** Choose an option from a list of labels. */
export function pickOption(options: string[]): { value: string; confident: boolean } | null {
  const real = options.map(norm).filter((o) => o && !PLACEHOLDER.test(o));
  if (real.length === 0) return null;
  for (const kw of PREFERRED) {
    const hit = real.find((o) => o.includes(kw));
    if (hit) return { value: hit, confident: true };
  }
  return { value: real[0], confident: false };
}

function isFillable(f: DetectedField): boolean {
  return !f.honeypot && (f.type || '') !== 'hidden';
}

/**
 * Detect required select/radio fields not already mapped and pick a safe value.
 * @param fields all detected fields
 * @param mappedSelectors selectors already claimed by rule/split mappers
 */
export function detectChoiceFields(
  fields: DetectedField[],
  mappedSelectors: Set<string>,
): ChoiceResult {
  const mappings: FieldMapping[] = [];
  let ambiguous = false;

  // ---------- required <select> ----------
  for (const f of fields) {
    if (f.tag !== 'select' || !isFillable(f)) continue;
    if (mappedSelectors.has(f.selector)) continue;
    if (!f.required) continue; // only auto-fill required selects (conservative)
    const pick = pickOption(f.options ?? []);
    if (!pick) continue;
    mappings.push({
      role: 'choice',
      selector: f.selector,
      confidence: pick.confident ? 0.8 : 0.6,
      source: 'structure',
      value: pick.value,
    });
    if (!pick.confident) ambiguous = true;
  }

  // ---------- required radio groups ----------
  const groups = new Map<string, DetectedField[]>();
  for (const f of fields) {
    if (f.tag !== 'input' || (f.type || '').toLowerCase() !== 'radio' || !isFillable(f)) continue;
    if (!f.name) continue;
    const arr = groups.get(f.name) ?? [];
    arr.push(f);
    groups.set(f.name, arr);
  }
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    if (members.some((m) => mappedSelectors.has(m.selector))) continue;
    const required = members.some((m) => m.required);
    if (!required) continue; // never touch optional radio groups (brand safety)
    // Prefer a keyword-matched option; do NOT guess if nothing matches.
    let chosen: DetectedField | null = null;
    outer: for (const kw of PREFERRED) {
      for (const m of members) {
        if (norm(m.labelText).includes(kw)) {
          chosen = m;
          break outer;
        }
      }
    }
    if (chosen) {
      mappings.push({
        role: 'choice',
        selector: chosen.selector,
        confidence: 0.75,
        source: 'structure',
        value: norm(chosen.labelText),
      });
    } else {
      ambiguous = true; // required radio we won't blindly guess -> human review
    }
  }

  return { mappings, ambiguous };
}
