import type { HealthDimension } from '../api/types';

/**
 * Presentation data for the four health dimensions.
 *
 * Mirrors `HEALTH_DIMENSIONS` in the backend's types.ts, which is the authority —
 * this array only fixes display order and labels.
 */
export interface HealthDimensionMeta {
  readonly key: HealthDimension;
  readonly labelZh: string;
  /**
   * Whether a higher value is good. `stress` is the exception: the game treats it
   * as "the higher the worse" (docs/GAME-RULES.md), so a positive delta on it is
   * bad news and has to be coloured the opposite way to the other three.
   */
  readonly higherIsBetter: boolean;
}

export const HEALTH_DIMENSIONS: readonly HealthDimensionMeta[] = [
  { key: 'qualityOfLife', labelZh: '生活质量', higherIsBetter: true },
  { key: 'energy', labelZh: '精力', higherIsBetter: true },
  { key: 'nutrition', labelZh: '营养', higherIsBetter: true },
  { key: 'stress', labelZh: '压力', higherIsBetter: false },
] as const;
