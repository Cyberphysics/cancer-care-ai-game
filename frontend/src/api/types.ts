/**
 * Wire contracts of the game API.
 *
 * These mirror `infra/cdk/lambda/game-api/src/types.ts` by hand. The frontend is
 * a separate build with no import path into the Lambda source tree, so the
 * duplication is deliberate rather than incidental — and it is kept honest by
 * being exercised against the deployed API on every smoke run
 * (`scripts/game-loop-check.py` drives the same endpoints).
 *
 * Only the fields the UI reads are declared. Responses carry more.
 */

/* ------------------------------------------------------------------ *
 * Domain primitives — same literals the backend uses
 * ------------------------------------------------------------------ */

export type StageKey = 'prevention' | 'screening' | 'diagnosis' | 'treatment' | 'recovery';
export type SessionStatus = 'active' | 'completed' | 'abandoned';
export type EventType = 'medical' | 'care' | 'emotion';
export type HealthDimension = 'qualityOfLife' | 'energy' | 'stress' | 'nutrition';

/** All four dimensions, each constrained to 0–100 by the backend. */
export type Health = Record<HealthDimension, number>;

/** A signed change to zero or more dimensions. */
export type HealthDelta = Partial<Record<HealthDimension, number>>;

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

export interface HealthResponse {
  readonly status: string;
  readonly phase: number;
  readonly description: string;
  readonly stage: string;
  readonly region: string;
  readonly tableName: string;
  readonly catalogEvents: number;
  readonly stages: readonly string[];
  readonly disclaimer: string;
  readonly timestamp: string;
}

export interface PlayerResponse {
  readonly playerId: string;
  readonly nickname: string;
  readonly createdAt: string;
}

export interface PatientProfile {
  readonly displayName: string;
  readonly age: number;
  readonly gender: 'male' | 'female';
  readonly occupation: string;
  readonly riskFactors: readonly string[];
}

export interface ChoiceOption {
  readonly id: string;
  readonly text: string;
}

export interface EventResponse {
  readonly eventId: string;
  readonly stage: StageKey;
  readonly type: EventType;
  readonly title: string;
  readonly description: string;
  readonly choices: readonly ChoiceOption[];
  readonly chosenChoiceId?: string;
  /**
   * Only present once the event is answered. The backend withholds the impacts
   * of an unanswered event so the response cannot leak the answer key.
   */
  readonly impact?: HealthDelta;
  readonly rationale?: string;
  readonly timestamp: string;
}

export interface SessionResponse {
  readonly sessionId: string;
  readonly playerId: string;
  readonly patientId: string;
  readonly currentStage: StageKey;
  readonly stageIndex: number;
  readonly score: number;
  readonly qualityOfLife: number;
  readonly status: SessionStatus;
  readonly awaitingAdvance: boolean;
  readonly startedAt: string;
  readonly patient: PatientProfile;
  readonly health: Health;
  readonly activeEvent?: EventResponse | null;
}

export interface SubmitChoiceResponse {
  readonly session: SessionResponse;
  readonly appliedImpact: HealthDelta;
  readonly health: Health;
  readonly score: number;
  readonly rationale: string;
  readonly nextEvent: EventResponse | null;
  readonly awaitingAdvance: boolean;
  readonly completed: boolean;
}

export interface AdvanceResponse {
  readonly session: SessionResponse;
  readonly nextEvent: EventResponse | null;
  readonly completed: boolean;
}

export interface EventListResponse {
  readonly sessionId: string;
  readonly count: number;
  readonly disclaimer: string;
  readonly events: readonly EventResponse[];
}

export type NarrationKind = 'choice' | 'summary';

export interface NarrationResponse {
  readonly text: string;
  readonly kind: NarrationKind;
  readonly provider: string;
  readonly modelId: string;
  /** True when the content guard rejected the model output and substituted a generic text. */
  readonly degraded: boolean;
  readonly generatedAt: string;
  /** True when this came from the session's cache rather than a fresh generation. */
  readonly cached: boolean;
}

/** One source an answer cites, keyed by the `[S1]`-style label used in the text. */
export interface Citation {
  readonly label: string;
  readonly title: string;
  /**
   * The publisher. Either a real clinical source, or the game's own note — the
   * backend labels session-derived notes honestly rather than dressing them up.
   */
  readonly source: string;
  readonly url?: string | null;
}

/** POST /api/v1/sessions/{sessionId}/questions — the Medical Education role. */
export interface QuestionResponse {
  readonly text: string;
  readonly kind: 'question';
  /**
   * The sources actually used. The backend drops any label the model invented,
   * so everything here exists — but the list is empty when the answer cited
   * nothing, which is a visible state rather than a degraded one.
   */
  readonly citations: readonly Citation[];
  /** True only when `text` is the guard's fallback, not a generated answer. */
  readonly degraded: boolean;
  readonly provider?: string;
  readonly modelId?: string;
  readonly generatedAt: string;
}

/** POST /api/v1/sessions/{sessionId}/knowledge — the extraction role. */
export interface KnowledgeResponse {
  readonly stage: string;
  /** Notes written. Zero is normal: the stage was already extracted, or nothing new. */
  readonly stored: number;
  readonly memoryConfigured: boolean;
  readonly generatedAt: string;
}
