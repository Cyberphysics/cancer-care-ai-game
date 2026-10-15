import type { EventResponse, HealthDelta } from '../api/types';
import { describeDelta } from './delta';

export interface ChoiceResult {
  readonly choiceText: string;
  readonly rationale: string;
  readonly impact: HealthDelta;
  readonly scoreDelta: number;
}

interface EventCardProps {
  readonly event: EventResponse | null;
  /** True when the current stage has no events left, so the player must advance. */
  readonly awaitingAdvance: boolean;
  readonly busy: boolean;
  /** Set right after a choice, replacing the choices with the outcome. */
  readonly result: ChoiceResult | null;
  readonly onChoose: (choiceId: string) => void;
  readonly onContinue: () => void;
  readonly onAdvance: () => void;
}

const EVENT_TYPE_LABEL: Record<EventResponse['type'], string> = {
  medical: '医疗',
  care: '照护',
  emotion: '情绪',
};

/**
 * The event the player is answering, or the outcome of the one just answered.
 *
 * Two beats rather than one on purpose: showing the impact and its rationale
 * *before* offering the next event is what makes the choice feel consequential.
 * The consequence itself is computed entirely by the rule engine — the AI never
 * decides an outcome, it only explains one.
 */
export default function EventCard({
  event,
  awaitingAdvance,
  busy,
  result,
  onChoose,
  onContinue,
  onAdvance,
}: EventCardProps) {
  if (result) {
    const changes = describeDelta(result.impact);
    return (
      <section className="card result">
        <h2>你的选择</h2>
        <p className="choice-made">{result.choiceText}</p>

        <div className="impact-row">
          {changes.length === 0 ? (
            <span className="muted">本次选择没有引起明显变化</span>
          ) : (
            changes.map((change) => (
              <span key={change.key} className={`badge ${change.good ? 'badge-ok' : 'badge-err'}`}>
                {change.labelZh} {change.text}
              </span>
            ))
          )}
          {result.scoreDelta !== 0 && (
            <span className="badge badge-neutral">照护得分 {result.scoreDelta > 0 ? '+' : ''}{result.scoreDelta}</span>
          )}
        </div>

        <div className="rationale">
          <h3>为什么</h3>
          <p>{result.rationale}</p>
        </div>

        {awaitingAdvance ? (
          <>
            <p className="muted">本阶段的事件已全部处理完。</p>
            <button type="button" className="btn btn-primary" onClick={onAdvance} disabled={busy}>
              {busy ? '正在推进…' : '进入下一阶段'}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onContinue} disabled={busy}>
            继续
          </button>
        )}
      </section>
    );
  }

  if (!event) {
    // Reached when a stage is exhausted without a fresh choice — normally the
    // result card has already offered the advance button.
    return (
      <section className="card">
        <h2>当前阶段</h2>
        <p className="muted">本阶段的事件已全部处理完。</p>
        <button type="button" className="btn btn-primary" onClick={onAdvance} disabled={busy}>
          {busy ? '正在推进…' : '进入下一阶段'}
        </button>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="event-head">
        <span className="badge badge-neutral">{EVENT_TYPE_LABEL[event.type]}</span>
      </div>
      <h2>{event.title}</h2>
      <p className="event-desc">{event.description}</p>

      <div className="choices">
        {event.choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="btn btn-choice"
            onClick={() => onChoose(choice.id)}
            disabled={busy}
          >
            {choice.text}
          </button>
        ))}
      </div>

      {busy && <p className="muted small">正在提交…</p>}
    </section>
  );
}
