import type { Page } from 'playwright';
import type { DetectedField, FieldMapping, FieldRole, FormSchema } from '../types.js';
import { ROLE_RULES, offTopicFieldIndices } from './l2_dictionary.js';
import { detectSplitFields } from './l2_split.js';
import { detectChoiceFields } from './l2_choice.js';
import { classifyAmbiguousFields } from './l2_llm.js';
import { computeGate } from '../core/gate.js';
import { detectNoSalesPolicy } from '../crosscutting/compliance.js';
import {
  extractFields,
  extractButtons,
  detectCaptcha,
  getVisibleText,
  primaryFormSelector,
} from '../browser/extract.js';
import { BrowserSession, withBrowserSlot } from '../browser/browser.js';
import { logger } from '../utils/logger.js';

const log = logger('L2');

/** A candidate (field, role, confidence) produced by the rule engine. */
interface Candidate {
  fieldIdx: number;
  role: FieldRole;
  confidence: number;
}

/** Build the searchable haystack for a field. */
function haystack(f: DetectedField): string {
  return [f.labelText, f.name, f.id, f.placeholder].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Pure rule-based mapping (spec §4-L2 ① + ②). Returns confident FieldMappings
 * and the fields that stayed ambiguous (for the LLM fallback ③).
 * Honeypots are never mapped (④).
 */
export function ruleMap(
  fields: DetectedField[],
  opts: { skip?: Set<number> } = {},
): {
  mappings: FieldMapping[];
  ambiguousIdx: number[];
} {
  const skip = opts.skip ?? new Set<number>();
  const candidates: Candidate[] = [];

  fields.forEach((f, idx) => {
    if (f.honeypot) return; // ④: never touch honeypots
    if (skip.has(idx)) return; // already claimed by the split-field detector (課題A)
    // hidden は人が入力する欄ではない。フォーム基盤（DNN 等）は
    // hdnFieldType / hdnItemID のような内部用の hidden に、見えている欄と
    // 同じ見出しを付けることがある。役割を取られると、実際に入力すべき
    // 可視欄が未マッピングのまま残る。
    if ((f.type || '').toLowerCase() === 'hidden') return;
    const hay = haystack(f);
    const fType = (f.type || '').toLowerCase();
    for (const rule of ROLE_RULES) {
      const kwHit = rule.keywords.some((k) => hay.includes(k.toLowerCase()));
      const typeHit = rule.types?.includes(fType) ?? false;
      if (!kwHit && !typeHit) continue;
      // A disqualifying keyword wins over a match (office_address is 住所, not 会社名).
      if (rule.exclude?.some((k) => hay.includes(k.toLowerCase()))) continue;
      // Text roles must never bind to a checkbox/radio (a 送信確認 checkbox's
      // label contains 確認 and would otherwise steal the email_confirm role).
      if (rule.role !== 'agree' && (fType === 'checkbox' || fType === 'radio')) continue;
      // postal/address are free-text; never let them claim a <select> (e.g. the
      // 都道府県 dropdown), which the required-choice pass fills by prefecture match.
      if ((rule.role === 'postal' || rule.role === 'address') && f.tag === 'select') continue;
      let conf = 0;
      if (kwHit) conf = rule.weight;
      if (typeHit) conf = Math.max(conf, rule.weight - 0.05) + (kwHit ? 0.06 : 0);
      // Structure signal: message role strongly prefers a <textarea>.
      if (rule.role === 'message' && f.tag === 'textarea') conf = Math.min(0.98, conf + 0.06);
      // A textarea that matched nothing else is very likely the message body.
      candidates.push({ fieldIdx: idx, role: rule.role, confidence: Math.min(0.98, conf) });
    }
    // Fallback structure signal: a lone textarea with no keyword hit -> message.
    if (f.tag === 'textarea' && !candidates.some((c) => c.fieldIdx === idx)) {
      candidates.push({ fieldIdx: idx, role: 'message', confidence: 0.62 });
    }
  });

  // Greedy assignment: highest confidence first, one field per role, one role per field.
  candidates.sort((a, b) => b.confidence - a.confidence);
  const takenField = new Set<number>();
  const takenRole = new Set<FieldRole>();
  const mappings: FieldMapping[] = [];
  for (const c of candidates) {
    if (takenField.has(c.fieldIdx)) continue;
    // allow multiple 'agree' checkboxes; single-instance for everything else
    if (c.role !== 'agree' && takenRole.has(c.role)) continue;
    takenField.add(c.fieldIdx);
    takenRole.add(c.role);
    mappings.push({
      role: c.role,
      selector: fields[c.fieldIdx].selector,
      confidence: Number(c.confidence.toFixed(3)),
      source: 'rule',
    });
  }

  // Ambiguous: visible, fillable fields left unassigned (skip honeypots, agree checkboxes handled).
  const ambiguousIdx: number[] = [];
  fields.forEach((f, idx) => {
    if (f.honeypot) return;
    if (skip.has(idx)) return;
    if (takenField.has(idx)) return;
    // ignore hidden types & submit-like already filtered upstream
    if ((f.type || '') === 'hidden') return;
    ambiguousIdx.push(idx);
  });

  return { mappings, ambiguousIdx };
}

export interface MapResult {
  mappings: FieldMapping[];
  /** Visible fields no rule claimed — the LLM fallback's input (③). */
  ambiguousIdx: number[];
  /** Fields belonging to an off-topic section; never filled. */
  offTopic: Set<number>;
  /** A required choice was auto-picked by fallback (課題C) — caps the gate. */
  ambiguousChoice: boolean;
}

/**
 * The whole field→role decision, as a pure function of the detected fields.
 *
 * parseForm runs it twice: once to learn which fields stayed ambiguous, then
 * again with the LLM's answers folded in. Keeping it browser-free is what lets
 * the tests replay real captured forms without Playwright.
 */
export function mapFields(
  fields: DetectedField[],
  opts: { llm?: { selector: string; role: FieldRole; confidence: number }[] } = {},
): MapResult {
  // Off-topic sections (【迷惑メールの内容】…) are excluded from every mapper so
  // no sales value can ever reach them (l2_dictionary).
  const offTopic = offTopicFieldIndices(fields);

  // Split-field detection first (課題A/B/D): claim phone/name/kana/postal/住所
  // sub-fields and the email-confirm box so the generic mapper won't jam a
  // whole value into the first box.
  const split = detectSplitFields(fields, { skip: offTopic });
  const skipForRules = new Set<number>([...split.consumed, ...offTopic]);
  const { mappings: ruleMappings, ambiguousIdx } = ruleMap(fields, { skip: skipForRules });
  const mappings: FieldMapping[] = [...split.mappings, ...ruleMappings];

  // LLM fallback results (③), if any — never overwrite a rule-assigned role.
  const usedRoles = new Set(mappings.map((m) => m.role));
  for (const m of opts.llm ?? []) {
    if (m.role !== 'agree' && usedRoles.has(m.role)) continue;
    if (offTopic.has(fields.findIndex((f) => f.selector === m.selector))) continue;
    usedRoles.add(m.role);
    mappings.push({ role: m.role, selector: m.selector, confidence: m.confidence, source: 'llm' });
  }

  // Positional email_confirm: forms often place the "re-enter your email"
  // instruction in separate help text (not the field's own label), so keyword
  // matching misses it. If email is mapped and a second email-ish field is
  // still unmapped, treat it as the confirmation field.
  if (!mappings.some((m) => m.role === 'email_confirm')) {
    const emailSel = mappings.find((m) => m.role === 'email')?.selector;
    const taken = new Set(mappings.map((m) => m.selector));
    const confirm = fields.find(
      (f, i) =>
        !f.honeypot &&
        !offTopic.has(i) &&
        f.selector !== emailSel &&
        !taken.has(f.selector) &&
        ((f.type || '') === 'email' || /mail|メール/i.test(`${f.name || ''} ${f.id || ''} ${f.labelText || ''}`)),
    );
    if (emailSel && confirm) {
      mappings.push({ role: 'email_confirm', selector: confirm.selector, confidence: 0.7, source: 'structure' });
    }
  }

  // Required select/radio auto-selection (課題C), on fields nothing else claimed.
  const mappedSelectors = new Set(mappings.map((m) => m.selector));
  const choice = detectChoiceFields(fields, mappedSelectors);
  mappings.push(...choice.mappings);

  return { mappings, ambiguousIdx, offTopic, ambiguousChoice: choice.ambiguous };
}

export interface ParseInput {
  formUrl: string;
  formConfidence: number;
  /** Reuse an existing session/page to avoid a second navigation (optional). */
  page?: Page;
}

/**
 * L2 — full form parse. Loads the page, extracts fields, runs the rule mapper,
 * fills gaps with the LLM fallback, detects flags (confirm screen / CAPTCHA /
 * no-sales policy / honeypot), and computes the confidence gate (§5).
 */
export async function parseForm(input: ParseInput): Promise<FormSchema> {
  // 既存の page を渡された場合は呼び出し側がすでにブラウザ枠を持っている。
  // ここで取り直すと自分の枠の解放を自分で待つデッドロックになる。
  if (input.page) return parseFormInSlot(input);
  return withBrowserSlot(() => parseFormInSlot(input));
}

async function parseFormInSlot(input: ParseInput): Promise<FormSchema> {
  const { formUrl, formConfidence } = input;
  let session: BrowserSession | null = null;
  let page = input.page;
  try {
    if (!page) {
      session = new BrowserSession({ seed: 42 });
      page = await session.open();
      await page.goto(formUrl, { waitUntil: 'domcontentloaded' });
    }

    const [fields, buttons, captcha, visibleText, formSelector] = await Promise.all([
      extractFields(page),
      extractButtons(page),
      detectCaptcha(page),
      getVisibleText(page),
      primaryFormSelector(page),
    ]);

    // Pass 1: rules only — tells us which fields stayed ambiguous.
    const first = mapFields(fields);
    if (first.offTopic.size) {
      log.warn(`${formUrl} has ${first.offTopic.size} off-topic field(s) — not a sales inquiry form`);
    }
    // LLM fallback on ambiguous fields only, batched (③), then re-map with its answers.
    const llm = await classifyAmbiguousFields(first.ambiguousIdx.map((i) => fields[i]));
    const { mappings, ambiguousChoice } = llm.length ? mapFields(fields, { llm }) : first;

    const hasHoneypot = fields.some((f) => f.honeypot);
    const hasConfirmScreen = buttons.some((b) => b.kind === 'confirm');
    const noSalesHit = detectNoSalesPolicy(visibleText);

    const partial: FormSchema = {
      formUrl,
      formSelector,
      fields,
      mappings,
      hasConfirmScreen,
      hasCaptcha: captcha,
      hasHoneypot,
      noSalesPolicy: noSalesHit !== null,
      ambiguousChoice,
      mappingConfidence: 0,
      gate: 'low',
    };

    const gate = computeGate({ formConfidence, schema: partial });
    partial.mappingConfidence = gate.mappingConfidence;
    partial.gate = gate.gate;

    log.info(
      `${formUrl} fields=${fields.length} mapped=${mappings.length} confirm=${hasConfirmScreen} captcha=${captcha} gate=${gate.gate} (${gate.reasons.join('|')})`,
    );
    if (noSalesHit) log.warn(`no-sales policy detected: "${noSalesHit}"`);

    return partial;
  } finally {
    if (session) await session.close();
  }
}
