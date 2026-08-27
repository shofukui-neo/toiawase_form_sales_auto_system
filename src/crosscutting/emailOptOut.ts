import { companies, suppression, audit } from '../db/repositories.js';
import { logger } from '../utils/logger.js';

const log = logger('opt-out');

/**
 * 配信停止の受付。
 *
 * 送信ワーカー (`pipeline/emailCampaign`) ではなくここに置く。配信停止を処理
 * するのは受信者向けの公開エンドポイントで、そこからクローラ（undici）や
 * SMTP クライアントまで芋づるに読み込ませる理由が無い。受け口は依存を最小に
 * しておく。
 *
 * 抑制リストはフォーム送信と共有する。メールで「もう送るな」と言われた相手に
 * フォームから接触しては、チャネルを分けた意味がない。
 */
export function applyUnsubscribe(sendId: number, companyId: number | null): void {
  if (companyId == null) return;
  const company = companies.byId(companyId);
  if (!company) return;
  // suppression は domain が主キーなので、二重クリックでも冪等。
  suppression.add(company.domain, 'opt_out');
  audit.log({
    companyId,
    layer: 'M5',
    action: 'unsubscribe',
    actor: 'recipient',
    detail: `send=${sendId}`,
  });
  log.info(`配信停止: #${companyId} ${company.name}`);
}
