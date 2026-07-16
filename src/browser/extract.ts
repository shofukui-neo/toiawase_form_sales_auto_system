import type { Page } from 'playwright';
import type { DetectedField, CaptchaKind } from '../types.js';

/**
 * DOM extraction primitives shared by L2 (parsing) and L4 (submit). Everything
 * that needs computed styles / live DOM runs here via page.evaluate.
 */

export interface ButtonInfo {
  selector: string;
  text: string;
  /** 'confirm' = goes to a confirmation screen (safe to click in Plan);
   *  'submit'  = final send (must NOT be clicked in Plan on a 1-step form). */
  kind: 'confirm' | 'submit' | 'other';
}

/** Extract every fillable field with honeypot + label + required signals. */
export async function extractFields(page: Page): Promise<DetectedField[]> {
  return page.evaluate(() => {
    function cssPath(el: Element): string {
      const e = el as HTMLElement;
      if (e.id) return `#${CSS.escape(e.id)}`;
      const nameAttr = e.getAttribute('name');
      if (nameAttr) {
        const tag = e.tagName.toLowerCase();
        const same = document.querySelectorAll(`${tag}[name="${nameAttr}"]`);
        if (same.length === 1) return `${tag}[name="${CSS.escape(nameAttr)}"]`;
      }
      // nth-of-type path fallback
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
        let sel = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
        }
        parts.unshift(sel);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }

    function isHoneypot(el: HTMLElement): boolean {
      // Custom-styled consent checkboxes hide the real <input> (display:none /
      // opacity:0 / zero-size) and show a styled proxy. These are legitimate
      // required controls, not honeypots — recognise them by their consent-ish
      // label/name/id and never treat them as traps.
      if ((el.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        const meta = `${el.getAttribute('name') || ''} ${el.id || ''} ${labelFor(el) || ''}`;
        if (/同意|個人情報|プライバシー|規約|承諾|agree|privacy|consent|policy/i.test(meta)) return false;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (parseFloat(style.opacity || '1') === 0) return true;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return true;
      // off-screen positioning
      if (rect.left < -1000 || rect.top < -1000 || rect.left > 10000) return true;
      // hidden ancestor
      let p: HTMLElement | null = el.parentElement;
      let depth = 0;
      while (p && depth < 6) {
        const ps = window.getComputedStyle(p);
        if (ps.display === 'none' || ps.visibility === 'hidden') return true;
        p = p.parentElement;
        depth++;
      }
      // common honeypot name hints
      const nm = (el.getAttribute('name') || '') + ' ' + (el.id || '');
      if (/honeypot|hp_|_hp|url_check|confirm_email|nickname|website$/i.test(nm)) {
        // only if also not obviously visible-labeled; treat as honeypot
        return true;
      }
      if ((el.getAttribute('type') || '') === 'hidden') return true;
      return false;
    }

    function labelFor(el: HTMLElement): string | null {
      // 1. explicit <label for>
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && lab.textContent) return lab.textContent.trim();
      }
      // 2. title / data-label / aria metadata common in JS-driven forms
      const meta = [
        el.getAttribute('title'),
        el.getAttribute('data-label'),
        el.getAttribute('data-name'),
        el.getAttribute('aria-label'),
      ].find((v) => !!v && v.trim());
      if (meta) return meta.trim();
      // 2. wrapping label
      let p: HTMLElement | null = el.parentElement;
      let depth = 0;
      while (p && depth < 4) {
        if (p.tagName.toLowerCase() === 'label' && p.textContent) return p.textContent.trim();
        depth++;
        p = p.parentElement;
      }
      // 3. aria-labelledby
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const ref = document.getElementById(labelledby);
        if (ref && ref.textContent) return ref.textContent.trim();
      }
      // 4. preceding cell / dt / nearby text (table & dl layouts common in JP forms)
      const row = el.closest('tr, .form-row, .form-group, dd, li');
      if (row) {
        const th = row.previousElementSibling;
        if (th && /th|dt/i.test(th.tagName) && th.textContent) return th.textContent.trim();
        const inlineTh = row.querySelector('th, dt, .label, label');
        if (inlineTh && inlineTh.textContent) return inlineTh.textContent.trim();
      }
      return null;
    }

    // Many JP forms mark a field required with a visual 必須 badge instead of the
    // HTML `required` attribute. Detect it in the field's immediate row/label
    // (tight containers only, to avoid inheriting a neighbour's badge).
    function hasRequiredBadge(el: HTMLElement): boolean {
      const areas: Element[] = [];
      const row = el.closest('tr, .form-row, .form-group, dd, li, fieldset');
      if (row) {
        areas.push(row);
        // dl/dt/dd & table layouts keep the 必須 badge in the preceding label cell.
        const prev = row.previousElementSibling;
        if (prev && /^(th|dt)$/i.test(prev.tagName)) areas.push(prev);
      }
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) areas.push(lab);
      }
      // Class-based badges (often rendered via CSS ::before, so no 必須 text): the
      // marker class can be on the label element itself or a child span.
      const reqSel =
        '.required, .req, .must, .hissu, .is-required, .form-required, [class*="requir"], [class*="hissu"]';
      for (const a of areas) {
        if (a.matches(reqSel) || a.querySelector(reqSel)) return true;
        if (/必\s*須|＊\s*必須|※\s*必須|\brequired\b/i.test(a.textContent || '')) return true;
        // An asterisk marker (label ending in * / ＊) — only trust it on a short
        // label element (dt/th/label), never a long paragraph, to avoid noise.
        if (/^(th|dt|label)$/i.test(a.tagName) && /[＊*]/.test((a.textContent || '').trim())) return true;
      }
      return false;
    }

    const out: any[] = [];
    const nodes = Array.from(document.querySelectorAll('input, textarea, select')) as HTMLElement[];
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase() as 'input' | 'textarea' | 'select';
      const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
      // skip buttons / submit inputs — those are handled as buttons
      if (tag === 'input' && ['submit', 'button', 'image', 'reset'].includes(type || '')) continue;
      const options =
        tag === 'select'
          ? Array.from(el.querySelectorAll('option')).map((o) => (o.textContent || '').trim()).filter(Boolean)
          : undefined;
      const maxLenAttr = el.getAttribute('maxlength');
      const maxLenNum = maxLenAttr ? parseInt(maxLenAttr, 10) : NaN;
      out.push({
        selector: cssPath(el),
        tag,
        type,
        name: el.getAttribute('name'),
        id: el.id || null,
        labelText: labelFor(el),
        placeholder: el.getAttribute('placeholder'),
        required:
          el.hasAttribute('required') ||
          el.getAttribute('aria-required') === 'true' ||
          hasRequiredBadge(el),
        honeypot: isHoneypot(el),
        maxLength: Number.isFinite(maxLenNum) && maxLenNum > 0 ? maxLenNum : null,
        autocomplete: el.getAttribute('autocomplete'),
        options,
      });
    }
    return out as any;
  }) as Promise<DetectedField[]>;
}

/** Classify submit/confirm buttons (spec §4-L4 button classification). */
export async function extractButtons(page: Page): Promise<ButtonInfo[]> {
  return page.evaluate(() => {
    function cssPath(el: Element): string {
      const e = el as HTMLElement;
      if (e.id) return `#${CSS.escape(e.id)}`;
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
        let sel = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
        }
        parts.unshift(sel);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }
    const CONFIRM = ['確認', 'かくにん', '内容確認', '確認画面', 'confirm', '次へ', '進む'];
    const SUBMIT = ['送信', 'そうしん', '送 信', 'submit', '送信する', '申し込', '送信内容', 'send', '送る'];
    const els = Array.from(
      document.querySelectorAll('button, input[type=submit], input[type=button], input[type=image], a[role=button]'),
    ) as HTMLElement[];
    const out: any[] = [];
    for (const el of els) {
      const text = (
        el.textContent ||
        el.getAttribute('value') ||
        el.getAttribute('alt') ||
        el.getAttribute('aria-label') ||
        ''
      ).trim();
      const low = text.toLowerCase();
      let kind: 'confirm' | 'submit' | 'other' = 'other';
      if (CONFIRM.some((k) => text.includes(k) || low.includes(k))) kind = 'confirm';
      else if (SUBMIT.some((k) => text.includes(k) || low.includes(k))) kind = 'submit';
      out.push({ selector: cssPath(el), text, kind });
    }
    return out as any;
  }) as Promise<ButtonInfo[]>;
}

/** Detect reCAPTCHA presence + version (spec §4-L2 flag). */
export async function detectCaptcha(page: Page): Promise<CaptchaKind> {
  return page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const hasV2 = !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha/api2"], iframe[title*="reCAPTCHA"]');
    const hasV3 =
      /recaptcha\/api\.js\?render=/.test(html) ||
      /grecaptcha\.execute/.test(html) ||
      !!document.querySelector('script[src*="recaptcha/api.js?render="]');
    const hasHcaptcha = !!document.querySelector('.h-captcha, iframe[src*="hcaptcha"]');
    if (hasV2 || hasHcaptcha) return 'v2';
    if (hasV3) return 'v3';
    return 'none';
  }) as Promise<CaptchaKind>;
}

/** Visible page text — used for no-sales-policy detection (§9). */
export async function getVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText || '') as Promise<string>;
}

/** Locate the <form> element selector that contains the most fields. */
export async function primaryFormSelector(page: Page): Promise<string> {
  return page.evaluate(() => {
    function cssPath(el: Element): string {
      const e = el as HTMLElement;
      if (e.id) return `#${CSS.escape(e.id)}`;
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
        let sel = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
        }
        parts.unshift(sel);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }
    const forms = Array.from(document.querySelectorAll('form')) as HTMLElement[];
    if (forms.length === 0) return 'body';
    let best = forms[0];
    let bestCount = -1;
    for (const f of forms) {
      const n = f.querySelectorAll('input, textarea, select').length;
      if (n > bestCount) {
        bestCount = n;
        best = f;
      }
    }
    return cssPath(best);
  }) as Promise<string>;
}
