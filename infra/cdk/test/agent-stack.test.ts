import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentStack } from '../lib/agent-stack';
import { AppConfig } from '../lib/config';
import { testConfig, testEnv } from './helpers';

// NOTE: the stack reads `agents/game-master/dist/game-master.zip` via
// `fromCodeAsset`, which CDK validates at synth time. Run
// `./agents/game-master/build.sh` before `npm test`.
function buildTemplate(overrides: Partial<AppConfig> = {}): Template {
  const app = new cdk.App();
  return Template.fromStack(
    new AgentStack(app, 'TestAgentStack', {
      env: testEnv(),
      config: testConfig(overrides),
      apiKeyParameterName: '/cancercare-game-mvp/deepseek-api-key',
    }),
  );
}

describe('AgentStack', () => {
  const template = buildTemplate();

  test('creates exactly one runtime and one memory resource', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
  });

  test('uses IAM auth rather than the default Cognito authorizer', () => {
    // IAM is what `usingIAM()` resolves to, and it renders as *no* explicit
    // AuthorizerConfiguration at all — so the honest assertion is the absence of
    // a user pool, not the presence of an "IAM" string.
    template.resourceCountIs('AWS::Cognito::UserPool', 0);

    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const [runtime] = Object.values(runtimes);
    expect(JSON.stringify(runtime.Properties.AuthorizerConfiguration ?? {})).not.toContain(
      'Cognito',
    );
  });

  test('runs with public network access so the agent can reach the model API', () => {
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const [runtime] = Object.values(runtimes);
    expect(JSON.stringify(runtime.Properties.NetworkConfiguration)).toContain('PUBLIC');
  });

  test('does not deliver traces to CloudWatch Logs by default', () => {
    // Trace delivery is rejected at deploy time with `InvalidRequest` unless the
    // *account's* X-Ray trace segment destination is already CloudWatchLogs, and
    // that setting is account-wide. Leaving this on would fail the whole stack
    // for a feature nobody asked for, so the default is off.
    template.resourceCountIs('AWS::Logs::Delivery', 0);
    template.resourceCountIs('AWS::Logs::DeliverySource', 0);
  });

  test('wires up trace delivery when explicitly enabled', () => {
    // The flag is not dead code: with it on, the delivery resources appear.
    // They are what fails without the account-level setting — see config.ts.
    const traced = buildTemplate({ agentTracing: true });
    traced.resourceCountIs('AWS::Logs::Delivery', 1);
    traced.resourceCountIs('AWS::Logs::DeliverySource', 1);
  });

  test('names satisfy the AgentCore charset — no hyphens', () => {
    // The service enforces ^[a-zA-Z][a-zA-Z0-9_]{0,47}$. The project slug is
    // kebab-case, so this catches a future rename that drops the transliteration.
    const names = [
      ...Object.values(template.findResources('AWS::BedrockAgentCore::Runtime')).map(
        (r) => r.Properties.AgentRuntimeName,
      ),
      ...Object.values(template.findResources('AWS::BedrockAgentCore::Memory')).map(
        (m) => m.Properties.Name,
      ),
    ];
    expect(names.length).toBe(2);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    }
  });

  test('configures both memory strategies with an actor-scoped namespace', () => {
    const memories = template.findResources('AWS::BedrockAgentCore::Memory');
    const [memory] = Object.values(memories);
    const strategies: Record<string, { Namespaces?: string[] }>[] =
      memory.Properties.MemoryStrategies ?? [];

    expect(strategies).toHaveLength(2);
    // Each strategy is rendered as a single-key object naming the strategy type.
    const kinds = strategies.flatMap((s) => Object.keys(s)).sort();
    expect(kinds).toEqual(['SemanticMemoryStrategy', 'UserPreferenceMemoryStrategy']);

    // The namespace must stay actor-scoped, and must not use the built-in
    // template: `{memoryStrategyId}` is only resolvable by the service, so a
    // reader could not reconstruct the path to retrieve from.
    for (const strategy of strategies) {
      for (const config of Object.values(strategy)) {
        expect(config.Namespaces).toEqual(['/players/{actorId}']);
      }
    }
  });

  describe('the execution role', () => {
    function roleStatements(): { Action: string | string[]; Resource?: unknown }[] {
      // The role's permissions live in the auto-created default policy.
      const policies = template.findResources('AWS::IAM::Policy');
      const forRole = Object.values(policies).filter((policy) =>
        JSON.stringify(policy.Properties.Roles ?? []).includes('GameMasterExecutionRole'),
      );
      return forRole.flatMap((policy) => policy.Properties.PolicyDocument.Statement ?? []);
    }

    test('grants SSM read for the API key', () => {
      const statements = roleStatements();
      const ssm = statements.filter((s) => JSON.stringify(s.Action).includes('ssm:GetParameter'));
      expect(ssm.length).toBeGreaterThan(0);
      // Scoped to the one parameter, not `*`.
      expect(JSON.stringify(ssm[0].Resource)).toContain('deepseek-api-key');
    });

    test('grants memory access for long-term preferences', () => {
      const statements = roleStatements();
      const memory = statements.filter((s) =>
        JSON.stringify(s.Action).includes('bedrock-agentcore:RetrieveMemoryRecords'),
      );
      expect(memory.length).toBeGreaterThan(0);
    });

    test('⛔ holds NO DynamoDB permissions — the project’s core invariant', () => {
      // The agent must not be able to reach game state directly. It can only
      // affect state by calling a tool, and tools are where validation happens.
      // Granting this role dynamodb:* "just to read state" would silently
      // collapse that boundary, and nothing else in the system would notice.
      const actions = roleStatements().flatMap((s) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
      const dynamo = actions.filter((action) => String(action).startsWith('dynamodb:'));

      expect(dynamo).toEqual([]);
    });

    test('⛔ is not granted InvokeAgentRuntimeCommand', () => {
      // That action runs a shell inside the runtime microVM as root and can read
      // the execution role's credentials. It is in the AWS managed
      // BedrockAgentCoreFullAccess policy; it must not be here.
      const actions = roleStatements().flatMap((s) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
      expect(actions.map(String)).not.toContain('bedrock-agentcore:InvokeAgentRuntimeCommand');
    });
  });
});
