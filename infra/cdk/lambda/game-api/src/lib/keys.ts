/**
 * DynamoDB key construction.
 *
 * Mirrors `infra/cdk/lib/naming.ts` on the CDK side. The two are duplicated
 * rather than shared because the CDK module pulls in `aws-cdk-lib`, which must
 * never end up in the Lambda bundle. `test/lambda/keys.test.ts` asserts the two
 * definitions stay in agreement, so drift fails the build rather than corrupting
 * data at runtime.
 */

export type EntityType =
  | 'Player'
  | 'GameSession'
  | 'PatientState'
  | 'EventHistory'
  | 'Narration';

/** Attribute names. Kept in sync with `DDB` in infra/cdk/lib/naming.ts. */
export const ATTR = {
  PK: 'PK',
  SK: 'SK',
  GSI1PK: 'GSI1PK',
  GSI1SK: 'GSI1SK',
  GSI1_NAME: 'PlayerSessionsIndex',
  TTL: 'expiresAt',
} as const;

export interface PrimaryKey {
  readonly PK: string;
  readonly SK: string;
}

/** Sparse GSI attributes. Only GameSession items carry these. */
export interface SparseIndexKey {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
}

export function playerKey(playerId: string): PrimaryKey {
  return { PK: `PLAYER#${playerId}`, SK: 'PROFILE' };
}

export function sessionKey(sessionId: string): PrimaryKey {
  return { PK: `SESSION#${sessionId}`, SK: 'META' };
}

export function patientKey(sessionId: string, patientId: string): PrimaryKey {
  return { PK: `SESSION#${sessionId}`, SK: `PATIENT#${patientId}` };
}

export function eventKey(sessionId: string, timestamp: string, eventId: string): PrimaryKey {
  return { PK: `SESSION#${sessionId}`, SK: `EVENT#${timestamp}#${eventId}` };
}

/**
 * Agent-generated narration for a session.
 *
 * Its own item rather than a field on the session, so that caching generated text
 * never contends with the optimistic lock the game uses for real state. A lost
 * cache write costs one regeneration; a lost game write would corrupt a
 * playthrough. Merging them would make the two indistinguishable.
 */
export function narrationKey(sessionId: string, kind: string): PrimaryKey {
  return { PK: `SESSION#${sessionId}`, SK: `NARRATION#${kind}` };
}

/**
 * The sparse GSI key for a session item.
 *
 * Sparse on purpose: Player and EventHistory items never call this, so they
 * never enter the index. DynamoDB rejects an empty string as a key attribute,
 * so a caller that wants "no index entry" must omit the attribute entirely —
 * not blank it. The item types below make that unrepresentable.
 */
export function sessionIndexKey(playerId: string, createdAt: string): SparseIndexKey {
  return { GSI1PK: `PLAYER#${playerId}`, GSI1SK: createdAt };
}

/**
 * Current time as a fixed-width ISO-8601 UTC string, e.g. `2026-10-15T12:34:56.789Z`.
 *
 * Always exactly 24 characters for years 0–9999, which is what makes
 * lexicographic ordering in an `EVENT#<timestamp>#<id>` sort key equal
 * chronological ordering. A local-time or variable-precision timestamp would
 * break event ordering *silently* — no error, just wrong order. Route every
 * timestamp through this function.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Epoch seconds, for the DynamoDB TTL attribute. */
export function ttlFromNow(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

/**
 * Drop `undefined` and `null` values.
 *
 * `DynamoDBDocumentClient` is also configured with `removeUndefinedValues`, but
 * stripping here keeps the objects we log and assert on identical to the ones we
 * write.
 */
export function omitUndefined<T extends object>(item: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  return result as T;
}
