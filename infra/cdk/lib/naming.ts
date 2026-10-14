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

/**
 * Name for an AgentCore resource (Memory, Runtime, Gateway).
 *
 * The service enforces `^[a-zA-Z][a-zA-Z0-9_]{0,47}$` — **hyphens are rejected**
 * even though they are legal almost everywhere else in AWS. The project slug is
 * kebab-case, so it has to be transliterated here rather than reused directly.
 * Violations surface as a synthesis-time validation error, not at deploy.
 */
export function agentCoreName(suffix: string): string {
  return `${APP_NAME.replace(/-/g, '_')}_${suffix}`;
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

/**
 * Logical tags applied to the DynamoDB table itself.
 *
 * AWS tag values accept only letters, digits, whitespace and `_ . : / = + - @`.
 * Commas are rejected at deploy time with an opaque 400 from the DynamoDB
 * control plane, so the entity list is space-separated.
 */
export const TABLE_TAGS = {
  EntityTypes: 'Player GameSession PatientState EventHistory',
} as const;
