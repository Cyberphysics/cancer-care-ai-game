import { EVENT_CATALOG } from '../../lambda/game-api/src/content/events';
import { PATIENT_TEMPLATES } from '../../lambda/game-api/src/content/patients';
import {
  advanceStage,
  AlreadyAnsweredError,
  applyChoice,
  buildEventItem,
  ChoiceNotFoundError,
  eventsForStage,
  isFinalStage,
  nextStageOf,
  StageStateError,
} from '../../lambda/game-api/src/domain/engine';
import { eventKey } from '../../lambda/game-api/src/lib/keys';
import { STAGE_ORDER, type EventItem, type EventTemplate, type Health } from '../../lambda/game-api/src/types';

const NOW = '2026-10-15T12:00:00.000Z';
const TTL = 1_800_000_000;

const fixtureCatalog: readonly EventTemplate[] = [
  {
    id: 'p1',
    stage: 'prevention',
    type: 'medical',
    title: 'Prevention one',
    description: 'first',
    choices: [
      { id: 'A', text: 'ignore', impact: { qualityOfLife: -10 }, score: 0, rationale: 'rA' },
      { id: 'B', text: 'act', impact: { qualityOfLife: 5 }, score: 20, rationale: 'rB' },
    ],
  },
  {
    id: 'p2',
    stage: 'prevention',
    type: 'care',
    title: 'Prevention two',
    description: 'second',
    choices: [{ id: 'A', text: 'only', impact: { energy: 3 }, score: 10, rationale: 'rC' }],
  },
  {
    id: 's1',
    stage: 'screening',
    type: 'medical',
    title: 'Screening one',
    description: 'third',
    choices: [{ id: 'A', text: 'act', impact: { stress: -5 }, score: 15, rationale: 'rD' }],
  },
];

const baseline: Health = { qualityOfLife: 50, energy: 50, stress: 50, nutrition: 50 };

function build(template: EventTemplate, id = `evt-${template.id}`): EventItem {
  return buildEventItem(template, 's-1', id, NOW, TTL);
}

describe('stage helpers', () => {
  test('eventsForStage returns only that stage', () => {
    expect(eventsForStage(fixtureCatalog, 'prevention').map((e) => e.id)).toEqual(['p1', 'p2']);
    expect(eventsForStage(fixtureCatalog, 'diagnosis')).toEqual([]);
  });

  test('isFinalStage identifies recovery', () => {
    expect(isFinalStage('recovery')).toBe(true);
    expect(isFinalStage('prevention')).toBe(false);
  });

  test('nextStageOf walks the order and stops at the end', () => {
    expect(nextStageOf('prevention')).toBe('screening');
    expect(nextStageOf('treatment')).toBe('recovery');
    expect(nextStageOf('recovery')).toBeUndefined();
  });
});

describe('buildEventItem', () => {
  const item = build(fixtureCatalog[0]);

  test('derives its key from the session, timestamp and event id', () => {
    expect(item).toMatchObject(eventKey('s-1', NOW, 'evt-p1'));
  });

  test('carries no sparse index keys', () => {
    // Only GameSession items may enter PlayerSessionsIndex.
    expect('GSI1PK' in item).toBe(false);
    expect('GSI1SK' in item).toBe(false);
  });

  test('materialises choice outcomes so the record is self-contained', () => {
    expect(item.choiceOutcomes.A).toEqual({
      impact: { qualityOfLife: -10 },
      score: 0,
      rationale: 'rA',
    });
    expect(item.choiceOutcomes.B.score).toBe(20);
  });

  test('exposes choice text without exposing the consequences', () => {
    expect(item.choices).toEqual([
      { id: 'A', text: 'ignore' },
      { id: 'B', text: 'act' },
    ]);
    // The wire projection decides what the client sees; the stored choices must
    // not carry impacts, or a leak is one careless spread away.
    for (const choice of item.choices) {
      expect(choice).not.toHaveProperty('impact');
      expect(choice).not.toHaveProperty('score');
    }
  });
});

describe('applyChoice', () => {
  test('applies the impact and clamps into range', () => {
    const outcome = applyChoice({
      catalog: fixtureCatalog,
      event: build(fixtureCatalog[0]),
      progress: { currentStage: 'prevention', stageIndex: 0, stageEventIndex: 0 },
      health: baseline,
      choiceId: 'A',
    });

    expect(outcome.appliedImpact).toEqual({ qualityOfLife: -10 });
    expect(outcome.health.qualityOfLife).toBe(40);
    expect(outcome.scoreDelta).toBe(0);
    expect(outcome.rationale).toBe('rA');
  });

  test('advances the cursor and yields the next event within the stage', () => {
    const outcome = applyChoice({
      catalog: fixtureCatalog,
      event: build(fixtureCatalog[0]),
      progress: { currentStage: 'prevention', stageIndex: 0, stageEventIndex: 0 },
      health: baseline,
      choiceId: 'B',
    });

    expect(outcome.stageEventIndex).toBe(1);
    expect(outcome.awaitingAdvance).toBe(false);
    expect(outcome.nextTemplate?.id).toBe('p2');
  });

  test('flags awaitingAdvance when the stage pool is exhausted, without crossing the boundary', () => {
    const outcome = applyChoice({
      catalog: fixtureCatalog,
      event: build(fixtureCatalog[1]),
      progress: { currentStage: 'prevention', stageIndex: 0, stageEventIndex: 1 },
      health: baseline,
      choiceId: 'A',
    });

    expect(outcome.awaitingAdvance).toBe(true);
    expect(outcome.nextTemplate).toBeUndefined();
    // The stage must not advance implicitly — that is always a player action.
    expect(outcome.stageEventIndex).toBe(2);
  });

  test('refuses an event that already has an answer', () => {
    const answered: EventItem = { ...build(fixtureCatalog[0]), chosenChoiceId: 'A' };
    expect(() =>
      applyChoice({
        catalog: fixtureCatalog,
        event: answered,
        progress: { currentStage: 'prevention', stageIndex: 0, stageEventIndex: 0 },
        health: baseline,
        choiceId: 'B',
      }),
    ).toThrow(AlreadyAnsweredError);
  });

  test('refuses a choice the event does not offer', () => {
    expect(() =>
      applyChoice({
        catalog: fixtureCatalog,
        event: build(fixtureCatalog[0]),
        progress: { currentStage: 'prevention', stageIndex: 0, stageEventIndex: 0 },
        health: baseline,
        choiceId: 'Z',
      }),
    ).toThrow(ChoiceNotFoundError);
  });

  test('does not mutate the health object it was given', () => {
    const original = { ...baseline };
    applyChoice({
      catalog: fixtureCatalog,
      event: build(fixtureCatalog[0]),
      progress: { currentStage: 'prevention', stageIndex: 0, stageEventIndex: 0 },
      health: original,
      choiceId: 'A',
    });
    expect(original).toEqual(baseline);
  });
});

describe('advanceStage', () => {
  const atStageEnd = {
    currentStage: 'prevention' as const,
    stageIndex: 0,
    stageEventIndex: 2,
  };

  test('moves to the next stage and opens its first event', () => {
    const outcome = advanceStage({
      catalog: fixtureCatalog,
      progress: atStageEnd,
      awaitingAdvance: true,
    });

    expect(outcome.stage).toBe('screening');
    expect(outcome.stageIndex).toBe(1);
    expect(outcome.stageEventIndex).toBe(0);
    expect(outcome.completed).toBe(false);
    expect(outcome.nextTemplate?.id).toBe('s1');
  });

  test('refuses while events remain unanswered', () => {
    expect(() =>
      advanceStage({
        catalog: fixtureCatalog,
        progress: { currentStage: 'prevention', stageIndex: 0, stageEventIndex: 0 },
        awaitingAdvance: false,
      }),
    ).toThrow(StageStateError);
  });

  test('completes the session at the final stage instead of advancing past it', () => {
    const outcome = advanceStage({
      catalog: fixtureCatalog,
      progress: { currentStage: 'recovery', stageIndex: 4, stageEventIndex: 3 },
      awaitingAdvance: true,
    });

    expect(outcome.completed).toBe(true);
    expect(outcome.nextTemplate).toBeUndefined();
    expect(outcome.stage).toBe('recovery');
  });
});

describe('the shipped catalog', () => {
  test('covers every stage with at least one event', () => {
    for (const stage of STAGE_ORDER) {
      expect(eventsForStage(EVENT_CATALOG, stage).length).toBeGreaterThan(0);
    }
  });

  test('has unique event ids and unique choice ids within each event', () => {
    const ids = EVENT_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const event of EVENT_CATALOG) {
      const choiceIds = event.choices.map((c) => c.id);
      expect(new Set(choiceIds).size).toBe(choiceIds.length);
    }
  });

  test('every event offers at least two choices, each with a rationale', () => {
    for (const event of EVENT_CATALOG) {
      expect(event.choices.length).toBeGreaterThanOrEqual(2);
      for (const choice of event.choices) {
        expect(choice.rationale.length).toBeGreaterThan(10);
      }
    }
  });

  test('no rationale recommends a drug or quotes a survival figure', () => {
    // GDD §16 safety boundary, enforced mechanically rather than by review.
    const forbidden = [/\d+\s*%/, /生存率|治愈率/, /毫克|mg\b/, /每日\s*服用/];
    for (const event of EVENT_CATALOG) {
      for (const choice of event.choices) {
        for (const pattern of forbidden) {
          expect(choice.rationale).not.toMatch(pattern);
        }
      }
    }
  });
});

describe('the shipped patient templates', () => {
  test('use distinct ids and start within health bounds', () => {
    const ids = PATIENT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const template of PATIENT_TEMPLATES) {
      for (const value of Object.values(template.initialHealth)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });
});
