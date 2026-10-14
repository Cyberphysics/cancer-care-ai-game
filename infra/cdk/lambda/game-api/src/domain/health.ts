import { HEALTH_DIMENSIONS, type Health, type HealthDelta } from '../types';

export const HEALTH_MIN = 0;
export const HEALTH_MAX = 100;

/**
 * Thrown when an *externally proposed* health change falls outside 0–100.
 *
 * Distinct from clamping on purpose — see the two functions below.
 */
export class HealthValidationError extends Error {
  constructor(
    readonly dimension: string,
    readonly value: number,
    message: string,
  ) {
    super(message);
    this.name = 'HealthValidationError';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Apply a delta from the **rule engine**, clamping into range.
 *
 * This path never fails. A player's choice is a game mechanic: it should always
 * resolve to *some* outcome, and an impact that would push a dimension past its
 * bound simply saturates there.
 *
 * Do not use this for changes proposed by an agent — see `applyValidatedDelta`.
 */
export function clampHealth(health: Health, delta: HealthDelta): Health {
  const next = { ...health };
  for (const dimension of HEALTH_DIMENSIONS) {
    const change = delta[dimension];
    if (change === undefined) continue;
    next[dimension] = clamp(next[dimension] + change, HEALTH_MIN, HEALTH_MAX);
  }
  return next;
}

/**
 * Apply a delta proposed by an **external caller** (an agent tool call, or a
 * future admin API), rejecting anything out of range.
 *
 * Rejecting rather than clamping is the point: silently saturating an agent's
 * proposal would let a buggy or adversarial agent claim it moved a value it did
 * not, and the caller would never learn. The caller must resubmit a valid value.
 *
 * See GDD §17 principle 5 and docs/ARCHITECTURE.md §5.6.
 */
export function applyValidatedDelta(current: Health, delta: HealthDelta): Health {
  const next = { ...current };

  for (const dimension of HEALTH_DIMENSIONS) {
    const change = delta[dimension];
    if (change === undefined) continue;

    if (!Number.isFinite(change)) {
      throw new HealthValidationError(
        dimension,
        change,
        `Proposed change for "${dimension}" is not a finite number: ${change}`,
      );
    }

    const value = next[dimension] + change;
    if (value < HEALTH_MIN || value > HEALTH_MAX) {
      throw new HealthValidationError(
        dimension,
        value,
        `Proposed value for "${dimension}" is ${value}, outside the allowed range ${HEALTH_MIN}–${HEALTH_MAX}`,
      );
    }
    next[dimension] = value;
  }

  return next;
}

/** True when every dimension sits inside its bound. */
export function isWithinBounds(health: Health): boolean {
  return HEALTH_DIMENSIONS.every(
    (dimension) => health[dimension] >= HEALTH_MIN && health[dimension] <= HEALTH_MAX,
  );
}
