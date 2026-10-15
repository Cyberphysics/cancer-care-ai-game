import type { HealthDelta } from '../api/types';
import { HEALTH_DIMENSIONS } from '../data/health';

export interface DescribedDelta {
  readonly key: string;
  readonly labelZh: string;
  /** Already signed and formatted, e.g. `+5` / `-3`. */
  readonly text: string;
  /** Whether this change is good for the patient. */
  readonly good: boolean;
}

/**
 * Turn a raw health delta into displayable rows.
 *
 * The `good` flag is not `value > 0`: `stress` is the one dimension where a rise
 * is bad (docs/GAME-RULES.md), so it is derived from the dimension metadata
 * rather than from the sign. Getting this backwards would show a patient's
 * mounting stress in green.
 *
 * Dimensions absent from the delta are omitted — an impact only ever mentions
 * the dimensions it actually touches.
 */
export function describeDelta(delta: HealthDelta | undefined): readonly DescribedDelta[] {
  if (!delta) return [];

  return HEALTH_DIMENSIONS.flatMap((dimension) => {
    const value = delta[dimension.key];
    if (value === undefined || value === 0) return [];
    return [
      {
        key: dimension.key,
        labelZh: dimension.labelZh,
        text: value > 0 ? `+${value}` : `${value}`,
        good: dimension.higherIsBetter ? value > 0 : value < 0,
      },
    ];
  });
}
