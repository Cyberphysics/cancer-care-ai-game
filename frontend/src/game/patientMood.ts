import type { Health, StageKey } from '../api/types';

/**
 * Maps raw health values onto the handful of discrete levels a drawn character
 * can actually express.
 *
 * **Why levels and not a continuous mapping.** Health is 0–100, but a face has
 * maybe four readable expressions. Mapping 61 and 64 onto subtly different
 * eyebrows would add visual noise that means nothing — the player would read
 * "something changed" where nothing did. Rounding to levels keeps every visual
 * difference meaningful: if the face moved, a threshold was actually crossed.
 *
 * Thresholds are deliberately uneven (25 / 45 / 70): the middle band is where
 * most early-game values sit, so it is given the most room, and the extremes
 * are reserved for states worth noticing.
 */

export type Level = 0 | 1 | 2 | 3;

export interface PatientVisual {
  /** Overall wellbeing — drives the face's colour and expression. */
  readonly wellbeing: Level;
  /** Drives how open the eyes are and how the body leans. */
  readonly energy: Level;
  /**
   * **Calm**, not stress: `100 - health.stress`, so that every field here reads
   * "higher is better" and the drawing code never has to remember that one of
   * the four dimensions is inverted.
   */
  readonly calm: Level;
  /** Drives the face's fullness and warmth. */
  readonly nourishment: Level;
  /** Skin tone, derived from wellbeing and nourishment. */
  readonly tone: string;
  readonly labels: Readonly<Record<'wellbeing' | 'energy' | 'calm' | 'nourishment', string>>;
}

const TONES = ['#a97a5f', '#c49473', '#dcae8d', '#f0c9a8'] as const;

const LABELS = {
  wellbeing: ['很低落', '偏低', '还不错', '很好'],
  energy: ['很疲惫', '有些乏力', '还算有劲', '精力充沛'],
  calm: ['压力很大', '压力偏高', '比较放松', '很放松'],
  nourishment: ['营养不足', '营养偏弱', '营养尚可', '营养良好'],
} as const;

function levelOf(value: number): Level {
  if (!Number.isFinite(value)) return 1;
  if (value >= 70) return 3;
  if (value >= 45) return 2;
  if (value >= 25) return 1;
  return 0;
}

export function describePatientVisual(health: Health): PatientVisual {
  const wellbeing = levelOf(health.qualityOfLife);
  const energy = levelOf(health.energy);
  const calm = levelOf(100 - health.stress);
  const nourishment = levelOf(health.nutrition);

  // Tone tracks both dimensions: someone with good QoL but poor nutrition should
  // not look as healthy as someone with both. Averaging keeps a single bad
  // dimension from dominating the whole face.
  const tone = TONES[Math.round((wellbeing + nourishment) / 2)] ?? TONES[1];

  return {
    wellbeing,
    energy,
    calm,
    nourishment,
    tone,
    labels: {
      wellbeing: LABELS.wellbeing[wellbeing],
      energy: LABELS.energy[energy],
      calm: LABELS.calm[calm],
      nourishment: LABELS.nourishment[nourishment],
    },
  };
}

/** One-line description used as the avatar's accessible label. */
export function describePatientVisualText(visual: PatientVisual): string {
  return `患者形象：${visual.labels.wellbeing}，${visual.labels.energy}，${visual.labels.calm}，${visual.labels.nourishment}`;
}

/**
 * A faint background tint per stage, so the same character visibly moves through
 * the journey. Deliberately low-contrast: it is context, not a signal.
 */
export const STAGE_BACKDROP: Readonly<Record<StageKey, string>> = {
  prevention: 'rgba(79, 209, 165, 0.10)',
  screening: 'rgba(120, 190, 235, 0.10)',
  diagnosis: 'rgba(190, 160, 235, 0.10)',
  treatment: 'rgba(240, 179, 74, 0.10)',
  recovery: 'rgba(120, 225, 175, 0.10)',
};

