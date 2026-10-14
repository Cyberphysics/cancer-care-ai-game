import { APP_NAME } from './config';

/**
 * Single source of truth for AWS resource names.
 *
 * Physical names for stateful resources (S3 buckets, the DynamoDB table) are
 * deliberately left to CloudFormation's generated names in `data-stack.ts` and
 * `frontend-stack.ts`. Hardcoding a bucket name makes destroy-then-redeploy
 * fail while the old global name is still held, and a table name is not worth
 * the coupling. CDK outputs the resolved names as stack outputs instead.
 *
 * What lives here is the naming for things that genuinely need a stable,
 * human-readable identifier.
 */

/** Kebab-case prefix for named resources. */
export function resourceName(suffix: string): string {
  return `${APP_NAME}-${suffix}`;
}

/** CloudFormation stack name, e.g. `CancercareGameMvp-Data`. */
export function stackName(prefix: string, component: string): string {
  return `${prefix}-${component}`;
}

/** DynamoDB attribute and index names (see docs/DATA-MODEL.md). */
export const DDB = {
  partitionKey: 'PK',
  sortKey: 'SK',
  /** Sparse GSI attributes — only GameSession items carry these. */
  gsi1PartitionKey: 'GSI1PK',
  gsi1SortKey: 'GSI1SK',
  gsi1Name: 'PlayerSessionsIndex',
  ttlAttribute: 'expiresAt',
} as const;

/** Logical tags applied to the DynamoDB table itself. */
export const TABLE_TAGS = {
  EntityTypes: 'Player,GameSession,PatientState,EventHistory',
} as const;
