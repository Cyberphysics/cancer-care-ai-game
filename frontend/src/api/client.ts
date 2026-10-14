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

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>('/health', { signal });
}
