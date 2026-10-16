import type { StageKey } from '../api/types';

/**
 * Starting points for the question box, one set per stage.
 *
 * A blank input is a bad demo: players do not know what the agent can answer, and
 * "nothing happens" looks like a broken feature rather than an open prompt. These
 * are drawn from concepts the player actually meets in each stage's events, and
 * each one is answerable from the bundled corpus — so a suggestion never leads to
 * a "no material found" reply.
 *
 * Presentation only. The real answer comes from the agent, grounded in the corpus
 * plus whatever GameMaster has noted from this session.
 */
export const STAGE_QUESTIONS: Readonly<Record<StageKey, readonly string[]>> = {
  prevention: [
    '持续咳嗽两个月，为什么值得重视？',
    '戒烟为什么一个人很难做到？',
  ],
  screening: [
    '低剂量螺旋 CT 是什么？为什么高危人群要做它？',
    '为什么需要做活检？',
  ],
  diagnosis: [
    '病理报告上的「分型」和「分期」分别指什么？',
    '为什么要做基因检测？',
  ],
  treatment: [
    '靶向治疗和化疗有什么不同？',
    '治疗期间胃口不好，营养上要注意什么？',
  ],
  recovery: [
    '康复期感觉良好，为什么还要按时复查？',
    '照护者自己撑不住了，这正常吗？',
  ],
};

export function questionsForStage(stage: StageKey): readonly string[] {
  return STAGE_QUESTIONS[stage] ?? [];
}
