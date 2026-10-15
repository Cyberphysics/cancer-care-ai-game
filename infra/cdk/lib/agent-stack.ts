import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { AppConfig } from './config';
import { agentCoreName, resourceName } from './naming';

export interface AgentStackProps extends cdk.StackProps {
  readonly config: AppConfig;
  /** SSM Parameter name holding the DeepSeek API key (SecureString). */
  readonly apiKeyParameterName: string;
}

/**
 * The AI layer: AgentCore Runtime running the GameMaster agent, plus the Memory
 * resource holding long-term player preferences.
 *
 * **The security invariant of this whole project lives in this file.** The
 * agent's execution role is granted SSM, KMS, Memory and Bedrock permissions —
 * and deliberately **no DynamoDB permissions at all**. The agent can only affect
 * game state by calling a tool, and a tool is where validation happens. Granting
 * the runtime `dynamodb:*` "just to read state" would collapse that boundary
 * silently; `test/agent-stack.test.ts` asserts the absence.
 *
 * See docs/ARCHITECTURE.md §5.6.
 */
export class AgentStack extends cdk.Stack {
  public readonly runtime: agentcore.Runtime;
  public readonly memory: agentcore.Memory;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const { config, apiKeyParameterName } = props;

    // AgentCore enforces `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`, hence the
    // transliteration. The runtime's log group is named after it, so the IAM
    // scope below is derived from the same value.
    const runtimeName = agentCoreName('game_master');

    /* ---------------------------------------------------------------- *
     * Long-term memory
     * ---------------------------------------------------------------- */

    this.memory = new agentcore.Memory(this, 'PlayerMemory', {
      memoryName: agentCoreName('player_memory'),
      description:
        'Long-term player preferences for CancerCare AI Game. Holds soft personalisation ' +
        'signals only — the game state itself lives in DynamoDB.',
      /**
       * Custom namespaces rather than the built-in defaults.
       *
       * The built-in layout is `/strategies/{memoryStrategyId}/actors/{actorId}`.
       * `{memoryStrategyId}` is only resolvable by the service at write time, so
       * a reader cannot reconstruct the path — retrieval takes a literal
       * namespace, and the caller has no way to know the strategy id.
       *
       * `/players/{actorId}` keeps the actor scoping (which is what we actually
       * need) and drops the part we cannot address. `{actorId}` is substituted
       * by the service, same as in the default template.
       */
      memoryStrategies: [
        agentcore.MemoryStrategy.usingUserPreference({
          strategyName: 'player_preferences',
          namespaces: ['/players/{actorId}'],
        }),
        agentcore.MemoryStrategy.usingSemantic({
          strategyName: 'player_facts',
          namespaces: ['/players/{actorId}'],
        }),
      ],
      // Memory records outlive a demo session on purpose; preferences are the
      // one thing that should survive.
      expirationDuration: cdk.Duration.days(config.stage === 'prod' ? 365 : 30),
    });

    /* ---------------------------------------------------------------- *
     * Execution role
     * ---------------------------------------------------------------- */

    const role = new iam.Role(this, 'GameMasterExecutionRole', {
      roleName: resourceName('game-master-runtime-role'),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the GameMaster agent runtime',
    });

    // Read the DeepSeek key at runtime rather than injecting it as an
    // environment variable: env vars on a runtime version are readable by
    // anyone with control-plane read access and appear in the console.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadDeepSeekKey',
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Arn.format(
            {
              service: 'ssm',
              resource: 'parameter',
              resourceName: apiKeyParameterName.replace(/^\//, ''),
            },
            this,
          ),
        ],
      }),
    );

    // A SecureString encrypted with the AWS-managed SSM key still needs decrypt.
    kms.Alias.fromAliasName(this, 'SsmDefaultKey', 'alias/aws/ssm').grantDecrypt(role);

    // Memory data plane only. Note there is no `grant*` call that would reach
    // DynamoDB — Memory is a separate service.
    this.memory.grantRead(role);
    this.memory.grantWrite(role);

    // Optional path: Bedrock-hosted models. The account is currently blocked by
    // allowlisting so the deepseek provider is used, but the permission is
    // granted so switching providers is a config change, not a policy change.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeBedrockModels',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }),
    );

    // The service sets a resource policy on the runtime's own log group while
    // creating it, which needs `logs:PutResourcePolicy`. The L2 construct does
    // not grant it, and its absence surfaces only as an AccessDenied in
    // CloudTrail during deploy — not as a template error. Scope follows the
    // documented pattern: log-group:/aws/bedrock-agentcore/runtimes/<agentName>-*
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ManageRuntimeLogGroup',
        actions: ['logs:PutResourcePolicy'],
        resources: [
          cdk.Arn.format(
            {
              service: 'logs',
              resource: 'log-group',
              resourceName: `/aws/bedrock-agentcore/runtimes/${runtimeName}-*`,
              // Log group names start with a slash, so the ARN separator has to
              // be a colon — the default slash form renders `log-group//aws/...`.
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            },
            this,
          ),
        ],
      }),
    );

    /* ---------------------------------------------------------------- *
     * Runtime
     * ---------------------------------------------------------------- */

    this.runtime = new agentcore.Runtime(this, 'GameMasterRuntime', {
      runtimeName,
      description: 'GameMaster agent — narrative layer for CancerCare AI Game',
      executionRole: role,

      // The zip produced by agents/game-master/build.sh. It MUST exist before
      // `cdk synth`, the same ordering constraint as the frontend's dist/.
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: path.join(__dirname, '..', '..', '..', 'agents', 'game-master', 'dist', 'game-master.zip'),
        runtime: agentcore.AgentCoreRuntime.PYTHON_3_13,
        entrypoint: ['main.py'],
      }),

      // Public egress: the agent calls api.deepseek.com. A VPC runtime would
      // need private subnets plus a NAT gateway for the same reach.
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),

      // IAM auth rather than the default JWT — no Cognito user pool to create,
      // and the caller is a Lambda in the same account.
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingIAM(),

      // Trace delivery lands in CloudWatch Logs, which only works when the
      // account's X-Ray trace segment destination has been switched to
      // CloudWatchLogs. That switch is account-wide and would move every other
      // project's traces as well, so it is gated behind config.agentTracing
      // (default off) rather than assumed. See the AppConfig comment.
      tracingEnabled: config.agentTracing,

      environmentVariables: {
        MODEL_PROVIDER: 'deepseek',
        MODEL_ID: 'deepseek-chat',
        API_KEY_PARAMETER: apiKeyParameterName,
        MEMORY_ID: this.memory.memoryId,
        MAX_TOKENS: '900',
        TEMPERATURE: '0.7',
      },
    });

    /* ---------------------------------------------------------------- *
     * Outputs
     * ---------------------------------------------------------------- */

    new cdk.CfnOutput(this, 'RuntimeArn', {
      value: this.runtime.agentRuntimeArn,
      description: 'ARN of the GameMaster agent runtime',
    });

    new cdk.CfnOutput(this, 'RuntimeId', {
      value: this.runtime.agentRuntimeId,
      description: 'ID of the GameMaster agent runtime',
    });

    new cdk.CfnOutput(this, 'MemoryId', {
      value: this.memory.memoryId,
      description: 'AgentCore Memory resource id holding player preferences',
    });
  }
}
