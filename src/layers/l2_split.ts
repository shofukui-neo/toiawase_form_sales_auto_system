import type { DetectedField, FieldMapping, FieldRole } from '../types.js';

/**
 * L2 split-field detector (spec §4-L2 課題A/B/D).
 *
 * A single logical field is often spread across several <input>s in Japanese
 * forms — phone as 市外/市内/番号, name as 姓/名, postal as 上3桁/下4桁, kana
 * as セイ/メイ, or a re-typed メール（確認）. The generic one-role-per-field
 * mapper (l2_parsing) would jam a whole value into the first box and leave the
 * rest empty, so we detect these groups FIRST and assign ordered sub-roles.
 *
 * Two complementary signals are used:
 *   A. attribute conventions — name/id like tel1/tel2/tel3, sei/mei,
 *      lastname/firstname, zip1/zip2, autocomplete tokens, "確認" for email.
 *   B. structural adjacency — a run of ≥2 consecutive fillable inputs that
 *      share the same resolved label (電話番号 with three boxes, etc.).
 *
 * Fields consumed here are skipped by the generic rule mapper.
 */

export interface SplitResult {
  mappings: FieldMapping[];
  consumed: Set<number>;
}

interface Cand {
  idx: number;
  role: FieldRole;
  confidence: number;
}

function isFillableText(f: DetectedField): boolean {
  if (f.honeypot) return false;
  if (f.tag !== 'input') return false;
  const t = (f.type || 'text').toLowerCase();
  return ['text', 'tel', 'number', 'email', 'search', ''].includes(t);
}

/** name + id only, lowercased — for attribute-convention matching. */
function nameId(f: DetectedField): string {
  return [f.name, f.id, f.autocomplete].filter(Boolean).join(' ').toLowerCase();
}
/** Full haystack incl. label/placeholder. */
function hay(f: DetectedField): string {
  return [f.name, f.id, f.labelText, f.placeholder, f.autocomplete]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
function tokens(f: DetectedField): string[] {
  return nameId(f).split(/[^a-z0-9]+/).filter(Boolean);
}

const SEI_TOK = new Set(['sei', 'lastname', 'lname', 'familyname', 'surname', 'myoji', 'myouji', 'family', 'last']);
const MEI_TOK = new Set(['mei', 'firstname', 'fname', 'givenname', 'given', 'first']);

function isKanaField(f: DetectedField): boolean {
  return /フリガナ|ふりがな|カナ|かな|kana|furigana|katakana|ﾌﾘｶﾞﾅ|ヨミ|よみ|読み|振り仮名|振仮名/.test(hay(f));
}
function raw(s: string | null): string {
  return (s || '').trim();
}

/** Phone keyword present in a label (for the structural pass). */
function isPhoneLabel(s: string): boolean {
  return /電話|tel|phone|denwa|ﾃﾞﾝﾜ|ＴＥＬ|携帯/i.test(s);
}
function isPostalLabel(s: string): boolean {
  return /郵便|〒|zip|postal|post code|postcode|ゆうびん/i.test(s);
}
function isNameLabel(s: string): boolean {
  return /氏名|お名前|ご芳名|name/i.test(s) && !/会社|企業|法人|団体|部署/.test(s);
}

/**
 * Detect split-field groups and return ordered sub-role mappings plus the set
 * of field indices they consumed.
 */
export function detectSplitFields(fields: DetectedField[]): SplitResult {
  const cands: Cand[] = [];

  // ---------- A1. Phone parts by attribute (tel1/tel2/tel3, autocomplete) ----------
  const phoneParts: { idx: number; order: number; conf: number }[] = [];
  fields.forEach((f, idx) => {
    if (!isFillableText(f)) return;
    const t = (f.type || 'text').toLowerCase();
    if (t === 'email') return; // never a phone part
    const ni = nameId(f);
    const m = ni.match(/(?:tel|phone|denwa)[\s_-]?0*([1-4])(?![0-9])/);
    if (m) {
      phoneParts.push({ idx, order: parseInt(m[1], 10), conf: 0.9 });
      return;
    }
    const ac = raw(f.autocomplete).toLowerCase();
    if (ac === 'tel-area-code') phoneParts.push({ idx, order: 1, conf: 0.92 });
    else if (ac === 'tel-local-prefix') phoneParts.push({ idx, order: 2, conf: 0.92 });
    else if (ac === 'tel-local' || ac === 'tel-local-suffix') phoneParts.push({ idx, order: 3, conf: 0.92 });
  });
  if (phoneParts.length >= 2) {
    phoneParts.sort((a, b) => a.order - b.order || a.idx - b.idx);
    const roles: FieldRole[] = ['phone1', 'phone2', 'phone3'];
    phoneParts.slice(0, 3).forEach((p, i) => cands.push({ idx: p.idx, role: roles[i], confidence: p.conf }));
  }

  // ---------- A2. Postal parts by attribute (zip1/zip2) ----------
  const postalParts: { idx: number; order: number; conf: number }[] = [];
  fields.forEach((f, idx) => {
    if (!isFillableText(f)) return;
    if ((f.type || '').toLowerCase() === 'email') return;
    const ni = nameId(f);
    const m = ni.match(/(?:zip|postal|post|yubin|yuubin|postcode|zipcode)[\s_-]?0*([12])(?![0-9])/);
    if (m) postalParts.push({ idx, order: parseInt(m[1], 10), conf: 0.9 });
  });
  if (postalParts.length >= 2) {
    postalParts.sort((a, b) => a.order - b.order || a.idx - b.idx);
    const roles: FieldRole[] = ['postal1', 'postal2'];
    postalParts.slice(0, 2).forEach((p, i) => cands.push({ idx: p.idx, role: roles[i], confidence: p.conf }));
  }

  // ---------- A3. Name / kana sei-mei by attribute + label ----------
  let nameSei: Cand | null = null;
  let nameMei: Cand | null = null;
  let kanaSei: Cand | null = null;
  let kanaMei: Cand | null = null;
  fields.forEach((f, idx) => {
    if (!isFillableText(f)) return;
    if ((f.type || '').toLowerCase() === 'email') return;
    const tks = tokens(f);
    const lab = raw(f.labelText);
    const ph = raw(f.placeholder);
    const seiTok = tks.some((t) => SEI_TOK.has(t));
    const meiTok = tks.some((t) => MEI_TOK.has(t));
    const seiKanaLbl = /^(セイ|せい|ｾｲ)$/.test(lab) || /^(セイ|せい)$/.test(ph);
    const meiKanaLbl = /^(メイ|めい|ﾒｲ)$/.test(lab) || /^(メイ|めい)$/.test(ph);
    const seiKanjiLbl = /^(姓|名字|苗字|みょうじ)$/.test(lab) || /^姓$/.test(ph);
    const meiKanjiLbl = /^名$/.test(lab) || /^名$/.test(ph);
    const kana = isKanaField(f) || seiKanaLbl || meiKanaLbl;
    const sei = seiTok || seiKanaLbl || seiKanjiLbl;
    const mei = meiTok || meiKanaLbl || meiKanjiLbl;
    if (!sei && !mei) return;
    const conf = seiTok || meiTok ? 0.9 : 0.88;
    if (kana) {
      if (sei && !kanaSei) kanaSei = { idx, role: 'kana_sei', confidence: conf };
      else if (mei && !kanaMei) kanaMei = { idx, role: 'kana_mei', confidence: conf };
    } else {
      if (sei && !nameSei) nameSei = { idx, role: 'name_sei', confidence: conf };
      else if (mei && !nameMei) nameMei = { idx, role: 'name_mei', confidence: conf };
    }
  });
  // Only treat as split when BOTH halves are present (a lone 姓 is not a split).
  if (nameSei && nameMei) cands.push(nameSei, nameMei);
  if (kanaSei && kanaMei) cands.push(kanaSei, kanaMei);

  // ---------- A4. Email confirm (re-typed email) ----------
  const emailFields = fields
    .map((f, idx) => ({ f, idx }))
    .filter(
      (x) =>
        isFillableText(x.f) &&
        ((x.f.type || '').toLowerCase() === 'email' || /mail|メール|e-?mail|アドレス/.test(hay(x.f))),
    );
  if (emailFields.length >= 2) {
    const confirmMark = (f: DetectedField) =>
      /確認|再入力|かくにん|confirm|kakunin|retype|re-?enter|reenter|再度|もう一度|verify/.test(hay(f)) ||
      /(?:^|[^a-z0-9])(?:conf|confirm|verify|check|re)(?:[^a-z0-9]|$)|2$|_2\b/.test(nameId(f));
    let confirm = emailFields.find((x) => confirmMark(x.f));
    let conf = 0.9;
    if (!confirm) {
      confirm = emailFields[1]; // fallback: the 2nd email box is the confirm box
      conf = 0.8;
    }
    // Consume ONLY the confirm box; the primary email stays for the rule mapper.
    cands.push({ idx: confirm.idx, role: 'email_confirm', confidence: conf });
  }

  // ---------- B. Structural adjacency: run of same-label fillable inputs ----------
  const consumedSoFar = new Set(cands.map((c) => c.idx));
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (!isFillableText(f) || consumedSoFar.has(i) || !raw(f.labelText)) {
      i++;
      continue;
    }
    // Extend the run while the label stays identical and fields are fillable/free.
    const label = raw(f.labelText);
    const run: number[] = [i];
    let j = i + 1;
    while (
      j < fields.length &&
      isFillableText(fields[j]) &&
      !consumedSoFar.has(j) &&
      raw(fields[j].labelText) === label
    ) {
      run.push(j);
      j++;
    }
    if (run.length >= 2) {
      const kana = isKanaField(f);
      if (isPhoneLabel(label)) {
        const roles: FieldRole[] = ['phone1', 'phone2', 'phone3'];
        run.slice(0, 3).forEach((idx, k) => cands.push({ idx, role: roles[k], confidence: 0.8 }));
      } else if (isPostalLabel(label)) {
        const roles: FieldRole[] = ['postal1', 'postal2'];
        run.slice(0, 2).forEach((idx, k) => cands.push({ idx, role: roles[k], confidence: 0.8 }));
      } else if (kana) {
        cands.push({ idx: run[0], role: 'kana_sei', confidence: 0.78 });
        cands.push({ idx: run[1], role: 'kana_mei', confidence: 0.78 });
      } else if (isNameLabel(label)) {
        cands.push({ idx: run[0], role: 'name_sei', confidence: 0.78 });
        cands.push({ idx: run[1], role: 'name_mei', confidence: 0.78 });
      }
    }
    i = j > i ? j : i + 1;
  }

  // ---------- Greedy assignment: 1 field / 1 sub-role, highest confidence first ----------
  cands.sort((a, b) => b.confidence - a.confidence);
  const takenField = new Set<number>();
  const takenRole = new Set<FieldRole>();
  const mappings: FieldMapping[] = [];
  for (const c of cands) {
    if (takenField.has(c.idx) || takenRole.has(c.role)) continue;
    takenField.add(c.idx);
    takenRole.add(c.role);
    mappings.push({
      role: c.role,
      selector: fields[c.idx].selector,
      confidence: Number(c.confidence.toFixed(3)),
      source: 'structure',
    });
  }
  return { mappings, consumed: takenField };
}
