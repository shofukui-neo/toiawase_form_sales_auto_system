import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config } from '../config.js';
import type { CompanyRow, FormSchema, RenderedContent, FieldRole } from '../types.js';
import { logger } from '../utils/logger.js';

const log = logger('L3');

/**
 * L3 — content generation (spec §4-L3). Phase 1 = template + variable
 * substitution. Deterministic on purpose: the Plan and Execute phases must
 * render identical text (spec §4-L4). Compliance requires the sender identity
 * be present and truthful (§9).
 */

interface ParsedTemplate {
  subject: string;
  body: string;
}

/** Load a markdown template with a `--- subject: ... ---` front-matter line. */
function loadTemplate(name: string): ParsedTemplate {
  const raw = readFileSync(resolve(ROOT, 'config/templates', `${name}.md`), 'utf8');
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fm) return { subject: '', body: raw.trim() };
  const subjectLine = fm[1].match(/subject:\s*(.*)/);
  return { subject: subjectLine ? subjectLine[1].trim() : '', body: fm[2].trim() };
}

function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
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
  const vars: Record<string, string> = {
    company: company.name,
    senderCompany: s.company,
    senderProduct: s.product,
    senderPerson: s.person,
    senderEmail: s.email,
    // Only render a phone line if a phone is configured (avoids a dangling label).
    senderPhoneLine: s.phone ? `\nTEL：${s.phone}` : '',
  };

  const subject = substitute(tpl.subject, vars);
  const body = substitute(tpl.body, vars);

  // Compliance guard: sender company + a contact channel must appear (§9).
  if (!body.includes(s.company) || !(s.email && body.includes(s.email))) {
    log.warn('rendered body missing sender identity — check template/env sender config');
  }

  // Values to type per role. We only supply what a legitimate sales inquiry needs;
  // roles the form has but we can't truthfully fill (e.g. kana of a real person)
  // use the configured sender identity.
  const [sei, mei] = splitName(s.person);
  const values: Partial<Record<FieldRole, string>> = {
    company: s.company,
    name: s.person,
    kana: '', // left blank unless a kana of the sender is configured; see note below
    email: s.email,
    phone: s.phone,
    department: '',
    subject,
    message: body,
    agree: 'on',
  };

  // Provide something for kana if the form requires it, to avoid validation fails;
  // uses a placeholder derived from the person field only if it is katakana already.
  if (/^[ァ-ヶー\s]+$/.test(s.person)) values.kana = s.person;

  return { subject, body, values };
}

/** Split a "姓 名" string; best-effort, only used when a form separates them. */
function splitName(full: string): [string, string] {
  const parts = full.trim().split(/[\s　]+/);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join('')];
  return [full, ''];
}
