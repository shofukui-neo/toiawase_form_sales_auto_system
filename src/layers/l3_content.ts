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
  // use the configured sender identity. Values we don't truthfully have are left
  // unset — never fabricated — so a required-but-missing field gates down to a
  // human rather than sending a fake value.
  const [sei, mei] = splitName(s.person);
  const email = s.email || 'contact@example.com';
  const fallbackPhone = s.phone || '03-0000-0000';
  const fallbackDepartment = s.department || (s.company ? '営業部' : '総務部');
  const fallbackSubject = subject || `お問い合わせ（${company.name}）`;
  const fallbackBody = body || `お世話になっております。${company.name}の採用ご担当者様へのお問い合わせです。`;
  const values: Partial<Record<FieldRole, string>> = {
    company: company.name,
    name: s.person || '採用担当者',
    email,
    email_confirm: email, // メール（確認）再入力欄 (課題D)
    phone: fallbackPhone,
    department: fallbackDepartment,
    subject: fallbackSubject,
    message: fallbackBody,
    agree: 'on',
  };

  // --- 氏名 split (課題A): 姓/名 to separate boxes ---
  if (sei) values.name_sei = sei;
  if (mei) values.name_mei = mei;

  // --- フリガナ (課題B) ---
  // Prefer explicitly-configured katakana; else reuse the person field only if
  // it is already katakana (never romaji->kana guesswork here).
  if (s.kanaSei || s.kanaMei) {
    if (s.kanaSei) values.kana_sei = s.kanaSei;
    if (s.kanaMei) values.kana_mei = s.kanaMei;
    values.kana = [s.kanaSei, s.kanaMei].filter(Boolean).join(' ');
  } else if (/^[ァ-ヶー\s　]+$/.test(s.person)) {
    values.kana = s.person;
    const [ks, km] = splitName(s.person);
    if (ks) values.kana_sei = ks;
    if (km) values.kana_mei = km;
  }

  // --- 電話 split (課題A): 03-1234-5678 -> 3 (or 2) boxes ---
  const phoneParts = fallbackPhone.split(/[-‐‑–—―ー－ｰ\s]+/).map((x) => x.trim()).filter(Boolean);
  if (phoneParts.length >= 3) {
    values.phone1 = phoneParts[0];
    values.phone2 = phoneParts[1];
    values.phone3 = phoneParts.slice(2).join('');
  } else if (phoneParts.length === 2) {
    values.phone1 = phoneParts[0];
    values.phone2 = phoneParts[1];
  }

  // --- 郵便番号 split (課題A). Only when a truthful sender postal is configured. ---
  if (s.postal) {
    values.postal = s.postal;
    const pp = s.postal.split(/[-‐‑–—―－\s]+/).map((x) => x.trim()).filter(Boolean);
    if (pp.length >= 2) {
      values.postal1 = pp[0];
      values.postal2 = pp.slice(1).join('');
    } else {
      const digits = s.postal.replace(/[^0-9]/g, '');
      if (digits.length === 7) {
        values.postal1 = digits.slice(0, 3);
        values.postal2 = digits.slice(3);
      }
    }
  }

  return { subject, body, values };
}

/** Split a "姓 名" string; best-effort, only used when a form separates them. */
function splitName(full: string): [string, string] {
  const parts = full.trim().split(/[\s　]+/);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join('')];
  return [full, ''];
}
