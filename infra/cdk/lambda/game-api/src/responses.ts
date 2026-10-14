import type { ApiErrorBody, ApiResponse } from './types';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Phase 2 replaces this with the CloudFront distribution domain.
  'access-control-allow-origin': '*',
} as const;

export function json(statusCode: number, payload: unknown): ApiResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(payload, null, 2),
  };
}

export function ok(payload: unknown): ApiResponse {
  return json(200, payload);
}

export function notFound(message: string): ApiResponse {
  const body: ApiErrorBody = { error: { code: 'NOT_FOUND', message } };
  return json(404, body);
}

/**
 * Standard response for a route that is defined but not implemented yet.
 *
 * Returning 501 rather than fabricated 200 data is deliberate: a stub can never
 * be mistaken for a working feature during a demo, and the smoke test can assert
 * on it.
 */
export function notImplemented(route: string, phase: number, message: string): ApiResponse {
  const body: ApiErrorBody = {
    error: { code: 'NOT_IMPLEMENTED', message, phase, route },
  };
  return json(501, body);
}

export function serverError(err: unknown): ApiResponse {
  const message = err instanceof Error ? err.message : String(err);
  const body: ApiErrorBody = { error: { code: 'INTERNAL_ERROR', message } };
  return json(500, body);
}
