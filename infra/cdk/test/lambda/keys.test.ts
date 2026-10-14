import { DDB } from '../../lib/naming';
import {
  ATTR,
  eventKey,
  nowIso,
  omitUndefined,
  patientKey,
  playerKey,
  sessionIndexKey,
  sessionKey,
  ttlFromNow,
} from '../../lambda/game-api/src/lib/keys';

describe('key attribute names', () => {
  // The lambda keeps its own copy of these names because importing the CDK
  // module would drag `aws-cdk-lib` into the function bundle. This test is the
  // anti-drift mechanism: if either side is renamed without the other, the
  // build fails here rather than corrupting writes at runtime.
  test('stay in agreement with infra/cdk/lib/naming.ts', () => {
    expect(ATTR.PK).toBe(DDB.partitionKey);
    expect(ATTR.SK).toBe(DDB.sortKey);
    expect(ATTR.GSI1PK).toBe(DDB.gsi1PartitionKey);
    expect(ATTR.GSI1SK).toBe(DDB.gsi1SortKey);
    expect(ATTR.GSI1_NAME).toBe(DDB.gsi1Name);
    expect(ATTR.TTL).toBe(DDB.ttlAttribute);
  });
});

describe('key builders', () => {
  test('players live in their own partition with no sparse index keys', () => {
    const key = playerKey('p-1');
    expect(key).toEqual({ PK: 'PLAYER#p-1', SK: 'PROFILE' });
    // A player that entered the sparse index would make the index grow with
    // every player for no benefit.
    expect(Object.keys(key)).not.toContain('GSI1PK');
    expect(Object.keys(key)).not.toContain('GSI1SK');
  });

  test('session, patient and event share one partition so the play screen is one Query', () => {
    expect(sessionKey('s-1').PK).toBe('SESSION#s-1');
    expect(patientKey('s-1', 'pat-1').PK).toBe('SESSION#s-1');
    expect(eventKey('s-1', '2026-10-15T00:00:00.000Z', 'e-1').PK).toBe('SESSION#s-1');
  });

  test('only the session carries the sparse index keys', () => {
    const index = sessionIndexKey('p-1', '2026-10-15T00:00:00.000Z');
    expect(index).toEqual({
      GSI1PK: 'PLAYER#p-1',
      GSI1SK: '2026-10-15T00:00:00.000Z',
    });
  });

  test('event sort keys sort chronologically as strings', () => {
    const early = eventKey('s-1', '2026-10-15T09:00:00.000Z', 'e-1').SK;
    const late = eventKey('s-1', '2026-10-15T13:30:00.000Z', 'e-2').SK;
    expect(early < late).toBe(true);
  });
});

describe('nowIso', () => {
  test('produces a fixed-width UTC timestamp', () => {
    const value = nowIso();
    // Exactly 24 characters is what makes lexicographic order equal
    // chronological order in an EVENT#<ts>#<id> sort key. A local-time or
    // variable-precision timestamp would silently reorder events.
    expect(value).toHaveLength(24);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('is always the same width regardless of the moment', () => {
    const widths = new Set(
      [0, 1, 9, 10, 11, 23, 59, 100, 999].map((ms) =>
        new Date(Date.UTC(2026, 0, 2, 3, 4, 5, ms)).toISOString().length,
      ),
    );
    expect(widths).toEqual(new Set([24]));
  });

  test('round-trips through Date', () => {
    // Capture once: two `nowIso()` calls can straddle a millisecond and make
    // this assertion flaky for no real reason.
    const value = nowIso();
    expect(new Date(value).toISOString()).toBe(value);
  });
});

describe('ttlFromNow', () => {
  test('returns epoch seconds in the future', () => {
    const ttl = ttlFromNow(7);
    expect(ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(ttl).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 7 * 24 * 3600 + 1);
  });
});

describe('omitUndefined', () => {
  test('drops undefined and null but keeps other falsy values', () => {
    const result = omitUndefined({
      keep: 'value',
      zero: 0,
      empty: '',
      no: false,
      gone: undefined,
      alsoGone: null,
    });
    expect(result).toEqual({ keep: 'value', zero: 0, empty: '', no: false });
  });

  test('removes an absent sparse index key entirely rather than blanking it', () => {
    // DynamoDB rejects an empty string as a key attribute, so "set it to ''"
    // is not an alternative to omitting it.
    const item = omitUndefined({
      PK: 'PLAYER#p-1',
      SK: 'PROFILE',
      GSI1PK: undefined as string | undefined,
      GSI1SK: undefined as string | undefined,
    });
    expect('GSI1PK' in item).toBe(false);
    expect('GSI1SK' in item).toBe(false);
  });
});
