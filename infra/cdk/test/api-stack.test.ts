import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/api-stack';
import { DataStack } from '../lib/data-stack';
import { testConfig, testEnv } from './helpers';

function buildTemplate(): Template {
  const app = new cdk.App();
  const env = testEnv();
  const config = testConfig();
  const data = new DataStack(app, 'TestDataStack', { env, config });
  return Template.fromStack(new ApiStack(app, 'TestApiStack', { env, config, table: data.table }));
}

describe('ApiStack', () => {
  const template = buildTemplate();

  test('runs a single Graviton Lambda on the Node 22 runtime', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
    });
  });

  test('exposes all eight game-loop routes on an HTTP API', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 8);

    for (const route of [
      'GET /api/v1/health',
      'POST /api/v1/players',
      'GET /api/v1/players/{playerId}',
      'POST /api/v1/sessions',
      'GET /api/v1/sessions/{sessionId}',
      'GET /api/v1/sessions/{sessionId}/events',
      'POST /api/v1/sessions/{sessionId}/choices',
      'POST /api/v1/sessions/{sessionId}/advance',
    ]) {
      const [method, path] = route.split(' ');
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: `${method} ${path}`,
      });
    }
  });

  test('passes the table name to the function at runtime', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const [{ Properties }] = Object.values(functions);
    expect(Properties.Environment.Variables.TABLE_NAME).toBeDefined();
    expect(Properties.Environment.Variables.STAGE).toBe('dev');
  });

  test('grants DynamoDB access scoped to the table, never a wildcard resource', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement ?? [],
    );

    const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

    const dynamoStatements = statements.filter((s: { Action?: unknown }) =>
      asArray(s.Action).some((a) => String(a).startsWith('dynamodb:')),
    );
    expect(dynamoStatements.length).toBeGreaterThan(0);

    for (const statement of dynamoStatements) {
      expect(asArray(statement.Resource)).not.toContain('*');
    }
  });
});
