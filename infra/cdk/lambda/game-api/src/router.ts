import { notFound, notImplemented, ok, serverError } from './responses';
import type { ApiResponse, HttpApiEvent } from './types';

/**
 * Route table.
 *
 * This mirrors the routes declared on the HTTP API in `lib/api-stack.ts`. The
 * Lambda re-dispatches rather than trusting the gateway because the integration
 * is a plain proxy — and because Phase 3 will invoke this same dispatch path
 * from the AgentCore Gateway tool surface.
 *
 * Every route except `/health` is intentionally a 501 stub. Phase 0 ships the
 * contract and the wiring, not the game.
 */
interface RouteDefinition {
  readonly method: string;
  /** Path template; `{name}` segments are captured into `params`. */
  readonly pattern: string;
  readonly phase: number;
  readonly summary: string;
}

const ROUTES: readonly RouteDefinition[] = [
  { method: 'GET', pattern: '/api/v1/health', phase: 0, summary: 'Liveness check' },
  { method: 'POST', pattern: '/api/v1/players', phase: 2, summary: '创建玩家（家庭健康守护者）' },
  { method: 'GET', pattern: '/api/v1/players/{playerId}', phase: 2, summary: '读取玩家档案' },
  { method: 'POST', pattern: '/api/v1/sessions', phase: 2, summary: '创建患者并开始游戏' },
  { method: 'GET', pattern: '/api/v1/sessions/{sessionId}', phase: 2, summary: '读取会话与患者状态' },
  {
    method: 'GET',
    pattern: '/api/v1/sessions/{sessionId}/events',
    phase: 2,
    summary: '事件时间线',
  },
  {
    method: 'POST',
    pattern: '/api/v1/sessions/{sessionId}/choices',
    phase: 2,
    summary: '提交玩家选择（核心游戏循环）',
  },
  {
    method: 'POST',
    pattern: '/api/v1/sessions/{sessionId}/advance',
    phase: 3,
    summary: '推进阶段（Phase 3 由 AgentCore GameMaster 驱动）',
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

function health(): ApiResponse {
  return ok({
    status: 'ok',
    phase: 0,
    description: 'Phase 0 骨架 — 路由与基础设施已就绪，游戏逻辑尚未实现',
    stage: process.env.STAGE ?? 'unknown',
    region: process.env.AWS_REGION ?? 'unknown',
    tableName: process.env.TABLE_NAME ?? 'unset',
    timestamp: new Date().toISOString(),
  });
}

export async function dispatch(event: HttpApiEvent): Promise<ApiResponse> {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const found = match(method, path);

    if (!found) {
      return notFound(`No route matches ${method} ${path}`);
    }

    const { route } = found;

    if (route.pattern === '/api/v1/health') {
      return health();
    }

    return notImplemented(
      `${route.method} ${route.pattern}`,
      route.phase,
      `${route.summary} — 计划在 Phase ${route.phase} 实现`,
    );
  } catch (err) {
    return serverError(err);
  }
}
