/**
 * Payload construction for the agent roles.
 *
 * Pure functions over already-fetched items: no DynamoDB, no clock, no SDK. The
 * handlers own the I/O; this module owns what the model is told, which is the
 * part worth unit-testing.
 */

import type { ExtractRequest, QuestionRequest } from './agent';
import type { EventItem, PatientItem, SessionItem } from './types';

/** Trim an event down to what the model needs — no ids, no bookkeeping. */
export function toNarrationEvent(item: EventItem) {
  return {
    stage: item.stage,
    title: item.title,
    chosenChoiceText: chosenText(item),
    impact: item.impact,
  };
}

function chosenText(item: EventItem): string {
  return item.choices.find((choice) => choice.id === item.chosenChoiceId)?.text ?? '(未记录)';
}

/**
 * Render events as the numbered timeline both prompts expect.
 *
 * `(无记录)` rather than an empty string so the prompt never contains a heading
 * with nothing under it, which the model tends to fill in from imagination.
 */
export function formatEventLines(events: readonly EventItem[]): string {
  if (events.length === 0) return '(无记录)';
  return events
    .map(
      (item, index) => `${index + 1}. [${item.stage}] ${item.title} → 选择了「${chosenText(item)}」`,
    )
    .join('\n');
}

/** The session facts both Stage C roles are given. */
function sessionLine(session: SessionItem) {
  return {
    stage: session.currentStage,
    stageIndex: session.stageIndex,
    score: session.score,
    status: session.status,
    qualityOfLife: session.qol,
  };
}

export function buildQuestionRequest(input: {
  readonly session: SessionItem;
  readonly patient: PatientItem;
  readonly recentEvents: readonly EventItem[];
  readonly question: string;
}): QuestionRequest {
  return {
    kind: 'question',
    playerId: input.session.playerId,
    sessionId: input.session.sessionId,
    // Sent by the backend rather than asked of the model: a model-facing stage
    // field gets filled with prose (measured 2026-10-16).
    stage: input.session.currentStage,
    question: input.question,
    patient: input.patient.profile,
    session: sessionLine(input.session),
    health: input.patient.health,
    recentEvents: formatEventLines(input.recentEvents),
  };
}

export function buildExtractRequest(input: {
  readonly session: SessionItem;
  readonly stage: ExtractRequest['stage'];
  readonly stageEvents: readonly EventItem[];
}): ExtractRequest {
  // Unanswered events are excluded: a choice the player has not made yet has no
  // impact to explain, and including it invites the model to invent one.
  const answered = input.stageEvents.filter((item) => item.chosenChoiceId);

  return {
    kind: 'extract',
    playerId: input.session.playerId,
    sessionId: input.session.sessionId,
    stage: input.stage,
    stageEvents: formatEventLines(answered),
    // The exact strings that appeared, unstructured. The agent uses them to
    // refuse a player's own action as a "medical concept" — measured on the
    // deployed agent, it otherwise stores choice text like
    // 「戒烟与活动计划，分阶段执行」 verbatim, and those dilute the pool a
    // citation is later drawn from.
    stageEventTexts: answered.flatMap((item) => [item.title, chosenText(item)]),
  };
}
