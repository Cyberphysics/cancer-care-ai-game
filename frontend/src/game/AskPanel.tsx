import { useState } from 'react';
import { ApiError, askQuestion } from '../api/client';
import type { QuestionResponse, StageKey } from '../api/types';
import { questionsForStage } from '../data/questions';

interface AskPanelProps {
  readonly sessionId: string;
  readonly stage: StageKey;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly question: string }
  | { readonly kind: 'ok'; readonly question: string; readonly data: QuestionResponse }
  | { readonly kind: 'error'; readonly question: string; readonly message: string };

/**
 * The Medical Education role, as a question box.
 *
 * Unlike the narration panel this is **not one-shot** — questions are answered
 * afresh each time, so the input stays available. That difference is worth
 * stating in the UI too, because the two panels sit near each other and the
 * narration one is deliberately cached per session.
 *
 * Citations are rendered verbatim from the response rather than parsed out of the
 * text. The backend already drops any `[S9]` the model invented, so the labels in
 * the prose and the list below always agree — re-deriving that here would be a
 * second implementation of the same rule, free to drift.
 */
export default function AskPanel({ sessionId, stage }: AskPanelProps) {
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const suggestions = questionsForStage(stage);

  async function ask(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;

    setQuestion(trimmed);
    setState({ kind: 'loading', question: trimmed });
    try {
      const data = await askQuestion(sessionId, trimmed);
      setState({ kind: 'ok', question: trimmed, data });
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? `${err.message}（HTTP ${err.status}${err.code ? ` · ${err.code}` : ''}）`
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: 'error', question: trimmed, message });
    }
  }

  return (
    <section className="card ask">
      <h2>问一问医学教育助手</h2>
      <p className="muted">
        它会先检索知识依据再作答，所以每条论断后面都带着出处。它只解释概念，
        不做诊断、不推荐治疗或药物、不预测生存期。
      </p>

      <div className="ask-input">
        <input
          value={question}
          maxLength={200}
          placeholder="例如：为什么需要做活检？"
          aria-label="你的问题"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void ask(question);
          }}
          disabled={state.kind === 'loading'}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void ask(question)}
          disabled={state.kind === 'loading' || question.trim().length === 0}
        >
          {state.kind === 'loading' ? '检索中…' : '提问'}
        </button>
      </div>

      {state.kind === 'idle' && suggestions.length > 0 && (
        <div className="ask-suggestions">
          <span className="muted small">本阶段可以问：</span>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="chip"
              onClick={() => void ask(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {state.kind === 'loading' && (
        <p className="muted small">
          检索知识依据并生成回答中。首次调用需要启动 AgentCore Runtime，通常约 10 秒；
          之后会快很多。
        </p>
      )}

      {state.kind === 'error' && (
        <div className="narration-error">
          <span className="badge badge-err">AI 暂不可用</span>
          <p className="muted">{state.message}</p>
          <p className="muted small">
            这不影响游戏：你可以继续做选择、推进阶段。Agent 是可选叠加层。
          </p>
          <button type="button" className="btn" onClick={() => void ask(state.question)}>
            重试
          </button>
        </div>
      )}

      {state.kind === 'ok' && (
        <>
          <p className="ask-echo muted small">你的问题：{state.question}</p>

          <div className="narration-meta">
            {state.data.provider && <span className="badge badge-neutral">{state.data.provider}</span>}
            {state.data.degraded ? (
              <span className="badge badge-err" title="内容护栏判定模型输出越界，已替换为提示文案">
                已降级
              </span>
            ) : state.data.citations.length === 0 ? (
              <span className="badge badge-warn" title="回答没有标注依据，因此无法追溯到来源">
                无依据
              </span>
            ) : (
              <span className="badge badge-ok">{state.data.citations.length} 条依据</span>
            )}
          </div>

          <div className="narration-text">
            {state.data.text.split('\n').map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>

          {state.data.citations.length > 0 && (
            <div className="citations">
              <h3>依据</h3>
              <ul>
                {state.data.citations.map((citation) => (
                  <li key={citation.label}>
                    {/* Two lines, concept first: several entries share a source
                        (five cite the American Cancer Society, four cite NCCN), so
                        leading with the publisher made two distinct passages look
                        like the same citation printed twice. */}
                    <div className="citation-head">
                      <span className="badge badge-neutral mono">[{citation.label}]</span>{' '}
                      <strong>{citation.title}</strong>
                    </div>
                    <div className="citation-source muted small">
                      依据：{citation.source}
                    </div>
                    {citation.url && (
                      <a
                        href={citation.url}
                        target="_blank"
                        rel="noreferrer"
                        className="small"
                      >
                        查看全文
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              <p className="muted small">
                上面是<strong>依据这些资料编写的概念说明，不是原文摘录</strong>，
                所以不标注具体页码或段落。想看原文请点「查看全文」。
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
