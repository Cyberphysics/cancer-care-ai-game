import type { EntityType } from './lib/keys';

/* ------------------------------------------------------------------ *
 * Domain primitives
 * ------------------------------------------------------------------ */

/** The five stages of the care journey (GDD §4). Mirrors frontend/src/data/stages.ts. */
export type StageKey = 'prevention' | 'screening' | 'diagnosis' | 'treatment' | 'recovery';

export const STAGE_ORDER: readonly StageKey[] = [
  'prevention',
  'screening',
  'diagnosis',
  'treatment',
  'recovery',
] as const;

export type SessionStatus = 'active' | 'completed' | 'abandoned';
export type EventType = 'medical' | 'care' | 'emotion';
export type HealthDimension = 'qualityOfLife' | 'energy' | 'stress' | 'nutrition';

export const HEALTH_DIMENSIONS: readonly HealthDimension[] = [
  'qualityOfLife',
  'energy',
  'stress',
  'nutrition',
] as const;

/** All four dimensions, each constrained to 0–100. */
export type Health = Record<HealthDimension, number>;

/** A signed change to zero or more dimensions. */
export type HealthDelta = Partial<Record<HealthDimension, number>>;

/* ------------------------------------------------------------------ *
 * Persisted entities
 *
 * These are the item shapes written through DynamoDBDocumentClient, so an
 * object of these types *is* the stored record.
 * ------------------------------------------------------------------ */

interface BaseItem {
  readonly PK: string;
  readonly SK: string;
  readonly entityType: EntityType;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Epoch seconds consumed by the table's TTL attribute. */
  readonly expiresAt: number;
}

/**
 * A player (the "family health guardian").
 *
 * Deliberately has no `GSI1PK` / `GSI1SK` members. The index is sparse — a
 * player must never enter it, and DynamoDB rejects an empty string as a key
 * attribute, so "blank it out" is not an option. Omitting the fields from the
 * type makes the mistake unrepresentable rather than merely discouraged.
 */
export interface PlayerItem extends BaseItem {
  readonly entityType: 'Player';
  readonly playerId: string;
  readonly nickname: string;
  readonly locale?: string;
}

/** A GameSession. This is the only entity that carries the sparse GSI keys. */
export interface SessionItem extends BaseItem {
  readonly entityType: 'GameSession';
  readonly GSI1PK: string;
  readonly GSI1SK: string;
  readonly sessionId: string;
  readonly playerId: string;
  readonly patientId: string;
  readonly currentStage: StageKey;
  readonly stageIndex: number;
  /**
   * Index of the *active* event within the current stage's event pool.
   *
   * Zero on entering a stage, and incremented by one each time a choice is
   * resolved. The stage is exhausted when this reaches the pool length — at
   * which point `activeEventSk` is cleared and `awaitingAdvance` is set.
   */
  readonly stageEventIndex: number;
  /**
   * Sort key of the event awaiting a choice, enabling a direct GetItem instead
   * of a Query. Absent once the stage's pool is exhausted.
   */
  readonly activeEventSk?: string;
  /** True once the current stage's event pool is exhausted. */
  readonly awaitingAdvance: boolean;
  readonly score: number;
  /** Mirrors `patient.health.qualityOfLife` so listings need no second read. */
  readonly qol: number;
  readonly status: SessionStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  /** Optimistic-lock version. See docs/DATA-MODEL.md §9. */
  readonly version: number;
}

export interface PatientProfile {
  readonly displayName: string;
  readonly age: number;
  readonly gender: 'male' | 'female';
  readonly occupation: string;
  readonly riskFactors: readonly string[];
}

export interface MedicalRecord {
  readonly recordId: string;
  readonly title: string;
  readonly kind: string;
  readonly recordedAt: string;
}

export interface CareTask {
  readonly taskId: string;
  readonly title: string;
  readonly category: string;
  readonly done: boolean;
  readonly dueAt?: string;
}

export interface Appointment {
  readonly appointmentId: string;
  readonly title: string;
  readonly scheduledAt: string;
}

export interface PatientCare {
  readonly medicalRecords: readonly MedicalRecord[];
  readonly tasks: readonly CareTask[];
  readonly appointments: readonly Appointment[];
}

export interface TimelineEntry {
  readonly stage: StageKey;
  readonly enteredAt: string;
  readonly note?: string;
}

/** PatientState. Also has no sparse-index members. */
export interface PatientItem extends BaseItem {
  readonly entityType: 'PatientState';
  readonly patientId: string;
  readonly sessionId: string;
  readonly profile: PatientProfile;
  readonly health: Health;
  readonly care: PatientCare;
  readonly relationship: { readonly familySupport: number };
  readonly timeline: readonly TimelineEntry[];
  readonly version: number;
}

/** What a choice does. Persisted with the event so the record is self-contained. */
export interface ChoiceOutcomeData {
  readonly impact: HealthDelta;
  readonly score: number;
  readonly rationale: string;
}

/** EventHistory. Also has no sparse-index members. */
export interface EventItem extends BaseItem {
  readonly entityType: 'EventHistory';
  readonly eventId: string;
  readonly sessionId: string;
  readonly stage: StageKey;
  readonly type: EventType;
  readonly title: string;
  readonly description: string;
  readonly choices: readonly ChoiceOption[];
  /**
   * Impacts keyed by choice id.
   *
   * Materialised onto the event rather than looked up from the catalog at choice
   * time, so editing the catalog can never retroactively change what a past
   * event meant. **Never serialised into `EventResponse` for an unanswered
   * event** — that would hand the player the answer key.
   */
  readonly choiceOutcomes: Readonly<Record<string, ChoiceOutcomeData>>;
  readonly chosenChoiceId?: string;
  readonly impact?: HealthDelta;
  /** Why this impact — surfaced to the player, and input to the Phase 3 agent. */
  readonly agentRationale?: string;
  readonly source: 'rule' | 'agent';
  readonly timestamp: string;
  /** Points awarded for the chosen option. */
  readonly score?: number;
}

export interface ChoiceOption {
  readonly id: string;
  readonly text: string;
}

/* ------------------------------------------------------------------ *
 * Content catalog (see content/events.ts, content/patients.ts)
 * ------------------------------------------------------------------ */

export interface EventChoiceTemplate extends ChoiceOption {
  readonly impact: HealthDelta;
  readonly score: number;
  readonly rationale: string;
}

export interface EventTemplate {
  readonly id: string;
  readonly stage: StageKey;
  readonly type: EventType;
  readonly title: string;
  readonly description: string;
  readonly choices: readonly EventChoiceTemplate[];
}

export interface PatientTemplate {
  readonly id: string;
  readonly profile: PatientProfile;
  readonly initialHealth: Health;
  readonly initialFamilySupport: number;
  /** Seeds the opening scene so the first event reads coherently. */
  readonly openingNote: string;
}

/* ------------------------------------------------------------------ *
 * Wire contracts
 * ------------------------------------------------------------------ */

/** Shape of an HTTP API (payload v2) invocation, narrowed to what this router uses. */
export interface HttpApiEvent {
  readonly rawPath: string;
  readonly requestContext: {
    readonly http: { readonly method: string };
  };
  readonly pathParameters?: { readonly [name: string]: string | undefined };
  readonly body?: string | null;
  readonly headers: { readonly [name: string]: string | undefined };
}

export interface ApiResponse {
  readonly statusCode: number;
  readonly headers: { readonly [name: string]: string };
  readonly body: string;
}

/** POST /api/v1/players */
export interface CreatePlayerRequest {
  readonly nickname: string;
  readonly locale?: string;
}

export interface PlayerResponse {
  readonly playerId: string;
  readonly nickname: string;
  readonly createdAt: string;
}

/** POST /api/v1/sessions */
export interface CreateSessionRequest {
  readonly playerId: string;
  /** Id of a synthetic case template. Omit to pick one deterministically. */
  readonly patientTemplateId?: string;
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

export interface EventResponse {
  readonly eventId: string;
  readonly stage: StageKey;
  readonly type: EventType;
  readonly title: string;
  readonly description: string;
  readonly choices: readonly ChoiceOption[];
  readonly chosenChoiceId?: string;
  readonly impact?: HealthDelta;
  readonly rationale?: string;
  readonly timestamp: string;
}

/** POST /api/v1/sessions/{sessionId}/choices — the core game-loop step. */
export interface SubmitChoiceRequest {
  readonly eventId: string;
  readonly choiceId: string;
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

/** Uniform error envelope returned by every non-2xx response. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly phase?: number;
    readonly route?: string;
    readonly details?: unknown;
  };
}
