import type { Health, HealthDelta } from '../api/types';
import { HEALTH_DIMENSIONS } from '../data/health';
import { describeDelta } from './delta';

interface HealthPanelProps {
  readonly health: Health;
  readonly qualityOfLife: number;
  readonly score: number;
  /** Impact of the choice just made, shown next to each bar. */
  readonly highlight?: HealthDelta;
}

/**
 * Patient state: the four dimensions, plus the two numbers the game is scored on.
 *
 * Values are rendered exactly as the backend returns them. The backend already
 * clamps in-range for rule-engine impacts and rejects out-of-range proposals, so
 * the UI does not re-clamp — a bar that looks wrong is then a real signal rather
 * than something this component quietly hid.
 */
export default function HealthPanel({ health, qualityOfLife, score, highlight }: HealthPanelProps) {
  const changes = new Map(describeDelta(highlight).map((entry) => [entry.key, entry]));

  return (
    <section className="panel-block">
      <h2 className="panel-title">患者状态</h2>

      <div className="health-grid">
        {HEALTH_DIMENSIONS.map((dimension) => {
          const value = health[dimension.key];
          const change = changes.get(dimension.key);
          return (
            <div key={dimension.key} className="health-row">
              <div className="health-label">
                <span>{dimension.labelZh}</span>
                {!dimension.higherIsBetter && <span className="muted small">越高越差</span>}
              </div>
              <div className="health-bar" role="img" aria-label={`${dimension.labelZh} ${value}`}>
                <div
                  className={`health-fill ${dimension.higherIsBetter ? '' : 'health-fill-inverse'}`}
                  style={{ width: `${value}%` }}
                />
              </div>
              <div className="health-value">
                <span className="mono">{value}</span>
                {change && (
                  <span className={`delta ${change.good ? 'delta-good' : 'delta-bad'}`}>
                    {change.text}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <dl className="facts">
        <div>
          <dt>生活质量 QoL</dt>
          <dd>{qualityOfLife}</dd>
        </div>
        <div>
          <dt>照护得分</dt>
          <dd>{score}</dd>
        </div>
      </dl>
    </section>
  );
}
