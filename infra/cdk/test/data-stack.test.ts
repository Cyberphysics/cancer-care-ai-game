import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { DDB } from '../lib/naming';
import { testConfig, testEnv } from './helpers';

function buildStack(): DataStack {
  const app = new cdk.App();
  return new DataStack(app, 'TestDataStack', { env: testEnv(), config: testConfig() });
}

describe('DataStack', () => {
  const template = Template.fromStack(buildStack());

  test('creates exactly one DynamoDB table', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  test('uses a composite PK/SK and on-demand billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: DDB.partitionKey, KeyType: 'HASH' },
        { AttributeName: DDB.sortKey, KeyType: 'RANGE' },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: DDB.partitionKey, AttributeType: 'S' },
        { AttributeName: DDB.sortKey, AttributeType: 'S' },
      ]),
    });
  });

  test('declares exactly one GSI, projecting ALL, keyed on the sparse GSI attributes', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: DDB.gsi1Name,
          KeySchema: [
            { AttributeName: DDB.gsi1PartitionKey, KeyType: 'HASH' },
            { AttributeName: DDB.gsi1SortKey, KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });

    const tables = template.findResources('AWS::DynamoDB::Table');
    const gsis = Object.values(tables)[0].Properties.GlobalSecondaryIndexes ?? [];
    expect(gsis).toHaveLength(1);
  });

  test('wires a TTL attribute for session expiry', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: DDB.ttlAttribute,
        Enabled: true,
      },
    });
  });

  test('enables point-in-time recovery', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test('is destroyable in the dev stage', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });
});
