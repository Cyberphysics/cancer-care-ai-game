import type {
  AdvanceResponse,
  EventListResponse,
  HealthResponse,
  NarrationKind,
  NarrationResponse,
  PlayerResponse,
  SessionResponse,
  SubmitChoiceResponse,
} from './types';

/**
 * Game API client.
 *
 * Uses a **relative** base path on purpose. In production CloudFront proxies
 * `/api/*` to API Gateway (see `infra/cdk/lib/frontend-stack.ts`), and in local
 * development the Vite dev server proxies the same prefix (see `vite.config.ts`).
 * One relative path therefore works in both, with no API URL baked into the
 * build, no build-order dependency, and no CORS preflight.
 */
const API_BASE = '/api/v1';

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(response.status, 'INVALID_RESPONSE', `Response was not JSON: ${text.slice(0, 120)}`);
  }

  if (!response.ok) {
    const body = parsed as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }

  return parsed as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>('/health', { signal });
}

export function createPlayer(nickname: string): Promise<PlayerResponse> {
  return post<PlayerResponse>('/players', { nickname });
}

/**
 * Start a session. The backend picks a synthetic case deterministically when no
 * template id is given, which is why this takes only the player.
 */
export function createSession(playerId: string): Promise<SessionResponse> {
  return post<SessionResponse>('/sessions', { playerId });
}

export function getSession(sessionId: string): Promise<SessionResponse> {
  return request<SessionResponse>(`/sessions/${sessionId}`);
}

export function listEvents(sessionId: string): Promise<EventListResponse> {
  return request<EventListResponse>(`/sessions/${sessionId}/events`);
}

/**
 * The core game-loop step. Returns the resolved impact, the rationale behind it
 * and the next event, so a caller never needs a follow-up read to advance the UI.
 *
 * A repeat of the same choice is rejected with 409 (idempotency guard), and an
 * event that has already been answered with 409 as well.
 */
export function submitChoice(
  sessionId: string,
  eventId: string,
  choiceId: string,
): Promise<SubmitChoiceResponse> {
  return post<SubmitChoiceResponse>(`/sessions/${sessionId}/choices`, { eventId, choiceId });
}

/** Move to the next stage. Rejected with 409 while the current stage has unanswered events. */
export function advanceStage(sessionId: string): Promise<AdvanceResponse> {
  return post<AdvanceResponse>(`/sessions/${sessionId}/advance`);
}

/**
 * Agent narration. The first call for a given `(sessionId, kind)` pays the
 * runtime cold start plus model latency (measured at ~10s); later calls return
 * the cached text immediately.
 *
 * Note the cache is keyed by session **and kind**, not by event — so `choice`
 * narration reflects the first answered event of the session, not the latest
 * one. The UI surfaces the `cached` flag rather than presenting stale text as new.
 */
export function getNarration(sessionId: string, kind: NarrationKind): Promise<NarrationResponse> {
  return post<NarrationResponse>(`/sessions/${sessionId}/narration`, { kind });
}
