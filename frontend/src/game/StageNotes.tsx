import type { KnowledgeResponse } from '../api/types';
import { GAME_STAGES } from '../data/stages';

export type StageNotesState =
  | { readonly kind: 'pending'; readonly stage: string }
  | { readonly kind: 'ok'; readonly stage: string; readonly data: KnowledgeResponse }
  | { readonly kind: 'failed'; readonly stage: string };

interface StageNotesProps {
  readonly state: StageNotesState;
}

function stageLabel(stage: string): string {
  return GAME_STAGES.find((entry) => entry.key === stage)?.titleZh ?? stage;
}

/**
 * What the GameMaster role did when the player advanced.
 *
 * This panel exists because the extraction was previously invisible. Advancing a
 * stage produced no agent output on screen — the client fired `/knowledge` and
 * discarded the answer — so the agent's only contribution to the game loop was
 * undetectable. A player reasonably concluded the agent was not involved at all.
 *
 * The second paragraph is the more important one: it says plainly that **the
 * plot itself is the rule engine's**. Making the agent's real contribution
 * visible should not leave the impression that it is writing the story, because
 * it is not — that separation is the project's first design decision.
 */
export default function StageNotes({ state }: StageNotesProps) {
  const label = stageLabel(state.stage);

  if (state.kind === 'pending') {
    return (
      <section className="card stage-notes">
        <div className="narration-meta">
          <span className="badge badge-warn">归纳中</span>
        </div>
        <p className="muted small">
          游戏导演正在从本阶段的事件里归纳医学术语与关键概念，稍后会写入长期记忆。
        </p>
      </section>
    );
  }

  if (state.kind === 'failed') {
    return (
      <section className="card stage-notes">
        <div className="narration-meta">
          <span className="badge badge-err">归纳失败</span>
        </div>
        <p className="muted small">
          这不影响游戏。之后提问时，回答会只依据打包的医学语料，少了本阶段的剧情补充。
        </p>
      </section>
    );
  }

  const { data } = state;
  return (
    <section className="card stage-notes">
      <div className="narration-meta">
        <span className={data.terms.length > 0 ? 'badge badge-ok' : 'badge badge-neutral'}>
          {data.terms.length > 0 ? `归纳了 ${data.terms.length} 条` : '无新增'}
        </span>
        {data.skipped && <span className="badge badge-neutral">本阶段已归纳过</span>}
        {!data.memoryConfigured && <span className="badge badge-neutral">未启用长期记忆</span>}
      </div>

      <p className="muted small">
        游戏导演读完「{label}」阶段的事件后，
        {data.terms.length > 0 ? '记下了这些概念：' : '没有发现需要额外补充的概念。'}
      </p>

      {data.terms.length > 0 && (
        <div className="ask-suggestions">
          {data.terms.map((term) => (
            <span key={term} className="chip chip-static">
              {term}
            </span>
          ))}
        </div>
      )}

      <p className="muted small">
        它们存进了 AgentCore Memory，之后你提问时可能会被引用到。<strong>剧情本身由规则引擎推进</strong>
        ——agent 不决定下一步发生什么，它只做解释与归纳。
      </p>
    </section>
  );
}
