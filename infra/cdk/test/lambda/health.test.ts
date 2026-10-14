import {
  applyValidatedDelta,
  clampHealth,
  HealthValidationError,
  isWithinBounds,
} from '../../lambda/game-api/src/domain/health';
import type { Health } from '../../lambda/game-api/src/types';

const baseline: Health = { qualityOfLife: 50, energy: 50, stress: 50, nutrition: 50 };

describe('clampHealth — the rule-engine path', () => {
  // Choices are game mechanics: a player's decision must always resolve to some
  // outcome, so this path saturates rather than failing.
  test('applies an ordinary delta', () => {
    const next = clampHealth(baseline, { qualityOfLife: 10, stress: -20 });
    expect(next).toEqual({ qualityOfLife: 60, energy: 50, stress: 30, nutrition: 50 });
  });

  test('saturates at the upper bound instead of overflowing', () => {
    const next = clampHealth(baseline, { qualityOfLife: 90 });
    expect(next.qualityOfLife).toBe(100);
  });

  test('saturates at the lower bound instead of going negative', () => {
    const next = clampHealth(baseline, { qualityOfLife: -90, stress: -1000 });
    expect(next.qualityOfLife).toBe(0);
    expect(next.stress).toBe(0);
  });

  test('never throws, even on an extreme delta', () => {
    expect(() => clampHealth(baseline, { energy: Number.MAX_SAFE_INTEGER })).not.toThrow();
    expect(clampHealth(baseline, { energy: Number.MAX_SAFE_INTEGER }).energy).toBe(100);
  });

  test('leaves untouched dimensions alone', () => {
    const next = clampHealth(baseline, { nutrition: 5 });
    expect(next.qualityOfLife).toBe(50);
    expect(next.energy).toBe(50);
    expect(next.stress).toBe(50);
  });

  test('does not mutate its input', () => {
    const original = { ...baseline };
    clampHealth(original, { qualityOfLife: 25 });
    expect(original).toEqual(baseline);
  });

  test('an empty delta is a no-op', () => {
    expect(clampHealth(baseline, {})).toEqual(baseline);
  });
});

describe('applyValidatedDelta — the external-proposal path', () => {
  // Agent-proposed changes must be rejected, not silently saturated: a caller
  // that asked for 150 and silently got 100 would never learn its model of the
  // world was wrong.
  test('accepts an in-range change', () => {
    expect(applyValidatedDelta(baseline, { stress: -10 }).stress).toBe(40);
  });

  test('accepts landing exactly on a bound', () => {
    expect(applyValidatedDelta(baseline, { qualityOfLife: 50 }).qualityOfLife).toBe(100);
    expect(applyValidatedDelta(baseline, { qualityOfLife: -50 }).qualityOfLife).toBe(0);
  });

  test('rejects a value above the upper bound', () => {
    expect(() => applyValidatedDelta(baseline, { qualityOfLife: 51 })).toThrow(
      HealthValidationError,
    );
  });

  test('rejects a value below the lower bound', () => {
    expect(() => applyValidatedDelta(baseline, { stress: -51 })).toThrow(HealthValidationError);
  });

  test('names the offending dimension and value', () => {
    try {
      applyValidatedDelta(baseline, { nutrition: 999 });
      throw new Error('expected a HealthValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(HealthValidationError);
      expect((err as HealthValidationError).dimension).toBe('nutrition');
      expect((err as HealthValidationError).value).toBe(1049);
    }
  });

  test('rejects non-finite input', () => {
    expect(() => applyValidatedDelta(baseline, { energy: Number.NaN })).toThrow(
      HealthValidationError,
    );
    expect(() => applyValidatedDelta(baseline, { energy: Number.POSITIVE_INFINITY })).toThrow(
      HealthValidationError,
    );
  });
});

describe('isWithinBounds', () => {
  test('accepts values on the boundaries', () => {
    expect(isWithinBounds({ qualityOfLife: 0, energy: 100, stress: 0, nutrition: 100 })).toBe(true);
  });

  test('rejects anything outside', () => {
    expect(isWithinBounds({ ...baseline, stress: -1 })).toBe(false);
    expect(isWithinBounds({ ...baseline, stress: 101 })).toBe(false);
  });
});

describe('the two paths deliberately disagree', () => {
  test('the same out-of-range delta is clamped by one and rejected by the other', () => {
    const delta = { qualityOfLife: 80 };
    expect(clampHealth(baseline, delta).qualityOfLife).toBe(100);
    expect(() => applyValidatedDelta(baseline, delta)).toThrow(HealthValidationError);
  });
});
