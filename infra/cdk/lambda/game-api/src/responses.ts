import type { ApiErrorBody, ApiResponse } from './types';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Phase 3 replaces this with the CloudFront distribution domain. Left open
  // while the API has no authentication — see README "已知限制".
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

export function created(payload: unknown): ApiResponse {
  return json(201, payload);
}

function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): ApiResponse {
  const body: ApiErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return json(statusCode, body);
}

export function badRequest(message: string, details?: unknown): ApiResponse {
  return errorResponse(400, 'BAD_REQUEST', message, details);
}

export function notFound(message: string): ApiResponse {
  return errorResponse(404, 'NOT_FOUND', message);
}

/**
 * A write lost a race, or an idempotency guard rejected a repeat submission.
 *
 * The client's correct response is to re-read the current state and retry —
 * which is why this is a 409 and not a 500. See docs/DATA-MODEL.md §9.
 */
export function conflict(message: string, details?: unknown): ApiResponse {
  return errorResponse(409, 'CONFLICT', message, details);
}

export function serverError(err: unknown): ApiResponse {
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(500, 'INTERNAL_ERROR', message);
}
