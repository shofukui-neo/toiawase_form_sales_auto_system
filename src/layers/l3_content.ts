import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config, splitAddress } from '../config.js';
import type { CompanyRow, ContentOverride, FormSchema, RenderedContent, FieldRole } from '../types.js';
import { contentOverrides } from '../db/repositories.js';
import { personalize } from './l3_personalize.js';
import { logger } from '../utils/logger.js';

const log = logger('L3');

/**
 * L3 — content generation (spec §4-L3): template + variable substitution, plus
 * the per-role values L4 types into the form.
 *
 * Deterministic on purpose: the Plan and Execute phases must render identical
 * text (spec §4-L4), so personalisation is rule-based (l3_personalize), never
 * sampled. Compliance requires the sender identity be present and truthful (§9)
 * — which is also why **nothing here is ever fabricated**. A value we do not
 * genuinely have (no phone configured, no postal code) is left unset so the
 * field shows up as an un-fillable required field and the form gates down to a
 * human, instead of a made-up number reaching a real recipient.
 */

interface ParsedTemplate {
  subject: string;
  body: string;
}

const _templates = new Map<string, ParsedTemplate>();

/**
 * Load a markdown template with a `--- subject: ... ---` front-matter line.
 *
 * Memoised: renderContent now runs on every send-readiness poll (up to 200
 * companies per refresh) on top of per-plan/per-execute, and re-reading the
 * same file that many times is pure syscall overhead. Call
 * {@link clearTemplateCache} after editing a template in a long-lived process.
 */
function loadTemplate(name: string): ParsedTemplate {
  const hit = _templates.get(name);
  if (hit) return hit;
  const parsed = parseTemplate(name);
  _templates.set(name, parsed);
  return parsed;
}

/** Drop the memoised templates (after editing config/templates/*.md). */
export function clearTemplateCache(): void {
  _templates.clear();
}

function parseTemplate(name: string): ParsedTemplate {
  const raw = readFileSync(resolve(ROOT, 'config/templates', `${name}.md`), 'utf8');
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fm) return { subject: '', body: raw.trim() };
  const subjectLine = fm[1].match(/subject:\s*(.*)/);
  return { subject: subjectLine ? subjectLine[1].trim() : '', body: fm[2].trim() };
}

function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * `<!--if:var-->…<!--/if-->` — kept only when `vars[var]` is non-empty.
 *
 * Lets the copy around an optional value (the 日程調整 URL) live in the template
 * with the rest of the wording, instead of being assembled in code, while still
 * disappearing cleanly when the value is unset — no orphaned "下記より" pointing
 * at nothing.
 */
function applyConditionals(body: string, vars: Record<string, string>): string {
  return body.replace(
    /(\r?\n*)<!--if:(\w+)-->\r?\n([\s\S]*?)\r?\n?<!--\/if-->/g,
    (_m, nl: string, key: string, inner: string) => (vars[key] ? `${nl}${inner}` : ''),
  );
}

/**
 * 名前付きテンプレートを変数で描画する（条件ブロック → 置換 → 余白整理）。
 *
 * フォーム用とメール用で置換エンジンを二重に持つと、`{{...}}` の書式や
 * `<!--if:-->` の挙動が片方だけ変わって本文が壊れる。入口をここに一本化する。
 * 本文の長さ調整 (fitOptional) はフォーム欄の maxlength 固有の話なので含めない。
 */
export function renderTemplate(
  templateName: string,
  vars: Record<string, string>,
): { subject: string; body: string } {
  const tpl = loadTemplate(templateName);
  return {
    subject: substitute(tpl.subject, vars),
    // 条件ブロックを先に処理する。落とすブロックの中の `{{...}}` を
    // 置換してしまうと、消したはずの値が残骸として本文に出る。
    body: tidy(substitute(applyConditionals(tpl.body, vars), vars)),
  };
}

/**
 * `<!--optional:N-->…<!--/optional-->` — copy we drop, lowest N first, to fit a
 * maxlength. Everything outside these blocks is load-bearing: the greeting, the
 * reason we are writing, the CTA, the signature (§9) and the opt-out notice.
 */
const OPTIONAL_BLOCK = /(\r?\n*)<!--optional:(\d)-->\r?\n([\s\S]*?)\r?\n?<!--\/optional-->/g;
/** Highest tier defined in the templates; shrinking walks 1..MAX. */
const MAX_OPTIONAL_TIER = 2;

/** Drop every optional block whose tier is <= `dropUpTo` (0 keeps all of them). */
function fitOptional(body: string, dropUpTo: number): string {
  return body.replace(OPTIONAL_BLOCK, (_m, nl: string, tier: string, inner: string) =>
    Number(tier) <= dropUpTo ? '' : `${nl}${inner}`,
  );
}

/**
 * Collapse the blank-line residue left where a block marker or a dropped block
 * used to be. Without this, every message carries two or three empty lines in
 * the middle of the pitch and reads like a broken mail-merge.
 */
function tidy(body: string): string {
  return body.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The maxlength of the textarea the message will land in, or null.
 *
 * Several forms cap 本文 at 1000 (or even 200) characters and the browser then
 * silently truncates — cutting the signature off mid-block, which would leave a
 * message with no sender contact details at all (§9). So the shrink decision is
 * made HERE, deterministically, rather than being discovered at type-time: the
 * approval preview shows exactly the text that will be submitted.
 */
/** 本文欄の maxlength（無ければ null）。送信直前の内容検証でも使う。 */
export function messageLimit(schema: FormSchema | undefined): number | null {
  const sel = schema?.mappings?.find((m) => m.role === 'message')?.selector;
  if (!sel) return null;
  return schema?.fields?.find((f) => f.selector === sel)?.maxLength ?? null;
}

const SIG_RULE = '■━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━■';

/**
 * Build the signature block from the configured sender identity, so the .env is
 * the single source of truth and the block can never drift from the values we
 * actually type into the form. Lines whose value is unset are dropped rather
 * than left as a dangling label.
 */
export function buildSignature(): string {
  const s = config.sender;
  const lines: string[] = [SIG_RULE];

  if (s.company) lines.push(s.company);
  if (s.department) lines.push(s.department.replace(/\s+/g, '　'));
  // 署名の氏名は姓名を詰めて表記する（フォーム入力欄は「福井 聖」のまま）。
  const person = s.person.replace(/[\s　]+/g, '');
  if (person) lines.push(s.personRomaji ? `${person}／${s.personRomaji}` : person);

  // 連絡先行には、フォームの電話番号欄に入れるのと同じ番号を載せる。番号が
  // 携帯（070/080/090）かどうかでラベルを選ぶので、番号を差し替えても署名が嘘にならない。
  const contact: string[] = [];
  if (s.phone) contact.push(`${/^0[789]0[-\s]?\d/.test(s.phone) ? '携帯電話' : '電話'}：${s.phone}`);
  if (s.email) contact.push(`E-mail：${s.email}`);
  if (contact.length) lines.push('', ...contact);

  const office: string[] = [];
  if (s.postal || s.address) office.push(`〒${s.postal} ${s.address}`.trim());
  if (s.officePhone) office.push(`電話：${s.officePhone}`);
  if (s.fax) office.push(`FAX ：${s.fax}`);
  if (s.url) office.push(`URL：${s.url}`);
  if (office.length) lines.push('', `◆${s.office || '本社'}`, ...office);

  lines.push(SIG_RULE);
  return lines.join('\n');
}

/** Which of the split 住所 boxes this form actually has. */
export interface AddressSlots {
  pref: boolean;
  city: boolean;
  street: boolean;
}

function addressSlots(schema: FormSchema | undefined): AddressSlots {
  const roles = new Set((schema?.mappings ?? []).map((m) => m.role));
  return {
    pref: roles.has('address_pref'),
    city: roles.has('address_city'),
    street: roles.has('address_street'),
  };
}

/**
 * Spread 都道府県 / 市区町村 / 番地・建物名 over whichever address boxes the form
 * has, so no component is ever dropped or duplicated: each box takes everything
 * from just after the previous box's component through its own, and the last box
 * absorbs the tail. 都道府県 is the exception — a prefecture picker only ever
 * receives the prefecture.
 *
 * 都道府県+市区町村+番地  -> 東京都 / 新宿区 / 西新宿1丁目22-2
 * 都道府県+番地           -> 東京都 / 新宿区西新宿1丁目22-2
 * 市区町村+番地           -> 東京都新宿区 / 西新宿1丁目22-2
 */
export function deriveAddressValues(
  address: string,
  slots: AddressSlots,
): Partial<Record<FieldRole, string>> {
  const out: Partial<Record<FieldRole, string>> = {};
  if (!address) return out;
  const { prefecture, city, street } = splitAddress(address);
  const comps = [prefecture, city, street];

  const buckets: { role: FieldRole; pos: number }[] = [];
  if (slots.pref) buckets.push({ role: 'address_pref', pos: 0 });
  if (slots.city) buckets.push({ role: 'address_city', pos: 1 });
  if (slots.street) buckets.push({ role: 'address_street', pos: 2 });

  let from = 0;
  buckets.forEach((b, i) => {
    const isLast = i === buckets.length - 1;
    const to = b.role === 'address_pref' ? b.pos : isLast ? comps.length - 1 : b.pos;
    const value = comps.slice(from, to + 1).join('');
    if (value) out[b.role] = value;
    from = to + 1;
  });
  return out;
}

export interface RenderOptions {
  templateName?: string;
}

export function renderContent(
  company: CompanyRow,
  schema: FormSchema,
  opts: RenderOptions = {},
): RenderedContent {
  const tpl = loadTemplate(opts.templateName ?? 'mochica_default');
  const s = config.sender;
  const p = personalize(company);
  const vars: Record<string, string> = {
    company: company.name,
    senderCompany: s.company,
    senderProduct: s.product,
    senderPerson: s.person,
    senderDepartment: s.department,
    senderEmail: s.email,
    senderPhone: s.phone,
    senderOfficePhone: s.officePhone,
    // 「その企業である理由」— 業種推定に基づく導入文 (l3_personalize)。
    reason: p.reason,
    industry: p.industry,
    bookingUrl: s.bookingUrl,
    signature: buildSignature(),
    // Only render a phone line if a phone is configured (avoids a dangling label).
    senderPhoneLine: s.phone ? `\nTEL：${s.phone}` : '',
  };

  const subject = substitute(tpl.subject, vars);
  // Conditionals first, so a dropped block's placeholders never get substituted.
  const rendered = substitute(applyConditionals(tpl.body, vars), vars);
  // Fit the body to the target textarea by dropping optional tiers in order.
  // The signature and the opt-out notice are outside every tier, so they survive
  // any amount of shrinking; if even the smallest form does not fit, eligibility
  // drops the company rather than letting the browser truncate mid-signature.
  const limit = messageLimit(schema);
  const shape = (tier: number) => tidy(fitOptional(rendered, tier));
  const full = shape(0);
  let body = full;
  for (let tier = 1; limit && body.length > limit && tier <= MAX_OPTIONAL_TIER; tier++) {
    body = shape(tier);
  }
  if (body.length !== full.length) {
    log.warn(
      `message trimmed for ${company.name}: ${full.length} -> ${body.length} chars (maxlength=${limit})`,
    );
  }

  // Compliance guard: sender company + a contact channel must appear (§9).
  if (!body.includes(s.company) || !(s.email && body.includes(s.email))) {
    log.warn('rendered body missing sender identity — check template/env sender config');
  }

  // Values to type per role. Only the truthful sender identity goes in; a role we
  // have no real value for stays unset (see the file header) so a required-but-
  // missing field gates down to a human rather than sending a fake value.
  const [sei, mei] = splitName(s.person);
  const fallbackSubject = subject || `お問い合わせ（${company.name}）`;
  const fallbackBody = body || `お世話になっております。${company.name}の採用ご担当者様へのお問い合わせです。`;
  const values: Partial<Record<FieldRole, string>> = {
    subject: fallbackSubject,
    message: fallbackBody,
    agree: 'on',
  };
  // 会社名欄は「問い合わせている側＝当社」を書く欄。宛先企業名 (`company.name`) は
  // 本文の書き出しに使う `{{company}}` であって、この欄ではない。取り違えると
  // 受け取った側は 会社名 に自社名が入った問い合わせを見ることになる。
  if (s.company) values.company = s.company;
  if (s.person) values.name = s.person;
  if (s.email) {
    values.email = s.email;
    values.email_confirm = s.email; // メール（確認）再入力欄 (課題D)
  }
  if (s.phone) values.phone = s.phone;
  if (s.department) values.department = s.department;
  if (s.postal) values.postal = s.postal;
  if (s.address) values.address = s.address;

  // --- 氏名 split (課題A): 姓/名 to separate boxes ---
  if (sei) values.name_sei = sei;
  if (mei) values.name_mei = mei;

  // --- フリガナ (課題B) ---
  // Prefer explicitly-configured katakana (split, then legacy SENDER_KANA);
  // else reuse the person field only if it is already katakana (never
  // romaji->kana guesswork here).
  if (s.kanaSei || s.kanaMei) {
    if (s.kanaSei) values.kana_sei = s.kanaSei;
    if (s.kanaMei) values.kana_mei = s.kanaMei;
    values.kana = [s.kanaSei, s.kanaMei].filter(Boolean).join(' ');
  } else if (s.kana) {
    values.kana = s.kana; // configured full kana (SENDER_KANA)
  } else if (s.person && /^[ァ-ヶー\s　]+$/.test(s.person)) {
    values.kana = s.person;
    const [ks, km] = splitName(s.person);
    if (ks) values.kana_sei = ks;
    if (km) values.kana_mei = km;
  }

  // --- 電話 split (課題A): 03-5908-8405 -> 3 (or 2) boxes ---
  Object.assign(values, splitPhoneValues(s.phone));

  // --- 郵便番号 split (課題A). Only when a truthful sender postal is configured. ---
  Object.assign(values, splitPostalValues(s.postal));

  // --- 住所 split: 都道府県 / 市区町村 / 番地・マンション名 ---
  // Distribution depends on which boxes this form has, so it is derived from the
  // schema rather than pre-computed per role.
  const slots = addressSlots(schema);
  Object.assign(values, deriveAddressValues(s.address, slots));

  // --- Manual override layer (approval dashboard edit, §13-2) ---
  // Applied last so a human correction flows into preview, plan AND execute
  // identically. Split sub-boxes (phone/postal/氏名/フリガナ/住所) are re-derived
  // from the edited base value so a corrected 電話 still fills the 3-box variant.
  let finalSubject = subject;
  let finalBody = body;
  const ov = loadOverrides(company.id);
  if (ov) {
    applyValueOverrides(values, ov.values, slots);
    if (ov.values.subject != null) finalSubject = ov.values.subject;
    if (ov.values.message != null) finalBody = ov.values.message;
  }

  return { subject: finalSubject, body: finalBody, values };
}

/** Read manual overrides for a company; never throws (DB may be absent in unit tests). */
function loadOverrides(companyId: number): ContentOverride | undefined {
  try {
    return contentOverrides.get(companyId);
  } catch {
    return undefined;
  }
}

/** 03-5908-8405 -> {phone1:'03', phone2:'5908', phone3:'8405'}; <2 parts -> {}. */
function splitPhoneValues(phone: string): Partial<Record<FieldRole, string>> {
  const parts = (phone || '').split(/[-‐‑–—―ー－ｰ\s]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3) return { phone1: parts[0], phone2: parts[1], phone3: parts.slice(2).join('') };
  if (parts.length === 2) return { phone1: parts[0], phone2: parts[1] };
  return {};
}

/** 160-0023 -> {postal1:'160', postal2:'0023'}; also handles an unhyphenated 7-digit form. */
function splitPostalValues(postal: string): Partial<Record<FieldRole, string>> {
  if (!postal) return {};
  const pp = postal.split(/[-‐‑–—―－\s]+/).map((x) => x.trim()).filter(Boolean);
  if (pp.length >= 2) return { postal1: pp[0], postal2: pp.slice(1).join('') };
  const digits = postal.replace(/[^0-9]/g, '');
  if (digits.length === 7) return { postal1: digits.slice(0, 3), postal2: digits.slice(3) };
  return {};
}

/**
 * Merge dashboard edits into the rendered `values`, re-deriving the split
 * sub-fields for the base roles that have them. Only keys present in `edits`
 * are touched; everything else keeps its deterministic default.
 */
export function applyValueOverrides(
  values: Partial<Record<FieldRole, string>>,
  edits: Partial<Record<FieldRole, string>>,
  slots: AddressSlots = { pref: false, city: false, street: false },
): void {
  const setBase = (role: FieldRole) => edits[role] != null;

  if (setBase('company')) values.company = edits.company!;
  if (setBase('department')) values.department = edits.department!;
  if (setBase('subject')) values.subject = edits.subject!;
  if (setBase('message')) values.message = edits.message!;

  if (setBase('email')) {
    values.email = edits.email!;
    values.email_confirm = edits.email!;
  }

  if (setBase('name')) {
    values.name = edits.name!;
    const [sei, mei] = splitName(edits.name!);
    if (sei) values.name_sei = sei; else delete values.name_sei;
    if (mei) values.name_mei = mei; else delete values.name_mei;
  }

  if (setBase('kana')) {
    values.kana = edits.kana!;
    const [ks, km] = splitName(edits.kana!);
    if (ks) values.kana_sei = ks; else delete values.kana_sei;
    if (km) values.kana_mei = km; else delete values.kana_mei;
  }

  if (setBase('phone')) {
    values.phone = edits.phone!;
    delete values.phone1; delete values.phone2; delete values.phone3;
    Object.assign(values, splitPhoneValues(edits.phone!));
  }

  if (setBase('postal')) {
    values.postal = edits.postal!;
    delete values.postal1; delete values.postal2;
    Object.assign(values, splitPostalValues(edits.postal!));
  }

  if (setBase('address')) {
    values.address = edits.address!;
    delete values.address_pref; delete values.address_city; delete values.address_street;
    Object.assign(values, deriveAddressValues(edits.address!, slots));
  }
}

/** Split a "姓 名" string; best-effort, only used when a form separates them. */
function splitName(full: string): [string, string] {
  const parts = full.trim().split(/[\s　]+/);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join('')];
  return [full, ''];
}
