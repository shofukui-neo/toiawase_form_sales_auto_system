import { config } from '../config.js';
import { companies, suppression, audit } from '../db/repositories.js';
import { contacts, emailResolutions } from '../db/emailRepositories.js';
import { discoverEmails, guessRoleAddresses, hasMx, type FoundEmail } from '../layers/l0_email.js';
import { normalizeDomain } from '../utils/url.js';
import { logger } from '../utils/logger.js';

const log = logger('email-discovery');

/**
 * 1 社分のメールアドレス探索 → 保存。
 *
 * サイトのクロールは高くつくので、ドメイン単位でキャッシュする（見つからな
 * かった場合も記録して二度と探さない）。3万社を回すとき、再実行のたびに全社を
 * 再クロールしたら一晩で終わらない。
 */

export interface DiscoverOneResult {
  outcome: 'found' | 'none' | 'cached' | 'suppressed' | 'skipped';
  emails: number;
  detail?: string;
}

/** MX 確認を通した候補だけを保存する。 */
async function persist(companyId: number, found: FoundEmail[]): Promise<number> {
  // MX はドメイン単位なので、同じドメインを何度も引かない。
  const mxCache = new Map<string, boolean>();
  let saved = 0;
  for (const e of found) {
    let mx = mxCache.get(e.domain);
    if (mx === undefined) {
      mx = await hasMx(e.domain);
      mxCache.set(e.domain, mx);
    }
    contacts.upsert({
      companyId,
      email: e.email,
      source: e.source,
      roleKind: e.roleKind,
      confidence: e.confidence,
      mxOk: mx,
      pageUrl: e.pageUrl,
    });
    if (mx) saved++;
  }
  return saved;
}

export interface DiscoverOptions {
  /** 掲載アドレスが無いとき info@/contact@ を推測して登録する（既定 false）。 */
  includeGuessed?: boolean;
  /** キャッシュを無視して再探索する。 */
  force?: boolean;
}

export async function discoverEmailsForCompany(
  companyId: number,
  opts: DiscoverOptions = {},
): Promise<DiscoverOneResult> {
  const company = companies.byId(companyId);
  if (!company) return { outcome: 'skipped', emails: 0, detail: '企業が見つかりません' };

  const domain = normalizeDomain(company.domain);
  if (!domain) return { outcome: 'skipped', emails: 0, detail: 'ドメインがありません' };

  // 抑制済み（送信済み・配信停止・競合・営業お断り）は探索する意味がない。
  if (suppression.has(domain)) {
    return { outcome: 'suppressed', emails: 0, detail: '抑制リストに該当' };
  }

  if (!opts.force) {
    const cached = emailResolutions.get(domain);
    if (cached) {
      return {
        outcome: cached.found ? 'cached' : 'none',
        emails: contacts.byCompany(companyId).length,
        detail: cached.detail ?? 'キャッシュ済み',
      };
    }
  }

  const result = await discoverEmails(domain);

  // サイトに「営業メールお断り」が書かれていたら抑制する。フォーム側と同じ
  // 判断基準（§9）— チャネルが違っても意思表示は同じ。
  if (result.noSalesPolicy) {
    suppression.add(domain, 'no_sales_policy');
    audit.log({
      companyId,
      layer: 'M0',
      action: 'suppress:no_sales_policy',
      detail: result.noSalesPolicy,
    });
    emailResolutions.set(domain, false, `営業お断り: ${result.noSalesPolicy}`);
    return { outcome: 'suppressed', emails: 0, detail: `営業お断り: ${result.noSalesPolicy}` };
  }

  let candidates = result.emails;
  if (candidates.length === 0 && opts.includeGuessed) {
    // 推測は「掲載が無かった」ことを確認したうえでの最後の手段。既定では
    // 送信対象から外れる (source='guessed')。
    candidates = guessRoleAddresses(domain);
  }

  if (candidates.length === 0) {
    const detail = result.pagesFetched === 0 ? 'サイトを取得できませんでした' : 'アドレスの掲載なし';
    emailResolutions.set(domain, false, detail);
    return { outcome: 'none', emails: 0, detail };
  }

  const usable = await persist(companyId, candidates);
  emailResolutions.set(domain, usable > 0, `${candidates.length}件検出 / MX確認 ${usable}件`);
  audit.log({
    companyId,
    layer: 'M0',
    action: 'email_discovered',
    detail: `${usable}/${candidates.length} 件（${candidates.map((c) => c.email).slice(0, 3).join(', ')}）`,
  });

  if (usable === 0) {
    return { outcome: 'none', emails: 0, detail: 'MXが引けるアドレスなし' };
  }
  log.debug(`#${companyId} ${company.name}: ${usable} 件`);
  return { outcome: 'found', emails: usable };
}

/** 取り込みリストの列から来たアドレスを登録する（クロール不要）。 */
export async function registerListedEmail(companyId: number, email: string): Promise<boolean> {
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  const mx = await hasMx(domain);
  contacts.upsert({
    companyId,
    email: email.toLowerCase(),
    source: 'list',
    confidence: 0.8, // 人が用意したリストの値は掲載アドレスと同等に扱う
    mxOk: mx,
  });
  return mx;
}

/** その企業に送れる宛先があるか（送信ワーカーの入場条件）。 */
export function sendableContact(companyId: number) {
  return contacts.bestForCompany(companyId, config.email.allowGuessed);
}
