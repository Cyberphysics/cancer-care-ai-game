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

/**
 * The Medical Education role. `stage` is sent by the backend rather than left to
 * the model: measured 2026-10-16, a model-facing `stage` field gets filled with
 * prose.
 */
export interface QuestionRequest {
  readonly kind: 'question';
  readonly playerId: string;
  readonly sessionId: string;
  readonly stage: string;
  readonly question: string;
  readonly patient: unknown;
  readonly session: unknown;
  readonly health: unknown;
  readonly recentEvents: string;
}

/** The GameMaster extraction role: turn a stage's events into knowledge notes. */
export interface ExtractRequest {
  readonly kind: 'extract';
  readonly playerId: string;
  readonly sessionId: string;
  readonly stage: string;
  readonly stageEvents: string;
}

export type AgentRequest = NarrationRequest | QuestionRequest | ExtractRequest;

/** One source an answer cites. `source` is always present; `url` may not be. */
export interface Citation {
  readonly label: string;
  readonly title: string;
  readonly source: string;
  readonly url?: string | null;
}

/** Fields every agent response carries, success or failure. */
export interface AgentResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly generatedAt?: string;
  readonly error?: string;
  readonly errorType?: string;
}

export interface NarrationResult extends AgentResult {
  readonly kind?: string;
  readonly provider?: string;
  readonly modelId?: string;
  /** True when the guard rejected the model's output and a generic text was substituted. */
  readonly degraded?: boolean;
}

export interface AnswerResult extends AgentResult {
  readonly kind?: 'question';
  readonly citations?: readonly Citation[];
  /**
   * True only when the text is the guard's fallback. A real answer that simply
   * failed to cite anything is a different, visible state: `citations` is empty.
   */
  readonly degraded?: boolean;
  readonly provider?: string;
  readonly modelId?: string;
}

export interface ExtractResult extends AgentResult {
  readonly kind?: 'extract';
  readonly stage?: string;
  readonly stored?: number;
  /** The terms the agent noted, so the UI can show what it did rather than just a count. */
  readonly terms?: readonly string[];
  /** True when the stage had already been extracted, so nothing new was written. */
  readonly skipped?: boolean;
  readonly memoryConfigured?: boolean;
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

/**
 * Invoke whichever role the request's `kind` names.
 *
 * One client and one envelope for all three: the agent dispatches on `kind`
 * internally, so the transport does not need to know which role it is reaching.
 */
export async function invokeAgent<T extends AgentResult>(request: AgentRequest): Promise<T> {
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

  let parsed: T;
  try {
    parsed = JSON.parse(body) as T;
  } catch {
    throw new AgentUnavailableError(
      `Agent returned a non-JSON body: ${body.slice(0, 200)}`,
    );
  }

  return parsed;
}
