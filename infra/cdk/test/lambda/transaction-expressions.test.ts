import { buildAdvanceUpdate } from '../../lambda/game-api/src/repo';

/**
 * Expression building is the part of the I/O layer most likely to be wrong and
 * hardest to see: it has no return value to inspect at runtime, and a mistake
 * shows up as data that quietly stays stale.
 *
 * It is exported and tested here precisely because the bug it was extracted for
 * — writing the *source* stage back instead of the destination — would otherwise
 * only surface as an endless loop in a live game.
 */

const base = {
  expectedSessionVersion: 3,
  nextStage: 'screening',
  nextStageIndex: 1,
  nextStageEventIndex: 0,
  awaitingAdvance: false,
  completed: false,
  now: '2026-10-15T12:00:00.000Z',
} as const;

describe('buildAdvanceUpdate', () => {
  test('writes the destination stage, never the stage being left', () => {
    const { values } = buildAdvanceUpdate({ ...base });

    expect(values[':stage']).toBe('screening');
    expect(values[':si']).toBe(1);
    expect(values[':sei']).toBe(0);
    // The regression: if these came from the session being replaced they would
    // read 'prevention' / 0 and the session would never leave stage one.
    expect(values[':stage']).not.toBe('prevention');
  });

  test('guards the write with the expected version', () => {
    const { expression, values } = buildAdvanceUpdate({ ...base });

    expect(expression).toContain('#version = #version + :one');
    expect(values[':sv']).toBe(3);
  });

  test('marks the session completed and stamps completedAt', () => {
    const { expression, values } = buildAdvanceUpdate({ ...base, completed: true });

    expect(values[':status']).toBe('completed');
    expect(values[':completedAt']).toBe(base.now);
    expect(expression).toContain('#completedAt = :completedAt');
  });

  test('keeps the session active while stages remain', () => {
    const { values } = buildAdvanceUpdate({ ...base });
    expect(values[':status']).toBe('active');
  });

  test('sets the active-event pointer when an event follows', () => {
    const { expression, names, values } = buildAdvanceUpdate({
      ...base,
      activeEventSk: 'EVENT#2026-10-15T12:00:00.000Z#evt_1',
    });

    expect(expression).toContain('#activeEventSk = :aes');
    expect(values[':aes']).toBe('EVENT#2026-10-15T12:00:00.000Z#evt_1');
    // The attribute name is aliased because `status` and friends are DynamoDB
    // reserved words — a collision is a runtime-only failure.
    expect(names['#activeEventSk']).toBe('activeEventSk');
  });

  test('removes the pointer entirely when no event follows', () => {
    const { expression, names } = buildAdvanceUpdate({ ...base });

    // A dangling pointer at an already-answered event would make the next
    // choice submission target the wrong thing.
    expect(expression).toContain('REMOVE activeEventSk');
    expect(expression).not.toContain('#activeEventSk = :aes');
    expect(names['#activeEventSk']).toBeUndefined();
  });

  test('aliases every mutated attribute name', () => {
    const { names } = buildAdvanceUpdate({ ...base, completed: true });

    for (const attribute of [
      'version',
      'currentStage',
      'stageIndex',
      'stageEventIndex',
      'awaitingAdvance',
      'status',
      'updatedAt',
      'completedAt',
    ]) {
      expect(Object.values(names)).toContain(attribute);
    }
  });

  test('emits no expression alias that is not bound', () => {
    const { expression, names } = buildAdvanceUpdate({ ...base });
    const used = expression.match(/#[A-Za-z]+/g) ?? [];

    for (const alias of used) {
      expect(names[alias]).toBeDefined();
    }
  });
});
