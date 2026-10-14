import { randomUUID } from 'node:crypto';

/**
 * Identifier generation.
 *
 * `randomUUID` is cryptographically random and available in the Node 22 Lambda
 * runtime, so no dependency is needed. The dashes are stripped and the value
 * truncated to keep keys short and easy to read in the DynamoDB console during
 * a demo.
 *
 * Not sortable — ordering comes from the `createdAt` / event timestamp, never
 * from the id. If sortable ids are ever needed, switch to ULID deliberately.
 */
export function newId(prefix: string): string {
  const compact = randomUUID().replace(/-/g, '').slice(0, 20);
  return `${prefix}_${compact}`;
}

export const newPlayerId = (): string => newId('plr');
export const newSessionId = (): string => newId('ses');
export const newPatientId = (): string => newId('pat');
export const newEventId = (): string => newId('evt');
