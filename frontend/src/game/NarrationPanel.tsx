import { useState } from 'react';
import { ApiError, getNarration } from '../api/client';
import type { NarrationKind, NarrationResponse } from '../api/types';

interface NarrationPanelProps {
  readonly sessionId: string;
  readonly kind: NarrationKind;
  readonly title: string;
  readonly buttonLabel: string;
  /** Shown under the button before the first call. */
  readonly note?: string;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly data: NarrationResponse }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The AgentCore layer, as one button.
 *
 * Three things this panel is careful to say out loud, because the honest version
 * is more interesting than the polished one:
 *
 * 1. **The first call is slow** — seconds, not milliseconds: the AgentCore Runtime
 *    microVM starts cold and the model then generates. The loading copy says so
 *    rather than leaving a spinner to imply a hang.
 * 2. **Narration is cached per session and kind**, not per event. A `cached` badge
 *    marks text that came from an earlier generation, so a session-level comment
 *    is never presented as commentary on the choice just made.
 * 3. **Failure here is survivable.** The endpoint can return 502 when the agent is
 *    unavailable, and the game is designed to be playable regardless — so the
 *    error is rendered as a notice, not as a blocked game.
 */
export default function NarrationPanel({
  sessionId,
  kind,
  title,
  buttonLabel,
  note,
}: NarrationPanelProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function generate() {
    setState({ kind: 'loading' });
    try {
      const data = await getNarration(sessionId, kind);
      setState({ kind: 'ok', data });
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? `${err.message}（HTTP ${err.status}${err.code ? ` · ${err.code}` : ''}）`
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: 'error', message });
    }
  }

  return (
    <section className="card narration">
      <h2>{title}</h2>

      {state.kind === 'idle' && (
        <>
          <p className="muted">
            AI Agent 会结合患者状态与你已做的选择生成一段中文点评。规则引擎决定结果，
            Agent 只负责解释——它无法改变任何游戏状态。
          </p>
          {note && <p className="muted small">{note}</p>}
          <button type="button" className="btn btn-primary" onClick={generate}>
            {buttonLabel}
          </button>
        </>
      )}

      {state.kind === 'loading' && (
        <div className="narration-loading">
          <span className="badge badge-warn">生成中</span>
          <p className="muted">
            首次调用需要启动 AgentCore Runtime 并等待模型生成，通常约 10 秒；同一会话再次请求会直接命中缓存。
          </p>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="narration-error">
          <span className="badge badge-err">AI 暂不可用</span>
          <p className="muted">{state.message}</p>
          <p className="muted small">
            这不影响游戏：五阶段流程、状态更新与事件时间线全部照常工作。这是刻意的设计——
            Agent 是可选叠加层，不是游戏的必要依赖。
          </p>
          <button type="button" className="btn" onClick={generate}>
            重试
          </button>
        </div>
      )}

      {state.kind === 'ok' && (
        <>
          <div className="narration-meta">
            <span className="badge badge-neutral">{state.data.provider}</span>
            <span className="badge badge-neutral mono">{state.data.modelId}</span>
            {state.data.cached ? (
              <span className="badge badge-warn" title="同一会话同一类型的点评只生成一次，这是更早生成的那一条">
                来自缓存
              </span>
            ) : (
              <span className="badge badge-ok">本次生成</span>
            )}
            {state.data.degraded && (
              <span className="badge badge-err" title="内容护栏判定模型输出越界，已替换为通用文案">
                已降级
              </span>
            )}
          </div>

          {state.data.cached && kind === 'choice' && (
            <p className="muted small">
              注意：选此项点评是按会话缓存的，内容对应本会话中最早被回答的那个事件，而不是你刚做的选择。
            </p>
          )}

          <div className="narration-text">
            {state.data.text.split('\n').map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>

          <p className="muted small">生成于 {new Date(state.data.generatedAt).toLocaleString()}</p>
        </>
      )}
    </section>
  );
}
