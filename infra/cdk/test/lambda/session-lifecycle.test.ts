import { EVENT_CATALOG } from '../../lambda/game-api/src/content/events';
import { PATIENT_TEMPLATES } from '../../lambda/game-api/src/content/patients';
import { applyChoice, buildEventItem, eventsForStage } from '../../lambda/game-api/src/domain/engine';
import { buildPatientItem, buildSessionItem } from '../../lambda/game-api/src/handlers';
import { eventKey } from '../../lambda/game-api/src/lib/keys';

/**
 * Guards the seam between session creation and the rule engine.
 *
 * The two are unit-tested apart from each other, which is exactly how a
 * `stageEventIndex` mismatch shipped once: the engine was right, the builder was
 * right in isolation, and the first answered choice skipped the entire stage.
 * These tests compose them the way the handler does.
 */

const NOW = '2026-10-15T12:00:00.000Z';
const TTL = 1_800_000_000;

function newSession() {
  const template = PATIENT_TEMPLATES[0];
  const sessionId = 'ses_test';
  const patientId = 'pat_test';

  const firstTemplate = eventsForStage(EVENT_CATALOG, 'prevention')[0];
  const firstEvent = buildEventItem(firstTemplate, sessionId, 'evt_0', NOW, TTL);

  return {
    patient: buildPatientItem(template, sessionId, patientId, NOW, TTL),
    session: buildSessionItem({
      sessionId,
      playerId: 'plr_test',
      patientId,
      now: NOW,
      expiresAt: TTL,
      firstEventSk: firstEvent.SK,
      qol: template.initialHealth.qualityOfLife,
    }),
    firstEvent,
  };
}

describe('session creation', () => {
  test('opens at the first stage, pointing at index 0 of its pool', () => {
    const { session, firstEvent } = newSession();

    expect(session.currentStage).toBe('prevention');
    expect(session.stageIndex).toBe(0);
    expect(session.stageEventIndex).toBe(0);
    expect(session.activeEventSk).toBe(firstEvent.SK);
    expect(session.awaitingAdvance).toBe(false);
    expect(session.status).toBe('active');
    expect(session.version).toBe(1);
  });

  test('the active event really is index 0 of the stage pool', () => {
    const { session, firstEvent } = newSession();
    const pool = eventsForStage(EVENT_CATALOG, session.currentStage);

    expect(firstEvent.SK).toBe(eventKey(session.sessionId, NOW, 'evt_0').SK);
    expect(firstEvent.title).toBe(pool[session.stageEventIndex].title);
    expect(session.stageEventIndex).toBe(0);
  });

  test('seeds the QoL mirror and the opening timeline entry', () => {
    const { session, patient } = newSession();

    expect(session.qol).toBe(patient.health.qualityOfLife);
    expect(patient.timeline).toHaveLength(1);
    expect(patient.timeline[0].stage).toBe('prevention');
    expect(patient.version).toBe(1);
  });

  test('the session carries the sparse index keys and the patient does not', () => {
    const { session, patient } = newSession();

    expect(session.GSI1PK).toBe('PLAYER#plr_test');
    expect(session.GSI1SK).toBe(NOW);
    expect('GSI1PK' in patient).toBe(false);
  });
});

describe('answering the opening event', () => {
  test('moves to the second event instead of ending the stage', () => {
    const { session, firstEvent, patient } = newSession();

    const outcome = applyChoice({
      catalog: EVENT_CATALOG,
      event: firstEvent,
      progress: session,
      health: patient.health,
      choiceId: firstEvent.choices[0].id,
    });

    expect(outcome.stageEventIndex).toBe(1);
    // The regression this file exists for: a `stageEventIndex` that counts
    // events *served* rather than the index of the event *active* makes this
    // true, silently skipping every remaining event in the stage.
    expect(outcome.awaitingAdvance).toBe(false);
    expect(outcome.nextTemplate).toBeDefined();
  });

  test('reaches awaitingAdvance only after the whole stage is consumed', () => {
    const pool = eventsForStage(EVENT_CATALOG, 'prevention');
    expect(pool.length).toBeGreaterThan(1);

    let { session, patient } = newSession();

    for (let index = 0; index < pool.length; index += 1) {
      const event = buildEventItem(pool[index], session.sessionId, `evt_${index}`, NOW, TTL);
      const outcome = applyChoice({
        catalog: EVENT_CATALOG,
        event,
        progress: session,
        health: patient.health,
        choiceId: event.choices[0].id,
      });

      const isLast = index === pool.length - 1;
      expect(outcome.awaitingAdvance).toBe(isLast);
      expect(outcome.stageEventIndex).toBe(index + 1);

      session = { ...session, stageEventIndex: outcome.stageEventIndex };
      patient = { ...patient, health: outcome.health };
    }
  });
});
