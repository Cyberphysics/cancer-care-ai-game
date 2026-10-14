/**
 * Output guard for generated health content.
 *
 * The agent guards its own output before returning it (`agents/game-master/app/safety.py`).
 * This is the same guard on the **receiving** side, because the backend must not
 * trust the agent: a prompt injection, a model regression, or a future provider
 * swap could all produce text the agent's own check did not see.
 *
 * The rules are duplicated across the two languages on purpose rather than
 * shared from one file — what matters is that both reject the same inputs, and
 * that is enforced by running the *same example strings* through both test
 * suites (`test/lambda/safety.test.ts` and `tests/test_safety.py`). Testing the
 * behaviour survives refactors; sharing the file only survives path changes.
 *
 * Boundary: **concepts are allowed, prescriptions are not.** GDD §4 teaches
 * "什么是靶向治疗", so banning those words would defeat the game.
 */

export interface SafetyViolation {
  readonly label: string;
}

interface Rule {
  readonly pattern: RegExp;
  readonly label: string;
}

const RULES: readonly Rule[] = [
  { pattern: /\d+(?:\.\d+)?\s*%/, label: '百分比数字（可能是生存率或治愈率）' },
  { pattern: /生存率|存活率|治愈率|五年生存|预期寿命|还能活/, label: '生存期或治愈率表述' },
  {
    pattern: /建议(服用|使用|注射|口服)|推荐(服用|使用|注射)|应当(服用|使用)/,
    label: '药物或治疗推荐',
  },
  { pattern: /\d+\s*(?:mg|毫克|微克|μg|ug)\b/, label: '药物剂量' },
  { pattern: /每日\s*(服用|注射)\s*\d+/, label: '用药频次' },
  { pattern: /确诊为|您患(?:有|了)|你的病是|你得了/, label: '诊断断言' },
  {
    pattern: /顺铂|培美曲塞|吉西他滨|紫杉醇|奥希替尼|厄洛替尼|帕博利珠|纳武利尤|贝伐珠单抗/,
    label: '具体药物名称',
  },
];

/**
 * Used when the agent's output cannot be trusted. Deliberately generic: it must
 * be true regardless of what the player did, and must not masquerade as analysis.
 */
export const SAFE_FALLBACK =
  '本局照护记录已保存。你的选择会影响患者的生活质量与情绪状态——' +
  '重点是持续关注、及时就医、把资料整理清楚，并在需要时寻求专业医生的意见。' +
  '本内容仅用于健康教育，不构成任何诊断或治疗建议。';

export function findViolations(text: string): string[] {
  return RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
}

export function isSafe(text: string): boolean {
  return findViolations(text).length === 0;
}

/**
 * Returns the text if it passes, otherwise the safe fallback.
 *
 * Returns both so the caller can tell the player that what they are reading is
 * generic rather than generated — passing the fallback off as analysis would be
 * worse than saying nothing.
 */
export function sanitize(text: string): { text: string; degraded: boolean } {
  if (isSafe(text)) return { text, degraded: false };
  return { text: SAFE_FALLBACK, degraded: true };
}
