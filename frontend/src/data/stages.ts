/**
 * The five stages of the lung-cancer care journey (GDD §4).
 *
 * This is presentation data only — Phase 0 ships no game logic. The stage engine,
 * event generation and choice resolution arrive in Phase 2.
 */
export interface GameStage {
  /** Stable identifier used as the `stageIndex` / `currentStage` value in DynamoDB. */
  readonly key: string;
  readonly index: number;
  readonly titleEn: string;
  readonly titleZh: string;
}

export const GAME_STAGES: readonly GameStage[] = [
  { key: 'prevention', index: 0, titleEn: 'Prevention', titleZh: '预防' },
  { key: 'screening', index: 1, titleEn: 'Screening', titleZh: '筛查' },
  { key: 'diagnosis', index: 2, titleEn: 'Diagnosis', titleZh: '诊断' },
  { key: 'treatment', index: 3, titleEn: 'Treatment', titleZh: '治疗' },
  { key: 'recovery', index: 4, titleEn: 'Recovery', titleZh: '康复' },
] as const;
