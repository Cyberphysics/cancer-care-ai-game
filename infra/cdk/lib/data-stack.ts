import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { AppConfig } from './config';
import { DDB, TABLE_TAGS } from './naming';

export interface DataStackProps extends cdk.StackProps {
  readonly config: AppConfig;
}

/**
 * Stateful layer: the single DynamoDB table holding all four game entities.
 *
 * Kept in its own stack so it is never touched by a frontend or API deploy. The
 * table is the authoritative store for game state (GDD §17 principle 4) —
 * AgentCore Memory is not a database.
 *
 * Access patterns and the full key schema are documented in docs/DATA-MODEL.md.
 */
export class DataStack extends cdk.Stack {
  /** Passed as a prop to the API stack so Lambda IAM grants stay scoped to this table. */
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.table = new dynamodb.Table(this, 'GameTable', {
      partitionKey: { name: DDB.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: DDB.sortKey, type: dynamodb.AttributeType.STRING },

      // On-demand: demo traffic is spiky and unpredictable; there is nothing to
      // provision and nothing to forget to scale down.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: config.pointInTimeRecovery,
      },

      // Wired now, unused in Phase 0. Lets demo sessions expire on their own
      // once Phase 2 starts writing a timestamp here.
      timeToLiveAttribute: DDB.ttlAttribute,

      // DESTROY in dev, RETAIN in prod (see config.ts).
      removalPolicy: config.removalPolicy,
      deletionProtection: config.stage === 'prod',
    });

    // GSIs are added imperatively: `TableProps` has no `globalSecondaryIndexes`
    // property, and passing one is silently ignored — it synthesizes an
    // `undefined` GlobalSecondaryIndexes and creates no index at all.
    this.table.addGlobalSecondaryIndex({
      // Sparse: only GameSession items carry GSI1PK/GSI1SK, so Player and
      // EventHistory items never enter this index. Backs "list this player's
      // sessions" without a Scan.
      indexName: DDB.gsi1Name,
      partitionKey: { name: DDB.gsi1PartitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: DDB.gsi1SortKey, type: dynamodb.AttributeType.STRING },
      // ALL: the lookup returns the whole session item, so no fetch-back.
      projectionType: dynamodb.ProjectionType.ALL,
    });

    cdk.Tags.of(this.table).add('EntityTypes', TABLE_TAGS.EntityTypes);

    new cdk.CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: 'DynamoDB single table holding all game entities',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: this.table.tableArn,
      description: 'ARN of the game state table',
    });
  }
}
