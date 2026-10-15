import type { StageKey } from '../api/types';
import { GAME_STAGES } from '../data/stages';

interface StageStepperProps {
  readonly currentStage: StageKey;
  readonly completed: boolean;
}

/**
 * The five-stage care journey with the player's position marked.
 *
 * Renders as a bare block, not a card: it lives inside the patient panel, where
 * a second and third rounded rectangle stacked in the same column is exactly the
 * visual noise the merged panel exists to remove. Callers that want it in its
 * own card wrap it themselves.
 *
 * Stage list comes from `data/stages.ts`, which mirrors the backend's
 * `STAGE_ORDER` — the order is the game's, not the presenter's.
 */
export default function StageStepper({ currentStage, completed }: StageStepperProps) {
  const currentIndex = GAME_STAGES.findIndex((stage) => stage.key === currentStage);

  return (
    <section className="panel-block">
      <h2 className="panel-title">照护历程</h2>
      <ol className="stepper">
        {GAME_STAGES.map((stage) => {
          const state = completed
            ? 'done'
            : stage.index < currentIndex
              ? 'done'
              : stage.index === currentIndex
                ? 'current'
                : 'todo';
          return (
            <li key={stage.key} className={`stage-${state}`}>
              <span className="step-index">{stage.index + 1}</span>
              <span className="step-name">{stage.titleZh}</span>
              <span className="step-en">{stage.titleEn}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
