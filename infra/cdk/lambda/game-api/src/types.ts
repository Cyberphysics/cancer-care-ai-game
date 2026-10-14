/**
 * Wire contracts for the game API.
 *
 * Phase 0 defines these so every route has a written input/output contract
 * (GDD §17: "all Agent tools must have clearly defined inputs and outputs").
 * Nothing here is enforced yet — the routes that would consume these types
 * return 501 until Phase 2.
 */

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

/** The five stages of the care journey. Mirrors frontend/src/data/stages.ts. */
export type StageKey = 'prevention' | 'screening' | 'diagnosis' | 'treatment' | 'recovery';

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

/** POST /api/v1/sessions — creates the session and its synthetic patient. */
export interface CreateSessionRequest {
  readonly playerId: string;
  /** Omit to let the backend generate a synthetic case (the only supported mode). */
  readonly patientTemplate?: string;
}

export interface SessionResponse {
  readonly sessionId: string;
  readonly playerId: string;
  readonly patientId: string;
  readonly currentStage: StageKey;
  readonly stageIndex: number;
  readonly score: number;
  readonly qualityOfLife: number;
  readonly status: 'active' | 'completed' | 'abandoned';
  readonly startedAt: string;
}

/** GET /api/v1/sessions/{sessionId}/events */
export interface EventResponse {
  readonly eventId: string;
  readonly stage: StageKey;
  readonly type: 'medical' | 'care' | 'emotion';
  readonly title: string;
  readonly description: string;
  readonly choices: readonly ChoiceOption[];
  readonly chosenChoiceId?: string;
  readonly timestamp: string;
}

export interface ChoiceOption {
  readonly id: string;
  readonly text: string;
}

/** POST /api/v1/sessions/{sessionId}/choices — the core game-loop step. */
export interface SubmitChoiceRequest {
  readonly eventId: string;
  readonly choiceId: string;
}

/** Uniform error envelope returned by every non-2xx response. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** GDD phase that will implement this route. */
    readonly phase?: number;
    /** Route the request matched, echoed back for easier debugging. */
    readonly route?: string;
  };
}
