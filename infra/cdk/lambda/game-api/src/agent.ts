import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

/**
 * Client for the GameMaster agent running on AgentCore Runtime.
 *
 * The agent is invoked **synchronously** and its result is cached on the session
 * item, so only the first request for a given narration pays the model latency
 * and the runtime's cold start.
 *
 * Latency budget — the binding constraint is API Gateway, not Lambda:
 *
 *   CloudFront origin response timeout         30 s (raisable to 120 s)
 *   API Gateway HTTP API integration timeout   30 s (hard cap, not raisable)
 *   this Lambda's timeout                      29 s (kept just under)
 *   the agent's own provider call              20 s (kept under both)
 *
 * The inner bounds are what buy a clean error: the provider timeout fires while
 * this Lambda is still alive, so a slow model surfaces as an actionable
 * "provider timed out" rather than an opaque gateway 504. Bounding this Lambda
 * below the gateway does not do that — a Lambda that hits its own timeout is
 * killed and the caller still sees the gateway's 504; it only makes that case
 * less likely.
 */

const client = new BedrockAgentCoreClient({});

export interface NarrationRequest {
  readonly kind: 'choice' | 'summary';
  readonly playerId: string;
  readonly sessionId: string;
  readonly patient: unknown;
  readonly session: unknown;
  readonly health: unknown;
  readonly events: unknown;
  readonly focusEvent?: unknown;
}

export interface NarrationResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly kind?: string;
  readonly provider?: string;
  readonly modelId?: string;
  /** True when the guard rejected the model's output and a generic text was substituted. */
  readonly degraded?: boolean;
  readonly generatedAt?: string;
  readonly error?: string;
  readonly errorType?: string;
}

export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentUnavailableError';
  }
}

function runtimeArn(): string {
  const arn = process.env.AGENT_RUNTIME_ARN;
  if (!arn) {
    throw new AgentUnavailableError('AGENT_RUNTIME_ARN is not configured on this function');
  }
  return arn;
}

export async function invokeGameMaster(request: NarrationRequest): Promise<NarrationResult> {
  let response;
  try {
    response = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn(),
        // Propagates the player identity to the agent so Memory is scoped to the
        // right actor without the client passing it in the payload.
        runtimeUserId: request.playerId,
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(JSON.stringify(request), 'utf-8'),
      }),
    );
  } catch (err) {
    // Anything that stops the call from succeeding — a missing permission, a
    // deleted runtime, throttling — is the same thing from the game's point of
    // view: the narrative layer is unavailable and play continues without it.
    // Reported as a 502 like every other agent-side failure; letting the raw SDK
    // error escape would surface it as a 500 and misrepresent a survivable
    // condition as a backend fault.
    throw new AgentUnavailableError(
      `InvokeAgentRuntime failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.response) {
    throw new AgentUnavailableError('Agent runtime returned an empty response body');
  }

  const body = await response.response.transformToString();

  let parsed: NarrationResult;
  try {
    parsed = JSON.parse(body) as NarrationResult;
  } catch {
    throw new AgentUnavailableError(
      `Agent returned a non-JSON body: ${body.slice(0, 200)}`,
    );
  }

  return parsed;
}
