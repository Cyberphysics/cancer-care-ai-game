import {
  AlreadyAnsweredError,
  ChoiceNotFoundError,
  StageStateError,
} from './domain/engine';
import { HealthValidationError } from './domain/health';
import {
  handleAdvance,
  handleCreatePlayer,
  handleCreateSession,
  handleGetPlayer,
  handleGetSession,
  handleHealth,
  handleListEvents,
  handleNarration,
  handleSubmitChoice,
} from './handlers';
import {
  ConditionalCheckError,
  TransactionConflictError,
} from './repo';
import { badRequest, conflict, notFound, serverError } from './responses';
import type { ApiResponse, HttpApiEvent } from './types';

/**
 * Route table.
 *
 * Mirrors the routes declared on the HTTP API in `lib/api-stack.ts`. Dispatch
 * happens here rather than in the gateway so Phase 3 can reuse the same entry
 * points from the AgentCore Gateway tool surface.
 */
interface RouteDefinition {
  readonly method: string;
  /** Path template; `{name}` segments are captured into `pathParameters`. */
  readonly pattern: string;
  readonly handler: (event: HttpApiEvent) => Promise<ApiResponse>;
}

const ROUTES: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: '/api/v1/health',
    handler: () => handleHealth(),
  },
  { method: 'POST', pattern: '/api/v1/players', handler: handleCreatePlayer },
  { method: 'GET', pattern: '/api/v1/players/{playerId}', handler: handleGetPlayer },
  { method: 'POST', pattern: '/api/v1/sessions', handler: handleCreateSession },
  { method: 'GET', pattern: '/api/v1/sessions/{sessionId}', handler: handleGetSession },
  {
    method: 'GET',
    pattern: '/api/v1/sessions/{sessionId}/events',
    handler: handleListEvents,
  },
  {
    method: 'POST',
    pattern: '/api/v1/sessions/{sessionId}/choices',
    handler: handleSubmitChoice,
  },
  {
    method: 'POST',
    pattern: '/api/v1/sessions/{sessionId}/advance',
    handler: handleAdvance,
  },
  {
    // The AI layer. Deliberately a separate route from the game loop: the
    // playable path never depends on it.
    method: 'POST',
    pattern: '/api/v1/sessions/{sessionId}/narration',
    handler: handleNarration,
  },
];

interface MatchResult {
  readonly route: RouteDefinition;
  readonly params: Record<string, string>;
}

function match(method: string, path: string): MatchResult | undefined {
  const requestSegments = path.split('/').filter(Boolean);

  for (const route of ROUTES) {
    if (route.method !== method) continue;

    const patternSegments = route.pattern.split('/').filter(Boolean);
    if (patternSegments.length !== requestSegments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < patternSegments.length; i += 1) {
      const pattern = patternSegments[i];
      const actual = requestSegments[i];
      if (pattern.startsWith('{') && pattern.endsWith('}')) {
        params[pattern.slice(1, -1)] = decodeURIComponent(actual);
      } else if (pattern !== actual) {
        matched = false;
        break;
      }
    }

    if (matched) return { route, params };
  }

  return undefined;
}

/**
 * Map a domain failure to a status code.
 *
 * The distinction that matters: a **conflict** means the request was well-formed
 * but lost a race or repeated an action — the client should re-read and retry.
 * A **bad request** means the request itself was wrong and retrying unchanged
 * will fail again. Collapsing either into a 500 would tell the client nothing
 * useful and hide real bugs.
 */
function mapError(err: unknown): ApiResponse | undefined {
  if (err instanceof ChoiceNotFoundError) return badRequest(err.message);
  if (err instanceof HealthValidationError) return badRequest(err.message);

  if (err instanceof AlreadyAnsweredError) return conflict(err.message);
  if (err instanceof StageStateError) return conflict(err.message);
  if (err instanceof TransactionConflictError) {
    return conflict(err.message, err.reasons);
  }
  if (err instanceof ConditionalCheckError) return conflict(err.message, err.reason);

  return undefined;
}

export async function dispatch(event: HttpApiEvent): Promise<ApiResponse> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    const found = match(method, path);
    if (!found) {
      return notFound(`No route matches ${method} ${path}`);
    }

    const routed: HttpApiEvent = { ...event, pathParameters: found.params };
    return await found.route.handler(routed);
  } catch (err) {
    // A `TransactionCanceledException` reaches us as a client-caused conflict,
    // so it is mapped before the generic 500 fallback.
    return mapError(err) ?? serverError(err);
  }
}
