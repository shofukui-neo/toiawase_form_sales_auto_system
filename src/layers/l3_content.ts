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
  const fallbackPhone = s.phone || '03-0000-0000';
  const fallbackDepartment = s.company ? '営業部' : '総務部';
  const fallbackSubject = subject || `お問い合わせ（${company.name}）`;
  const fallbackBody = body || `お世話になっております。${company.name}の採用ご担当者様へのお問い合わせです。`;
  const values: Partial<Record<FieldRole, string>> = {
    company: company.name,
    name: s.person || '採用担当者',
    kana: s.kana, // configured sender kana (SENDER_KANA)
    email: s.email || 'contact@example.com',
    email_confirm: s.email || 'contact@example.com',
    phone: fallbackPhone,
    department: fallbackDepartment,
    subject: fallbackSubject,
    message: fallbackBody,
    postal: s.postal,
    address: s.address,
    agree: 'on',
  };

  // Fall back to the person field for kana only if it is already katakana.
  if (!values.kana && /^[ァ-ヶー\s　]+$/.test(s.person)) values.kana = s.person;

  return { subject, body, values };
}

/** Split a "姓 名" string; best-effort, only used when a form separates them. */
function splitName(full: string): [string, string] {
  const parts = full.trim().split(/[\s　]+/);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join('')];
  return [full, ''];
}
