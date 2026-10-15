import { useEffect, useRef, useState } from 'react';
import type { Health, HealthDelta, StageKey } from '../api/types';
import { STAGE_BACKDROP, describePatientVisual, describePatientVisualText, type Level } from './patientMood';

interface PatientAvatarProps {
  readonly health: Health;
  readonly stage: StageKey;
  /** The impact of the choice just made; its presence triggers a short reaction. */
  readonly reaction?: HealthDelta;
}

/**
 * A drawn patient whose appearance follows the health values.
 *
 * Everything that changes is a **CSS-transitionable** property — `fill`,
 * `transform` and `opacity` — never a swapped path. That is what makes a choice
 * read as a change rather than a jump cut: the face eases into its new state
 * while the numbers beside it update. A component that remounted on every
 * health change would animate nothing, which is why the reaction below is a
 * class toggle rather than a `key` change.
 *
 * The character is deliberately plain: ~30 primitives, no external assets, no
 * image loading, and identical rendering on every machine. It is a diagram of a
 * patient's state, not a portrait of one — and it needs to survive being
 * explained in an article.
 */
export default function PatientAvatar({ health, stage, reaction }: PatientAvatarProps) {
  const visual = describePatientVisual(health);
  const [reacting, setReacting] = useState(false);
  // Keeps the timeout from a previous reaction from clearing a newer one early.
  const reactionSeq = useRef(0);

  useEffect(() => {
    if (!reaction || Object.keys(reaction).length === 0) return;
    const seq = ++reactionSeq.current;
    setReacting(true);
    const timer = setTimeout(() => {
      if (reactionSeq.current === seq) setReacting(false);
    }, 900);
    return () => clearTimeout(timer);
  }, [reaction]);

  const open = [0.18, 0.5, 0.9, 1][visual.energy];
  // Worried brows tilt the *inner* ends up. In SVG, positive rotation is
  // clockwise, so the two brows take opposite signs to meet in the middle.
  const browTilt = [20, 13, 6, 0][visual.calm];
  const sweat = [1, 0.6, 0.2, 0][visual.calm];
  const blush = [0, 0.1, 0.22, 0.4][visual.wellbeing];
  const lean = [5, 3, 0.6, -1][visual.energy];
  // Nourishment reads as body mass: gaunt shoulders and hollow cheeks at the
  // bottom, a fuller frame at the top. Skin tone alone was too weak a signal —
  // the four nutrition states were near-indistinguishable without this.
  const build = [0.84, 0.92, 1, 1.07][visual.nourishment];
  const cheekScale = [0.7, 0.85, 1, 1.14][visual.nourishment];
  // Shadows under the eyes: the clearest "this person is worn out" signal, and
  // one the eye-openness scale alone cannot convey.
  const tiredEyes = [0.75, 0.45, 0.12, 0][visual.energy];
  const mouthOpacity = (level: Level) => (visual.wellbeing === level ? 1 : 0);

  return (
    <div className={`avatar-frame${reacting ? ' avatar-reacting' : ''}`}>
      <svg viewBox="0 0 140 168" role="img" aria-label={describePatientVisualText(visual)}>
        <rect x="0" y="0" width="140" height="168" rx="14" fill={STAGE_BACKDROP[stage]} />

        {/* Body. Leans with energy — a tired patient slumps rather than shrinks. */}
        <g className="avatar-body" style={{ transform: `rotate(${lean}deg) scaleX(${build})` }}>
          <path d="M 34 168 Q 34 108 70 105 Q 106 108 106 168 Z" fill="#3f5a70" />
          <path d="M 57 107 L 70 122 L 83 107 Q 70 103 57 107 Z" fill="#33506a" />
        </g>

        {/* Neck */}
        <rect x="60" y="88" width="20" height="20" rx="8" fill={visual.tone} />

        {/* Head */}
        <g className="avatar-head">
          <circle cx="70" cy="62" r="31" fill={visual.tone} />
          <circle cx="70" cy="62" r="31" fill="#000" opacity="0.06" />

          {/* Ears */}
          <circle cx="39" cy="66" r="4.6" fill={visual.tone} />
          <circle cx="101" cy="66" r="4.6" fill={visual.tone} />

          {/* Hair */}
          <path
            d="M 39 56 Q 40 28 70 28 Q 100 28 101 56 Q 96 40 70 38 Q 44 40 39 56 Z"
            fill="#2f2a2a"
          />

          {/* Cheeks. Opacity tracks wellbeing (a healthy glow is exactly what a
              low QoL patient loses), size tracks nourishment. The always-on
              nourishment signal is the body width above, since these fade out
              entirely at the lowest wellbeing. */}
          {[48, 92].map((cx) => (
            <g key={cx} className="avatar-cheek" style={{ transform: `scale(${cheekScale})` }}>
              <ellipse cx={cx} cy="74" rx="8" ry="4.6" fill="#e08a7a" opacity={blush} />
            </g>
          ))}

          {/* Eyes. Openness is a scaleY on each eye about its own centre. */}
          {[58, 82].map((cx) => (
            <g key={cx} className="avatar-eye" style={{ transform: `scaleY(${open})` }}>
              <ellipse cx={cx} cy="62" rx="4.6" ry="5.6" fill="#20242c" />
              {visual.wellbeing >= 2 && <circle cx={cx + 1.4} cy="60" r="1.3" fill="#fff" opacity="0.9" />}
            </g>
          ))}

          {/* Under-eye shadows. Separate from the eyes so they stay put while the
              eyelids move, which is what makes them read as fatigue. */}
          <g className="avatar-tense" stroke="#8a6a55" strokeWidth="2" strokeLinecap="round" opacity={tiredEyes}>
            <path d="M 54 70 Q 58 73 62 70" fill="none" />
            <path d="M 78 70 Q 82 73 86 70" fill="none" />
          </g>

          {/* Brows: tension reads here first. Worry lifts the *inner* ends, and
              in SVG a positive rotation is clockwise, so the left brow (whose
              inner end is its right end) takes the negative sign. */}
          <g className="avatar-brow" style={{ transform: `rotate(${-browTilt}deg)` }}>
            <rect x="51" y="49" width="14" height="3.2" rx="1.6" fill="#2f2a2a" />
          </g>
          <g className="avatar-brow" style={{ transform: `rotate(${browTilt}deg)` }}>
            <rect x="75" y="49" width="14" height="3.2" rx="1.6" fill="#2f2a2a" />
          </g>

          {/* Mouth: four discrete shapes cross-faded, since a curve's `d` cannot
              be transitioned. Only one is ever visible. */}
          <g stroke="#5a3d2e" strokeWidth="3.2" strokeLinecap="round" fill="none">
            <path className="avatar-mouth" d="M 54 73 Q 70 93 86 73" opacity={mouthOpacity(3)} />
            <path className="avatar-mouth" d="M 58 75 Q 70 85 82 75" opacity={mouthOpacity(2)} />
            <path className="avatar-mouth" d="M 60 78 Q 70 79.5 80 78" opacity={mouthOpacity(1)} />
            <path className="avatar-mouth" d="M 58 84 Q 70 70 82 84" opacity={mouthOpacity(0)} />
          </g>

          {/* Stress tells: a bead of sweat, and a tension mark at level 0. */}
          <path
            className="avatar-sweat"
            d="M 100 40 Q 104 46 100 49 Q 96 46 100 40 Z"
            fill="#8fd0f0"
            opacity={sweat}
          />
          <g className="avatar-tense" stroke="#f0b34a" strokeWidth="2.4" strokeLinecap="round" opacity={visual.calm === 0 ? 0.85 : 0}>
            <path d="M 38 36 L 32 28" />
            <path d="M 44 30 L 40 21" />
          </g>
        </g>
      </svg>

      {/* Just the overall reading of the face. The other three conditions are
          already legible in the health bars directly below, and listing all four
          here wrapped to three lines inside a 112px column. All four stay in the
          svg's aria-label, so nothing is lost for assistive tech. */}
      <div className="avatar-caption">
        <span className="avatar-caption-item">{visual.labels.wellbeing}</span>
      </div>
    </div>
  );
}
