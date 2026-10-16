import { EVENT_CATALOG } from '../../lambda/game-api/src/content/events';
import { PATIENT_TEMPLATES } from '../../lambda/game-api/src/content/patients';
import { buildEventItem, eventsForStage } from '../../lambda/game-api/src/domain/engine';
import { buildPatientItem, buildSessionItem } from '../../lambda/game-api/src/handlers';
import {
  buildExtractRequest,
  buildQuestionRequest,
  formatEventLines,
  toNarrationEvent,
} from '../../lambda/game-api/src/payloads';

/**
 * What the agent is told, and — just as importantly — what it is not.
 *
 * The answer key never leaves the backend. `EventItem.choiceOutcomes` holds each
 * option's impact, score and rationale, and leaking it into a question payload
 * would let the model read the answers to the game it is commenting on.
 */

const NOW = '2026-10-16T00:00:00.000Z';
const TTL = 1_800_000_000;
const SESSION_ID = 'ses_test';
const PATIENT_ID = 'pat_test';

function fixtures() {
  const template = PATIENT_TEMPLATES[0];
  const session = buildSessionItem({
    sessionId: SESSION_ID,
    playerId: 'ply_test',
    patientId: PATIENT_ID,
    now: NOW,
    expiresAt: TTL,
    firstEventSk: 'EVENT#x',
    qol: 70,
  });
  const patient = buildPatientItem(template, SESSION_ID, PATIENT_ID, NOW, TTL);
  return { session, patient };
}

function answeredEvent(stageIndex: number, eventIndex: number, choiceId = 'B') {
  const stage = (['prevention', 'screening', 'diagnosis', 'treatment', 'recovery'] as const)[
    stageIndex
  ];
  const template = eventsForStage(EVENT_CATALOG, stage)[eventIndex];
  return {
    ...buildEventItem(template, SESSION_ID, `evt_${stageIndex}_${eventIndex}`, NOW, TTL),
    chosenChoiceId: choiceId,
    impact: { qualityOfLife: 3 },
    score: 20,
  };
}

describe('formatEventLines', () => {
  test('says so explicitly when there is nothing to show', () => {
    // An empty string under a heading invites the model to fill the gap in.
    expect(formatEventLines([])).toBe('(无记录)');
  });

  test('numbers the timeline and names the chosen option', () => {
    const lines = formatEventLines([answeredEvent(1, 0), answeredEvent(1, 1)]);
    expect(lines.split('\n')).toHaveLength(2);
    expect(lines).toMatch(/^1\. \[screening\] /);
    expect(lines).toContain('→ 选择了「');
  });

  test('marks an unanswered event rather than guessing a choice', () => {
    const event = { ...buildEventItem(eventsForStage(EVENT_CATALOG, 'prevention')[0], SESSION_ID, 'evt_x', NOW, TTL) };
    expect(formatEventLines([event])).toContain('(未记录)');
  });
});

describe('toNarrationEvent', () => {
  test('carries only what the narration prompt needs', () => {
    expect(Object.keys(toNarrationEvent(answeredEvent(0, 0))).sort()).toEqual([
      'chosenChoiceText',
      'impact',
      'stage',
      'title',
    ]);
  });
});

describe('buildQuestionRequest', () => {
  const { session, patient } = fixtures();
  const request = buildQuestionRequest({
    session,
    patient,
    recentEvents: [answeredEvent(1, 0)],
    question: '低剂量螺旋 CT 是什么？',
  });

  test('names the role and carries the player and session', () => {
    expect(request.kind).toBe('question');
    expect(request.playerId).toBe('ply_test');
    expect(request.sessionId).toBe(SESSION_ID);
  });

  test('takes the stage from the session, not from the caller', () => {
    // A model-facing stage field gets filled with prose, so the backend sends it.
    expect(request.stage).toBe(session.currentStage);
  });

  test('passes the question through untouched', () => {
    expect(request.question).toBe('低剂量螺旋 CT 是什么？');
  });

  test('includes the patient profile and health for context', () => {
    expect(request.patient).toBe(patient.profile);
    expect(request.health).toBe(patient.health);
  });

  test('renders the recent timeline as text', () => {
    expect(typeof request.recentEvents).toBe('string');
    expect(request.recentEvents).toContain('选择了「');
  });

  test('never leaks the answer key', () => {
    const serialised = JSON.stringify(request);
    expect(serialised).not.toContain('rationale');
    expect(serialised).not.toContain('choiceOutcomes');
    expect(serialised).not.toContain('impact');
  });
});

describe('buildExtractRequest', () => {
  const { session } = fixtures();

  test('names the role and the stage being extracted', () => {
    const request = buildExtractRequest({
      session,
      stage: 'screening',
      stageEvents: [answeredEvent(1, 0)],
    });
    expect(request.kind).toBe('extract');
    expect(request.stage).toBe('screening');
    expect(request.sessionId).toBe(SESSION_ID);
  });

  test('omits events the player has not answered yet', () => {
    const unanswered = buildEventItem(
      eventsForStage(EVENT_CATALOG, 'screening')[1],
      SESSION_ID,
      'evt_future',
      NOW,
      TTL,
    );
    const request = buildExtractRequest({
      session,
      stage: 'screening',
      stageEvents: [answeredEvent(1, 0), unanswered],
    });

    // One line, not two: an unmade choice has no impact to explain.
    expect(request.stageEvents.split('\n')).toHaveLength(1);
  });

  test('says so explicitly when a stage produced nothing', () => {
    const request = buildExtractRequest({ session, stage: 'recovery', stageEvents: [] });
    expect(request.stageEvents).toBe('(无记录)');
  });

  test('never leaks the answer key', () => {
    const request = buildExtractRequest({
      session,
      stage: 'screening',
      stageEvents: [answeredEvent(1, 0)],
    });
    expect(JSON.stringify(request)).not.toContain('rationale');
  });
});
