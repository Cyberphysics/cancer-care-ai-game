import { useState } from 'react';
import {
  ApiError,
  advanceStage,
  createPlayer,
  createSession,
  listEvents,
  submitChoice,
} from '../api/client';
import type { EventResponse, SessionResponse } from '../api/types';
import EventCard, { type ChoiceResult } from './EventCard';
import HealthPanel from './HealthPanel';
import NarrationPanel from './NarrationPanel';
import PatientAvatar from './PatientAvatar';
import StageStepper from './StageStepper';

type Screen =
  | { readonly kind: 'intro' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'playing' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * The whole game, as a single state machine.
 *
 * One screen rather than five routes on purpose: the loop is linear (create →
 * answer → advance → repeat → summary) and a router would add indirection
 * without adding a single capability. Phase 4's full page set is a separate
 * exercise; this is the smallest thing that lets someone *play* it.
 *
 * Every transition is driven by the API response. The UI keeps no game state of
 * its own — DynamoDB is the only authority (docs/ARCHITECTURE.md), and a client
 * that re-derived state locally would be a second, silently divergent one.
 */
export default function GameApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'intro' });
  const [nickname, setNickname] = useState('');
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [result, setResult] = useState<ChoiceResult | null>(null);
  const [timeline, setTimeline] = useState<readonly EventResponse[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const completed = session?.status === 'completed';

  function reportError(err: unknown) {
    const message =
      err instanceof ApiError
        ? `${err.message}（HTTP ${err.status}${err.code ? ` · ${err.code}` : ''}）`
        : err instanceof Error
          ? err.message
          : String(err);
    setNotice(message);
  }

  async function start() {
    const name = nickname.trim();
    if (!name) return;

    setScreen({ kind: 'starting' });
    setNotice(null);
    try {
      const player = await createPlayer(name);
      const created = await createSession(player.playerId);
      setSession(created);
      setResult(null);
      setTimeline([]);
      setScreen({ kind: 'playing' });
    } catch (err: unknown) {
      reportError(err);
      setScreen({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function choose(choiceId: string) {
    const active = session?.activeEvent;
    if (!session || !active) return;

    setBusy(true);
    setNotice(null);
    try {
      const response = await submitChoice(session.sessionId, active.eventId, choiceId);
      const chosen = active.choices.find((choice) => choice.id === choiceId);
      setSession(response.session);
      setResult({
        choiceText: chosen?.text ?? '（已记录）',
        rationale: response.rationale,
        impact: response.appliedImpact,
        scoreDelta: response.score - session.score,
      });
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  async function advance() {
    if (!session) return;

    setBusy(true);
    setNotice(null);
    try {
      const response = await advanceStage(session.sessionId);
      setSession(response.session);
      setResult(null);
      if (response.completed) {
        // Loaded once, at the end, so the summary can show what was actually
        // played rather than what the UI remembers playing. The request takes
        // around a second (Lambda + a partition query), so the completion card
        // reports it as loading rather than claiming "0 events" in the meantime.
        setTimelineLoading(true);
        try {
          const history = await listEvents(session.sessionId);
          setTimeline(history.events);
        } finally {
          setTimelineLoading(false);
        }
      }
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setScreen({ kind: 'intro' });
    setNickname('');
    setSession(null);
    setResult(null);
    setTimeline([]);
    setTimelineLoading(false);
    setNotice(null);
  }

  if (screen.kind === 'intro' || screen.kind === 'starting' || screen.kind === 'failed') {
    return (
      <section className="card intro-card">
        <h2>开始一次照护</h2>
        <p className="muted">
          你将以「家庭健康守护者」的身份，陪一位合成病例患者走完从预防到康复的五阶段历程。
          目标是提升他的生活质量，而不是追求治愈率。
        </p>

        <div className="field">
          <label htmlFor="nickname">你的称呼</label>
          <input
            id="nickname"
            value={nickname}
            maxLength={40}
            placeholder="例如：小陈"
            onChange={(event) => setNickname(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void start();
            }}
            disabled={screen.kind === 'starting'}
          />
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void start()}
          disabled={screen.kind === 'starting' || nickname.trim().length === 0}
        >
          {screen.kind === 'starting' ? '正在创建…' : '开始'}
        </button>

        {screen.kind === 'failed' && (
          <p className="error-text">创建失败：{screen.message}</p>
        )}
      </section>
    );
  }

  if (!session) return null;

  const patient = session.patient;

  if (completed) {
    return (
      <div className="completion">
        {notice && <p className="error-text">{notice}</p>}

        <section className="card">
          <StageStepper currentStage={session.currentStage} completed />
        </section>
        <section className="card result">
          <h2>照护完成</h2>
          <div className="patient-card">
            <PatientAvatar health={session.health} stage={session.currentStage} />
            <div className="patient-card-body">
              <p className="muted">
                这是 {patient.displayName} 走完五阶段后的状态。
              </p>
              <div className="impact-row">
                <span className="badge badge-ok">最终生活质量 {session.qualityOfLife}</span>
                <span className="badge badge-neutral">照护得分 {session.score}</span>
                <span className="badge badge-neutral">
                  {timelineLoading ? '正在读取事件…' : `${timeline.length} 个事件`}
                </span>
              </div>
              <p className="muted">
                这套流程由规则引擎完整驱动，全程不需要任何 LLM 参与——即使 AI 完全不可用，
                你也能走到这里。下面这段总结才来自 Agent。
              </p>
            </div>
          </div>
        </section>

        {timelineLoading && (
          <section className="card">
            <h2>你经历的照护历程</h2>
            <p className="muted">正在读取本会话的事件时间线…</p>
          </section>
        )}

        {!timelineLoading && timeline.length > 0 && (
          <section className="card">
            <h2>你经历的照护历程</h2>
            <ol className="timeline">
              {timeline.map((event) => {
                const chosen = event.choices.find((choice) => choice.id === event.chosenChoiceId);
                return (
                  <li key={event.eventId}>
                    <span className="timeline-title">{event.title}</span>
                    {chosen && <span className="timeline-choice">{chosen.text}</span>}
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        <NarrationPanel
          sessionId={session.sessionId}
          kind="summary"
          title="AI 结局总结"
          buttonLabel="生成结局总结"
          note="AgentCore Runtime 会读取本会话的状态与完整事件时间线，生成优势、不足与健康教育三部分。"
        />

        <button type="button" className="btn btn-ghost" onClick={reset}>
          再玩一次
        </button>
      </div>
    );
  }

  return (
    <>
      {notice && <p className="error-text">{notice}</p>}

      {/* Two columns so the choices and the patient are on screen together: the
          point of the avatar is watching it react *while* choosing, which only
          works if the player never has to scroll between the two. The patient
          side is sticky, so it also stays put if the right column grows. */}
      <div className="play-layout">
        <aside className="play-side">
          {/* One card, three blocks separated by rules. Three stacked rounded
              rectangles in the same column read as clutter and none of their
              edges lined up with anything on the right. */}
          <section className="card patient-panel">
            <div className="caregiver-line">
              照护者 · <strong>{nickname.trim() || '你'}</strong>
            </div>

            <div className="patient-head">
              <PatientAvatar
                health={session.health}
                stage={session.currentStage}
                reaction={result?.impact}
              />
              <div className="patient-head-body">
                <h2>{patient.displayName}</h2>
                <div className="status-row">
                  <span className="badge badge-neutral">
                    {patient.gender === 'male' ? '男' : '女'} · {patient.age} 岁
                  </span>
                  <span className="muted small">{patient.occupation}</span>
                </div>
                <p className="muted small">风险因素：{patient.riskFactors.join('、')}</p>
              </div>
            </div>

            <StageStepper currentStage={session.currentStage} completed={false} />

            <HealthPanel
              health={session.health}
              qualityOfLife={session.qualityOfLife}
              score={session.score}
              highlight={result?.impact}
            />
          </section>
        </aside>

        <div className="play-main">
          <EventCard
            event={result ? null : (session.activeEvent ?? null)}
            awaitingAdvance={session.awaitingAdvance}
            busy={busy}
            result={result}
            onChoose={(choiceId) => void choose(choiceId)}
            onContinue={() => setResult(null)}
            onAdvance={() => void advance()}
          />

          {/* Kept mounted through the result beat as well as the choice beat: the
              narration is cached per session, so asking for it repeatedly returns
              the same text, and hiding it while the outcome is on screen made the
              right column visibly shorter than the patient panel beside it. */}
          {session.activeEvent && timeline.length === 0 && (
            <NarrationPanel
              sessionId={session.sessionId}
              kind="choice"
              title="AI 点评"
              buttonLabel="让 AI 点评本次照护"
              note="按会话缓存：同一会话只会生成一次，之后返回的是同一条内容。"
            />
          )}
        </div>
      </div>
    </>
  );
}
