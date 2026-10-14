import type {
  ChoiceOutcomeData,
  EventItem,
  EventTemplate,
  Health,
  HealthDelta,
  StageKey,
} from '../types';
import { STAGE_ORDER } from '../types';
import { eventKey } from '../lib/keys';
import { clampHealth } from './health';

/**
 * The rule engine.
 *
 * Pure functions only — nothing here imports an AWS SDK, reads the clock, or
 * generates an id. Every impure input (timestamps, ids, TTL) is a parameter.
 * That is what lets the whole engine be unit-tested without mocks.
 */

export class ChoiceNotFoundError extends Error {
  constructor(eventId: string, choiceId: string) {
    super(`Event ${eventId} has no choice "${choiceId}"`);
    this.name = 'ChoiceNotFoundError';
  }
}

export class AlreadyAnsweredError extends Error {
  constructor(eventId: string, chosenChoiceId: string) {
    super(`Event ${eventId} was already answered with choice "${chosenChoiceId}"`);
    this.name = 'AlreadyAnsweredError';
  }
}

export class StageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageStateError';
  }
}

/** The subset of session state the engine reasons about. */
export interface SessionProgress {
  readonly currentStage: StageKey;
  readonly stageIndex: number;
  readonly stageEventIndex: number;
}

export function eventsForStage(
  catalog: readonly EventTemplate[],
  stage: StageKey,
): readonly EventTemplate[] {
  return catalog.filter((event) => event.stage === stage);
}

export function isFinalStage(stage: StageKey): boolean {
  return stage === STAGE_ORDER[STAGE_ORDER.length - 1];
}

export function nextStageOf(stage: StageKey): StageKey | undefined {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0 || index >= STAGE_ORDER.length - 1) return undefined;
  return STAGE_ORDER[index + 1];
}

/** Materialise the per-choice impacts so the persisted event is self-contained. */
export function choiceOutcomesOf(template: EventTemplate): Record<string, ChoiceOutcomeData> {
  const outcomes: Record<string, ChoiceOutcomeData> = {};
  for (const choice of template.choices) {
    outcomes[choice.id] = {
      impact: choice.impact,
      score: choice.score,
      rationale: choice.rationale,
    };
  }
  return outcomes;
}

/**
 * Build a persisted EventHistory item from a catalog template.
 *
 * All impure values are injected, so this stays a pure function.
 */
export function buildEventItem(
  template: EventTemplate,
  sessionId: string,
  eventId: string,
  timestamp: string,
  expiresAt: number,
): EventItem {
  const key = eventKey(sessionId, timestamp, eventId);

  return {
    ...key,
    entityType: 'EventHistory',
    eventId,
    sessionId,
    stage: template.stage,
    type: template.type,
    title: template.title,
    description: template.description,
    choices: template.choices.map((choice) => ({ id: choice.id, text: choice.text })),
    choiceOutcomes: choiceOutcomesOf(template),
    source: 'rule',
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt,
  };
}

/* ------------------------------------------------------------------ *
 * Choice resolution
 * ------------------------------------------------------------------ */

export interface ApplyChoiceInput {
  readonly catalog: readonly EventTemplate[];
  readonly event: EventItem;
  readonly progress: SessionProgress;
  readonly health: Health;
  readonly choiceId: string;
}

export interface ChoiceOutcome {
  readonly appliedImpact: HealthDelta;
  readonly health: Health;
  readonly scoreDelta: number;
  readonly rationale: string;
  readonly stageEventIndex: number;
  readonly awaitingAdvance: boolean;
  readonly nextTemplate?: EventTemplate;
}

/**
 * Resolve a player's choice.
 *
 * Advances the stage-internal cursor. When the current stage's pool is
 * exhausted the session is flagged `awaitingAdvance` and no further event is
 * generated until the player calls `/advance` — the stage boundary is always an
 * explicit player action, never an implicit side effect of answering a choice.
 */
export function applyChoice(input: ApplyChoiceInput): ChoiceOutcome {
  const { event, progress, health, choiceId, catalog } = input;

  if (event.chosenChoiceId) {
    throw new AlreadyAnsweredError(event.eventId, event.chosenChoiceId);
  }

  const outcome = event.choiceOutcomes[choiceId];
  if (!outcome) {
    throw new ChoiceNotFoundError(event.eventId, choiceId);
  }

  const nextHealth = clampHealth(health, outcome.impact);

  // The cursor is derived from the event's own position in the stage rather
  // than from a blindly incremented counter, so a retry after a conflict
  // recomputes the same answer.
  const stageEventIndex = progress.stageEventIndex + 1;
  const pool = eventsForStage(catalog, progress.currentStage);
  const nextTemplate = pool[stageEventIndex];

  return {
    appliedImpact: outcome.impact,
    health: nextHealth,
    scoreDelta: outcome.score,
    rationale: outcome.rationale,
    stageEventIndex,
    awaitingAdvance: nextTemplate === undefined,
    ...(nextTemplate ? { nextTemplate } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Stage advancement
 * ------------------------------------------------------------------ */

export interface AdvanceInput {
  readonly catalog: readonly EventTemplate[];
  readonly progress: SessionProgress;
  readonly awaitingAdvance: boolean;
}

export interface AdvanceOutcome {
  readonly stage: StageKey;
  readonly stageIndex: number;
  readonly stageEventIndex: number;
  readonly awaitingAdvance: boolean;
  readonly completed: boolean;
  readonly nextTemplate?: EventTemplate;
}

/**
 * Move to the next stage.
 *
 * Refuses unless the current stage's pool is exhausted — advancing early would
 * silently discard unanswered events. At the final stage this completes the
 * session instead of advancing.
 */
export function advanceStage(input: AdvanceInput): AdvanceOutcome {
  const { catalog, progress, awaitingAdvance } = input;

  if (!awaitingAdvance) {
    throw new StageStateError(
      `Stage "${progress.currentStage}" still has unanswered events; advance is not allowed yet`,
    );
  }

  const next = nextStageOf(progress.currentStage);

  if (!next) {
    return {
      stage: progress.currentStage,
      stageIndex: progress.stageIndex,
      stageEventIndex: progress.stageEventIndex,
      awaitingAdvance: false,
      completed: true,
    };
  }

  const pool = eventsForStage(catalog, next);
  const firstTemplate = pool[0];

  return {
    stage: next,
    stageIndex: STAGE_ORDER.indexOf(next),
    stageEventIndex: 0,
    awaitingAdvance: firstTemplate === undefined,
    completed: false,
    ...(firstTemplate ? { nextTemplate: firstTemplate } : {}),
  };
}
