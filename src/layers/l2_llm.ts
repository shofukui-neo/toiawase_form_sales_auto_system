import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type { DetectedField, FieldRole } from '../types.js';
import { logger } from '../utils/logger.js';

const log = logger('L2-llm');

const VALID_ROLES: FieldRole[] = [
  'company', 'name', 'kana', 'email', 'phone', 'department', 'subject', 'message', 'agree', 'unknown',
];

export interface LlmMapping {
  selector: string;
  role: FieldRole;
  confidence: number;
}

/**
 * L2 LLM fallback (spec §4-L2 ③). Only *ambiguous* fields are sent, in ONE
 * batched call, to keep cost minimal. No-ops (returns []) when no API key is
 * configured — the pipeline then relies on rules alone.
 */
export async function classifyAmbiguousFields(
  ambiguous: DetectedField[],
): Promise<LlmMapping[]> {
  if (ambiguous.length === 0) return [];
  if (!config.anthropicApiKey) {
    log.warn('no ANTHROPIC_API_KEY; skipping LLM fallback');
    return [];
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const compact = ambiguous.map((f, i) => ({
    i,
    selector: f.selector,
    tag: f.tag,
    type: f.type,
    name: f.name,
    label: f.labelText,
    placeholder: f.placeholder,
    required: f.required,
    options: f.options,
  }));

  const prompt = `あなたは日本語の企業「お問い合わせフォーム」の項目分類器です。
以下の各フィールドを、次のロールのいずれかに分類してください:
${VALID_ROLES.join(', ')}
（company=会社名, name=氏名, kana=フリガナ, email=メール, phone=電話, department=部署/役職, subject=件名, message=本文/問い合わせ内容, agree=同意チェック, unknown=判別不能）

フィールド一覧(JSON):
${JSON.stringify(compact, null, 2)}

各フィールドについて {"i": 番号, "role": ロール, "confidence": 0..1} を返し、
全体を {"mappings": [...]} という**JSONのみ**で出力してください。説明文は不要です。`;

  try {
    const res = await client.messages.create({
      model: config.llmModel,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const jsonStr = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(jsonStr) as { mappings: { i: number; role: string; confidence: number }[] };
    const out: LlmMapping[] = [];
    for (const m of parsed.mappings ?? []) {
      const field = ambiguous[m.i];
      if (!field) continue;
      const role = (VALID_ROLES.includes(m.role as FieldRole) ? m.role : 'unknown') as FieldRole;
      if (role === 'unknown') continue;
      out.push({
        selector: field.selector,
        role,
        // LLM confidence is discounted slightly vs. high-certainty rule hits.
        confidence: Math.min(0.85, Math.max(0, m.confidence ?? 0.6)),
      });
    }
    log.info(`classified ${out.length}/${ambiguous.length} ambiguous fields via LLM`);
    return out;
  } catch (e) {
    log.error(`LLM fallback failed: ${(e as Error).message}`);
    return [];
  }
}
