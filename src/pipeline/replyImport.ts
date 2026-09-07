import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { db } from '../db/db.js';
import { companies, outcomes, submissions } from '../db/repositories.js';
import { transition } from '../core/stateMachine.js';
import { classifyMail, matchCompany, type InboundMail, type CompanyKey } from './replyMatch.js';
import { logger } from '../utils/logger.js';

const log = logger('reply');

/**
 * 受信メールから返信・アポを取り込む。
 *
 * メールサーバへ直接つなぐ作りにはしていない。認証情報を新たに預かる必要が
 * あり、それを決めるのは運用側だから。ここではメールクライアントから
 * 書き出したファイルを読む。取り込みの本体（分類と企業の対応づけ）は
 * replyMatch にあるので、後から IMAP を足すときもそのまま使える。
 *
 * 受け付ける形式
 *   - .eml を置いたディレクトリ（UTF-8 / base64 / quoted-printable）
 *   - CSV: from,subject,date,body （1 行目はヘッダ、UTF-8）
 */

export interface ImportResult {
  total: number;
  recorded: number;
  autoReplies: number;
  unmatched: number;
  byKind: Record<string, number>;
  lines: string[];
}

/* -------------------------------- .eml -------------------------------- */

function decodeBody(raw: string, headers: Record<string, string>): string {
  const enc = (headers['content-transfer-encoding'] ?? '').toLowerCase().trim();
  const charset = /charset="?([\w-]+)"?/i.exec(headers['content-type'] ?? '')?.[1]?.toLowerCase();
  // ISO-2022-JP は Node の標準デコーダに無い。誤って化けたまま判定すると
  // 「本文が空」「分類不能」として静かに取りこぼすので、はっきり断る。
  if (charset && /iso-2022-jp|euc-jp|shift_jis|sjis/.test(charset)) {
    throw new Error(`未対応の文字コード (${charset}) — メールクライアントで UTF-8 に書き出してください`);
  }
  if (enc === 'base64') return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    return raw
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
  return raw;
}

/** MIME エンコードされた件名 (=?UTF-8?B?...?=) を戻す。 */
function decodeHeaderValue(v: string): string {
  return v.replace(
    /=\?([\w-]+)\?([BQ])\?([^?]*)\?=/gi,
    (whole: string, cs: string, kind: string, data: string) => {
      if (!/utf-?8/i.test(cs)) return whole;
      if (kind.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      return data
        .replace(/_/g, ' ')
        .replace(/=([0-9A-F]{2})/gi, (_x: string, h: string) => String.fromCharCode(parseInt(h, 16)));
    },
  );
}

export function parseEml(text: string): InboundMail {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  const split = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
  const headerBlock = split > 0 ? text.slice(0, split) : text;
  const rawBody = split > 0 ? text.slice(split).replace(/^\s+/, '') : '';

  const headers: Record<string, string> = {};
  // 折り返された行 (先頭が空白) は前の行の続き。
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return {
    from: decodeHeaderValue(headers['from'] ?? ''),
    subject: decodeHeaderValue(headers['subject'] ?? ''),
    body: decodeBody(rawBody, headers),
    headers,
    receivedAt: headers['date'],
  };
}

/* --------------------------------- CSV --------------------------------- */

/** RFC4180 相当の最小パーサ（引用内の改行とエスケープに対応）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function parseMailCsv(text: string): InboundMail[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iFrom = idx('from', '送信元', '差出人');
  const iSubj = idx('subject', '件名');
  const iBody = idx('body', '本文');
  const iDate = idx('date', '受信日時', '日付');
  if (iFrom < 0 || iBody < 0) {
    throw new Error('CSV に from と body の列が必要です（1行目がヘッダ、UTF-8）');
  }
  return rows.slice(1).map((r) => ({
    from: r[iFrom] ?? '',
    subject: iSubj >= 0 ? r[iSubj] ?? '' : '',
    body: r[iBody] ?? '',
    receivedAt: iDate >= 0 ? r[iDate] : undefined,
  }));
}

/* ------------------------------ 取り込み ------------------------------ */

function loadMails(path: string): { mails: InboundMail[]; skipped: string[] } {
  const mails: InboundMail[] = [];
  const skipped: string[] = [];
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (extname(name).toLowerCase() !== '.eml') continue;
      try {
        mails.push(parseEml(readFileSync(resolve(path, name), 'utf8')));
      } catch (e) {
        skipped.push(`${name}: ${(e as Error).message}`);
      }
    }
    return { mails, skipped };
  }
  const text = readFileSync(path, 'utf8');
  if (extname(path).toLowerCase() === '.csv') return { mails: parseMailCsv(text), skipped };
  try {
    mails.push(parseEml(text));
  } catch (e) {
    skipped.push(`${path}: ${(e as Error).message}`);
  }
  return { mails, skipped };
}

/** 送信済みの企業だけを照合対象にする。送っていない企業に反応は付かない。 */
function contactedCompanies(): CompanyKey[] {
  return db()
    .prepare(
      `SELECT DISTINCT c.id, c.name, c.domain
         FROM companies c
         JOIN submissions s ON s.company_id = c.id
        WHERE s.submitted_at IS NOT NULL`,
    )
    .all() as CompanyKey[];
}

export function importReplies(path: string, opts: { apply: boolean }): ImportResult {
  const { mails, skipped } = loadMails(path);
  const list = contactedCompanies();
  const byKind: Record<string, number> = {};
  const lines: string[] = [];
  let recorded = 0;
  let autoReplies = 0;
  let unmatched = 0;

  for (const s of skipped) lines.push(`… 読めませんでした ${s}`);

  for (const mail of mails) {
    const cls = classifyMail(mail);
    byKind[cls.kind] = (byKind[cls.kind] ?? 0) + 1;

    if (cls.kind === 'auto_reply') {
      autoReplies++;
      lines.push(`— 自動返信として除外: ${mail.subject.slice(0, 40)} (${cls.reason})`);
      continue;
    }
    if (cls.kind === 'unknown') {
      lines.push(`? 分類できず: ${mail.from} ${mail.subject.slice(0, 40)}`);
      continue;
    }

    const m = matchCompany(mail, list);
    if (!m) {
      unmatched++;
      lines.push(`? 企業を特定できず: ${mail.from} ${mail.subject.slice(0, 40)}`);
      continue;
    }

    const mark = cls.kind === 'appointment' ? '★' : '✓';
    lines.push(`${mark} #${m.company.id} ${m.company.name} → ${cls.kind} (${m.how}/${cls.reason})`);
    if (!opts.apply) continue;

    const sub = submissions.latestForCompany(m.company.id);
    let occurredAt: string | null = null;
    if (mail.receivedAt) {
      const d = new Date(mail.receivedAt);
      if (!Number.isNaN(d.getTime())) occurredAt = d.toISOString().slice(0, 19).replace('T', ' ');
    }
    outcomes.record({
      companyId: m.company.id,
      submissionId: sub?.id ?? null,
      kind: cls.kind,
      source: 'inbox',
      note: `${mail.subject.slice(0, 80)} / ${cls.reason}`,
      occurredAt,
    });
    recorded++;

    const company = companies.byId(m.company.id);
    if (company?.status === 'SUBMITTED_SUCCESS' && (cls.kind === 'reply' || cls.kind === 'appointment')) {
      try {
        transition(m.company.id, 'REPLIED', { actor: 'reply-import', detail: cls.reason });
      } catch (e) {
        log.warn(`状態遷移できず company=${m.company.id}: ${(e as Error).message}`);
      }
    }
  }

  return { total: mails.length, recorded, autoReplies, unmatched, byKind, lines };
}
