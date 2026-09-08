import type { DetectedField, FormAudience } from '../types.js';

export type { FormAudience };

/**
 * 問い合わせ窓口の「宛先」判定（承認済みポリシー: 求職者向けの窓口には送らない）。
 *
 * 送ってよいのは企業として応対している窓口だけ ── 総合お問い合わせ、法人向け窓口、
 * 採用担当へのご提案窓口。同じ「お問い合わせ」でも、採用サイトに置かれた応募者向けの
 * 窓口（応募フォーム・エントリー受付・選考に関する問い合わせ）は求職者を待っている
 * 場所で、そこに営業文面が届いても担当者が困るだけで商談にはならない。
 *
 * 判定材料は強い順に3つ。
 *   1. 入力項目 ── 志望動機・履歴書・卒業年度など、応募者しか書けない欄
 *   2. 種別の選択肢 ── 「新卒採用／経験者採用／障がい者採用」のように採用区分で埋まっている
 *   3. ページの見出しと URL ── 「応募フォーム」「/recruit/」「saiyou.example.jp」
 *
 * URL は単独では使わない。入力フォームの意味で `/entry.php` を使う CMS があり、
 * 社名に job / career を含む人材会社もあるため、URL だけで切ると本当の営業窓口を
 * 落としてしまう。必ず他の根拠と重ねて判定する。
 */

export interface AudienceInput {
  formUrl: string;
  fields: DetectedField[];
  /** ページの <title> と h1。窓口の用途が最も端的に出る。 */
  heading?: string;
  /** ページ本文の可視テキスト（L2 が取得済みのもの）。 */
  pageText?: string;
}

export interface AudienceVerdict {
  audience: FormAudience;
  /** 判定根拠。ログと除外理由にそのまま出す。 */
  evidence: string;
}

/** 応募者しか書けない項目。1件あれば応募フォームと断定してよい。 */
const APPLICANT_FIELD_RE =
  /志望動機|志望理由|自己PR|自己ＰＲ|自己紹介書|履歴書|職務経歴|職務経験|最終学歴|応募職種|希望職種|募集職種|応募区分|応募方法|応募内容|エントリーシート|希望年収|現在の年収|現年収|就業状況|転職|入社(可能|希望)|面接(希望|可能|日)|選考|保有資格|ポートフォリオ|顔写真|卒業[（(]?(見込|予定)[）)]?|卒業年度/;

/** 単独では弱いが、2つ以上そろえば応募フォームを示す学生向けの項目。 */
const STUDENT_FIELD_RE = /学校名|大学名|学校区分|学部|学科|専攻|卒業年|在学|学年/;

/**
 * 会社としての窓口を示す語。同じ欄の見出しにこれが同居していたら応募欄ではない。
 * 「会社名・学校名など」「所属部署／学部・学科」のように、1つの欄で企業の人と
 * 学生の両方を受ける総合窓口が実際に多く、これを応募フォームと数えると
 * 本物の営業窓口を捨ててしまう。
 */
const BUSINESS_LABEL_RE = /会社|企業|法人|貴社|御社|団体|組織|屋号|店舗|部署/;

/** 種別の選択肢が採用区分かどうか。 */
const APPLICANT_OPTION_RE =
  /(新卒|中途|キャリア|経験者|障がい者|障害者|第二新卒|アルバイト|パート|正社員|契約社員)(採用|募集|求人)|採用(エントリー|応募|選考)|応募|エントリー|求人|募集要項|インターン/;

/**
 * 同じ「採用」でも企業側に向けた選択肢。人材会社の営業窓口は
 * 「新卒採用のご相談／中途採用のご支援／その他」のように採用の語が並ぶので、
 * これを数えると本物の営業窓口を応募受付と誤判定する。
 */
const BUSINESS_OPTION_RE = /ご?相談|支援|サービス|導入|ご?依頼|提案|お取引|取引|掲載|代行|委託|パートナー|提携/;

/** 見出し・タイトルが「応募受付」だと言っているもの。 */
const APPLICANT_HEADING_PATTERNS: RegExp[] = [
  /応募(フォーム|受付|窓口|方法|について|に関する)/,
  /エントリー(フォーム|シート|受付|はこちら)/,
  /(新卒|中途|キャリア|経験者|障がい者|障害者|アルバイト|パート)(採用|募集)/,
  /採用(エントリー|応募|サイト|情報|に関するお問い?合わせ)/,
  /募集要項|求人(情報|募集|への応募|に関する)|職種紹介/,
  /(選考|面接)(に関する|について|の流れ|フロー)/,
  /インターン(シップ)?/,
  /履歴書|職務経歴書|エントリーシート/,
  /recruit(ing|ment)?\s*(site|form|entry)/i,
];

/**
 * 逆に「企業として応対している窓口」だと言っている見出し。採用の語と同居する
 * ページは、窓口を並べた総合の問い合わせページなので営業窓口として扱う。
 */
const BUSINESS_HEADING_PATTERNS: RegExp[] = [
  /法人(の)?(お客様|様|向け|窓口)/,
  /(お)?取引|お取り引き/,
  /資料請求|お見積|見積り|導入(事例|のご相談|検討)?/,
  /(製品|サービス|商品|事業)(に関する|について|のお問い?合わせ)/,
  /営業(所|時間)?(に関する|について)?のお問い?合わせ/,
  /ご相談|パートナー|業務提携|協業|代理店/,
];

/** ページ本文が採用サイトのものだと示す語（2語以上そろって初めて根拠にする）。 */
const RECRUIT_PAGE_TERMS = [
  '募集要項',
  '応募資格',
  '選考',
  'エントリー',
  '募集職種',
  '仕事内容',
  '勤務地',
  '待遇',
  '福利厚生',
  '先輩社員',
  '社員紹介',
  '新卒採用',
  '中途採用',
  'インターン',
];

/**
 * 採用サイト／採用ページを示す URL の語。単独では判定に使わない。
 * 区切り文字にはクエリの ? & = も入れる（`/inquiry.php?recruit` のように
 * パラメータで窓口を切り替えるフォームが実際にある）。
 */
const RECRUIT_URL_TOKEN_RE =
  /(^|[/._\-?&=])(recruit|recruiting|recruitment|saiyo|saiyou|saiyoo|shinsotsu|kyujin|kyuujin|jinji)([/._\-?&=]|$)/i;

/** URL に日本語で採用・応募が入っているもの（フォーム基盤がパラメータに載せてくる）。 */
const RECRUIT_URL_JA_RE = /採用|応募|エントリー|求人/;

/**
 * 求職者に向けた選択肢か（「新卒採用」「ご応募」「エントリー」…）。
 * 必須の種別を自動で選ぶとき、ここに当たる選択肢は選ばない ─ 選んだ時点で
 * 応募として受け付けられてしまう。「新卒採用のご相談」のように企業向けの
 * 語が付くものは営業の窓口なので除外しない。
 */
export function isApplicantOption(label: string): boolean {
  const t = (label || '').trim();
  return APPLICANT_OPTION_RE.test(t) && !BUSINESS_OPTION_RE.test(t);
}

function matchAny(patterns: RegExp[], text: string): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

/** 欄の見出し（見出し・placeholder・name・id）。 */
function fieldHay(f: DetectedField): string {
  return [f.labelText, f.placeholder, f.name, f.id].filter(Boolean).join(' ');
}

interface FieldScan {
  /** 応募者しか書けない欄の見出し（あれば断定材料）。 */
  applicant: string | null;
  /** 学生向けの欄の数。 */
  student: number;
  /** 会社名を書く欄があるか（＝企業からの問い合わせを想定した窓口）。 */
  hasCompanyField: boolean;
}

function scanFields(fields: DetectedField[]): FieldScan {
  let applicant: string | null = null;
  let student = 0;
  let hasCompanyField = false;

  for (const f of fields) {
    if (f.honeypot) continue;
    const hay = fieldHay(f);
    if (!hay) continue;
    if (/会社名|企業名|法人名|貴社名|御社名|団体名|組織名|company/i.test(hay)) hasCompanyField = true;
    // ラジオ／チェックボックスの見出しは「欄の名前」ではなく種別の選択肢。
    // 総合窓口が並べる「採用について（応募／選考に関するお問い合わせ）」を
    // 応募欄と数えないよう、選択肢の偏りを見る scanChoiceOptions に任せる。
    const type = (f.type || '').toLowerCase();
    if (type === 'radio' || type === 'checkbox') continue;
    // 企業向けの語が同居する欄は、企業と学生の両方を受ける総合窓口の欄。
    if (BUSINESS_LABEL_RE.test(hay)) continue;
    const hit = hay.match(APPLICANT_FIELD_RE);
    if (hit && !applicant) applicant = hit[0];
    if (STUDENT_FIELD_RE.test(hay)) student++;
  }

  return { applicant, student, hasCompanyField };
}

/**
 * 種別の選択肢が採用区分で占められているか。「新卒採用／経験者採用／障がい者採用／
 * その他お問い合わせ」のような窓口は、選択肢の過半が採用区分になる。逆に総合窓口の
 * 「サービスについて／業務提携／採用について／その他」は1つしか当たらない。
 */
function scanChoiceOptions(fields: DetectedField[]): string | null {
  // <select> の選択肢
  for (const f of fields) {
    if (f.honeypot || f.tag !== 'select') continue;
    const opts = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
    const hit = dominatedByApplicantOptions(opts);
    if (hit) return hit;
  }
  // ラジオ／チェックボックスのグループ
  const groups = new Map<string, string[]>();
  for (const f of fields) {
    if (f.honeypot || f.tag !== 'input') continue;
    const type = (f.type || '').toLowerCase();
    if (type !== 'radio' && type !== 'checkbox') continue;
    if (!f.name || !f.labelText) continue;
    const arr = groups.get(f.name) ?? [];
    arr.push(f.labelText.trim());
    groups.set(f.name, arr);
  }
  for (const labels of groups.values()) {
    const hit = dominatedByApplicantOptions(labels);
    if (hit) return hit;
  }
  return null;
}

/** 選択肢の過半（かつ2件以上）が採用区分なら、その最初の1件を返す。 */
function dominatedByApplicantOptions(options: string[]): string | null {
  const real = options.filter((o) => o && !/^(選択|お選び|ご選択|指定なし|未選択|--|―|▼)/.test(o));
  if (real.length < 2) return null;
  const hits = real.filter(isApplicantOption);
  if (hits.length >= 2 && hits.length * 2 > real.length) return hits[0];
  return null;
}

/** URL（日本語のパーセントエンコードも戻して）に採用サイトの語があるか。 */
function recruitUrlToken(formUrl: string): string | null {
  let decoded = formUrl;
  try {
    decoded = decodeURIComponent(formUrl);
  } catch {
    /* 壊れたエスケープはそのまま見る */
  }
  const ja = decoded.match(RECRUIT_URL_JA_RE);
  if (ja) return ja[0];
  const en = formUrl.match(RECRUIT_URL_TOKEN_RE);
  return en ? en[0].replace(/[/._\-?&=]/g, '') : null;
}

/** 本文に採用サイトの語がいくつ出てくるか。 */
function recruitPageTerms(pageText: string): string[] {
  return RECRUIT_PAGE_TERMS.filter((t) => pageText.includes(t));
}

interface PageSignals {
  /** 応募受付だと言っている見出し。 */
  headingHit: string | null;
  /** 企業向けの窓口だと言っている見出し（応募の語と同居したらこちらを採る）。 */
  businessHit: string | null;
  /** URL に含まれる採用サイトの語。 */
  urlHit: string | null;
  /** 本文に出てくる採用サイトの語。 */
  terms: string[];
}

function pageSignals(url: string, heading: string, pageText: string): PageSignals {
  return {
    headingHit: matchAny(APPLICANT_HEADING_PATTERNS, heading),
    businessHit: matchAny(BUSINESS_HEADING_PATTERNS, heading),
    urlHit: recruitUrlToken(url),
    terms: recruitPageTerms(pageText),
  };
}

/**
 * 入力項目を見ずに、ページだけで「応募受付のページ」と分かるか。
 * L1 がフォーム候補を選ぶ段階で使う（この時点ではまだ項目を解析していない）。
 * 根拠があれば文字列、無ければ null。
 */
export function looksLikeJobSeekerPage(input: {
  url: string;
  heading?: string;
  pageText?: string;
}): string | null {
  const heading = (input.heading ?? '').replace(/\s+/g, ' ');
  const s = pageSignals(input.url, heading, input.pageText ?? '');
  if (s.businessHit) return null;
  if (s.headingHit) return `見出し「${s.headingHit}」`;
  if (s.urlHit && s.terms.length >= 2) {
    return `URL「${s.urlHit}」＋本文「${s.terms.slice(0, 3).join('・')}」`;
  }
  return null;
}

/**
 * 窓口の宛先を判定する。DetectedField と URL だけでも動くので、保存済みの
 * FormSchema を後から再判定できる（ページ本文があれば根拠が増えるだけ）。
 */
export function classifyFormAudience(input: AudienceInput): AudienceVerdict {
  const heading = (input.heading ?? '').replace(/\s+/g, ' ');
  const pageText = input.pageText ?? '';
  const fields = scanFields(input.fields);

  // 1. 応募者しか書けない欄がある。
  if (fields.applicant) {
    return { audience: 'job_seeker', evidence: `入力項目「${fields.applicant}」` };
  }

  // 2. 種別の選択肢が採用区分で埋まっている。
  const optionHit = scanChoiceOptions(input.fields);
  if (optionHit) {
    return { audience: 'job_seeker', evidence: `選択肢「${optionHit}」` };
  }

  const { headingHit, businessHit, urlHit, terms } = pageSignals(input.formUrl, heading, pageText);

  // 3. 見出しが応募受付だと言っている（企業向けの語が併記されていない場合）。
  if (headingHit && !businessHit) {
    return { audience: 'job_seeker', evidence: `見出し「${headingHit}」` };
  }

  // 4. URL が採用サイトを指し、それを裏づける材料がもう1つある。
  //    URL 単独では判定しない（/entry.php や社名の job/career を誤検出するため）。
  if (urlHit && !businessHit) {
    if (headingHit) {
      return { audience: 'job_seeker', evidence: `URL「${urlHit}」＋見出し「${headingHit}」` };
    }
    if (terms.length >= 2) {
      return { audience: 'job_seeker', evidence: `URL「${urlHit}」＋本文「${terms.slice(0, 3).join('・')}」` };
    }
    if (fields.student >= 1) {
      return { audience: 'job_seeker', evidence: `URL「${urlHit}」＋学生向けの入力項目` };
    }
    if (!fields.hasCompanyField) {
      return { audience: 'job_seeker', evidence: `URL「${urlHit}」＋会社名欄なし` };
    }
  }

  // 5. 学生向けの欄が複数そろい、採用のページに置かれている。
  if (fields.student >= 2 && (urlHit || headingHit)) {
    return { audience: 'job_seeker', evidence: '学生向けの入力項目が複数' };
  }

  if (fields.hasCompanyField || businessHit) {
    return { audience: 'business', evidence: businessHit ? `見出し「${businessHit}」` : '会社名欄あり' };
  }
  return { audience: 'unknown', evidence: '' };
}
