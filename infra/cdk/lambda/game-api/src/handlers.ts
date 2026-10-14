import { AgentUnavailableError, invokeGameMaster, type NarrationRequest } from './agent';
import { DISCLAIMER, EVENT_CATALOG } from './content/events';
import {
  DEFAULT_PATIENT_TEMPLATE_ID,
  findPatientTemplate,
  pickPatientTemplate,
} from './content/patients';
import { advanceStage, applyChoice, buildEventItem } from './domain/engine';
import { sanitize } from './domain/safety';
import { newEventId, newPatientId, newPlayerId, newSessionId } from './lib/ids';
import {
  narrationKey,
  nowIso,
  omitUndefined,
  patientKey,
  playerKey,
  sessionIndexKey,
  sessionKey,
  ttlFromNow,
} from './lib/keys';
import {
  createSessionTransaction,
  getItemAt,
  getNarration,
  getPlayer,
  getSession,
  listEvents,
  putNarration,
  putPlayer,
  submitChoiceTransaction,
  advanceStageTransaction,
  TransactionConflictError,
} from './repo';
import type {
  AdvanceResponse,
  CreatePlayerRequest,
  CreateSessionRequest,
  EventItem,
  EventResponse,
  Health,
  HttpApiEvent,
  PatientItem,
  PatientTemplate,
  SessionItem,
  SessionResponse,
  SubmitChoiceRequest,
  SubmitChoiceResponse,
} from './types';
import { STAGE_ORDER } from './types';
import { badGateway, badRequest, conflict, created, notFound, ok } from './responses';

/** Demo sessions expire on their own; the table's TTL attribute consumes this. */
const SESSION_TTL_DAYS = 7;

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */

/**
 * Project a stored event onto the wire shape.
 *
 * **`choiceOutcomes` is deliberately never included.** It holds each option's
 * impact, score and rationale — sending it for an unanswered event would hand
 * the player the answer key. The consequences are revealed only after the
 * choice is committed.
 */
function toEventResponse(item: EventItem): EventResponse {
  const answered = Boolean(item.chosenChoiceId);

  return {
    eventId: item.eventId,
    stage: item.stage,
    type: item.type,
    title: item.title,
    description: item.description,
    choices: item.choices.map((choice) => ({ id: choice.id, text: choice.text })),
    timestamp: item.timestamp,
    ...(answered
      ? {
          chosenChoiceId: item.chosenChoiceId,
          impact: item.impact,
          rationale: item.agentRationale,
        }
      : {}),
  };
}

function toSessionResponse(
  session: SessionItem,
  patient: PatientItem,
  activeEvent: EventItem | null,
): SessionResponse {
  return {
    sessionId: session.sessionId,
    playerId: session.playerId,
    patientId: session.patientId,
    currentStage: session.currentStage,
    stageIndex: session.stageIndex,
    score: session.score,
    qualityOfLife: session.qol,
    status: session.status,
    awaitingAdvance: session.awaitingAdvance,
    startedAt: session.startedAt,
    patient: patient.profile,
    health: patient.health,
    activeEvent: activeEvent ? toEventResponse(activeEvent) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

export function buildPatientItem(
  template: PatientTemplate,
  sessionId: string,
  patientId: string,
  now: string,
  expiresAt: number,
): PatientItem {
  return {
    ...patientKey(sessionId, patientId),
    entityType: 'PatientState',
    patientId,
    sessionId,
    profile: template.profile,
    health: template.initialHealth,
    care: { medicalRecords: [], tasks: [], appointments: [] },
    relationship: { familySupport: template.initialFamilySupport },
    timeline: [{ stage: 'prevention', enteredAt: now, note: template.openingNote }],
    version: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  };
}

export function buildSessionItem(params: {
  sessionId: string;
  playerId: string;
  patientId: string;
  now: string;
  expiresAt: number;
  firstEventSk: string;
  qol: number;
}): SessionItem {
  return {
    ...sessionKey(params.sessionId),
    entityType: 'GameSession',
    // The sparse index keys — the only entity that carries them.
    ...sessionIndexKey(params.playerId, params.now),
    sessionId: params.sessionId,
    playerId: params.playerId,
    patientId: params.patientId,
    currentStage: 'prevention',
    stageIndex: 0,
    // The opening event is index 0 of the prevention pool — not 1. Setting this
    // to the count of events *served* rather than the index of the event *active*
    // makes the first resolved choice skip straight past the whole stage.
    stageEventIndex: 0,
    activeEventSk: params.firstEventSk,
    awaitingAdvance: false,
    score: 0,
    qol: params.qol,
    status: 'active',
    startedAt: params.now,
    version: 1,
    createdAt: params.now,
    updatedAt: params.now,
    expiresAt: params.expiresAt,
  };
}

/* ------------------------------------------------------------------ *
 * Request parsing
 * ------------------------------------------------------------------ */

/**
 * Result of parsing a request body.
 *
 * A discriminated union rather than `T | { parseError }`: TypeScript cannot
 * narrow a generic union member away, so the `ok` literal is what makes
 * `if (!parsed.ok)` actually narrow `parsed.value` to `T`.
 */
type ParsedBody<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function parseJsonBody<T>(event: HttpApiEvent): ParsedBody<T> {
  if (!event.body) {
    return { ok: false, error: 'Request body is required' };
  }
  try {
    return { ok: true, value: JSON.parse(event.body) as T };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON' };
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/* ------------------------------------------------------------------ *
 * Players
 * ------------------------------------------------------------------ */

export async function handleCreatePlayer(event: HttpApiEvent) {
  const parsed = parseJsonBody<CreatePlayerRequest>(event);
  if (!parsed.ok) return badRequest(parsed.error);

  const body = parsed.value;
  if (typeof body.nickname !== 'string' || body.nickname.trim() === '') {
    return badRequest('Field "nickname" must be a non-empty string');
  }

  const now = nowIso();
  const playerId = newPlayerId();

  await putPlayer({
    ...playerKey(playerId),
    entityType: 'Player',
    playerId,
    nickname: body.nickname.trim(),
    ...(body.locale ? { locale: body.locale } : {}),
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlFromNow(SESSION_TTL_DAYS),
  });

  return created({ playerId, nickname: body.nickname.trim(), createdAt: now });
}

export async function handleGetPlayer(event: HttpApiEvent) {
  const playerId = event.pathParameters?.playerId;
  if (!playerId) return badRequest('Missing path parameter "playerId"');

  const player = await getPlayer(playerId);
  if (!player) return notFound(`Player ${playerId} not found`);

  return ok({
    playerId: player.playerId,
    nickname: player.nickname,
    locale: player.locale,
    createdAt: player.createdAt,
  });
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export async function handleCreateSession(event: HttpApiEvent) {
  const parsed = parseJsonBody<CreateSessionRequest>(event);
  if (!parsed.ok) return badRequest(parsed.error);

  const body = parsed.value;
  if (typeof body.playerId !== 'string' || body.playerId.trim() === '') {
    return badRequest('Field "playerId" must be a non-empty string');
  }

  const player = await getPlayer(body.playerId);
  if (!player) return notFound(`Player ${body.playerId} not found`);

  const sessionId = newSessionId();
  const patientId = newPatientId();

  const template = body.patientTemplateId
    ? findPatientTemplate(body.patientTemplateId)
    : pickPatientTemplate(sessionId);

  if (!template) {
    return badRequest(
      `Unknown patientTemplateId "${body.patientTemplateId}". Default is ${DEFAULT_PATIENT_TEMPLATE_ID}.`,
    );
  }

  const now = nowIso();
  const expiresAt = ttlFromNow(SESSION_TTL_DAYS);
  const eventId = newEventId();

  const firstTemplate = EVENT_CATALOG.find((candidate) => candidate.stage === 'prevention');
  if (!firstTemplate) {
    // The catalog is a compile-time constant, so this means the code is broken,
    // not the request. Let it surface as a 500 via the router's catch.
    throw new Error('Event catalog is misconfigured: no prevention-stage event');
  }

  const firstEvent = buildEventItem(firstTemplate, sessionId, eventId, now, expiresAt);
  const patient = buildPatientItem(template, sessionId, patientId, now, expiresAt);
  const session = buildSessionItem({
    sessionId,
    playerId: player.playerId,
    patientId,
    now,
    expiresAt,
    firstEventSk: firstEvent.SK,
    qol: template.initialHealth.qualityOfLife,
  });

  await createSessionTransaction({ session, patient, firstEvent });

  return created(toSessionResponse(session, patient, firstEvent));
}

export async function handleGetSession(event: HttpApiEvent) {
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) return badRequest('Missing path parameter "sessionId"');

  const session = await getSession(sessionId);
  if (!session) return notFound(`Session ${sessionId} not found`);

  const patientItem = await getItemAt(patientKey(sessionId, session.patientId));
  if (!patientItem) return notFound(`Patient state for session ${sessionId} not found`);

  const activeEvent = session.activeEventSk
    ? ((await getItemAt({ PK: session.PK, SK: session.activeEventSk })) as EventItem | undefined)
    : undefined;

  return ok(toSessionResponse(session, patientItem as unknown as PatientItem, activeEvent ?? null));
}

export async function handleListEvents(event: HttpApiEvent) {
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) return badRequest('Missing path parameter "sessionId"');

  const session = await getSession(sessionId);
  if (!session) return notFound(`Session ${sessionId} not found`);

  const events = await listEvents(sessionId);

  return ok({
    sessionId,
    count: events.length,
    disclaimer: DISCLAIMER,
    events: events.map(toEventResponse),
  });
}

/* ------------------------------------------------------------------ *
 * The core game loop
 * ------------------------------------------------------------------ */

export async function handleSubmitChoice(event: HttpApiEvent) {
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) return badRequest('Missing path parameter "sessionId"');

  const parsed = parseJsonBody<SubmitChoiceRequest>(event);
  if (!parsed.ok) return badRequest(parsed.error);

  const body = parsed.value;
  if (!isNonEmptyString(body.eventId) || !isNonEmptyString(body.choiceId)) {
    return badRequest('Fields "eventId" and "choiceId" must both be non-empty strings');
  }
  const eventId = body.eventId;
  const choiceId = body.choiceId;

  const session = await getSession(sessionId);
  if (!session) return notFound(`Session ${sessionId} not found`);
  if (session.status !== 'active') {
    return conflict(`Session ${sessionId} is ${session.status} and no longer accepts choices`);
  }
  if (!session.activeEventSk) {
    return conflict('No event is awaiting a choice. Call /advance to move to the next stage.');
  }

  const activeEventItem = (await getItemAt({
    PK: session.PK,
    SK: session.activeEventSk,
  })) as EventItem | undefined;

  if (!activeEventItem) {
    return conflict('The session points at an event that no longer exists');
  }
  if (activeEventItem.eventId !== eventId) {
    return conflict(
      `eventId "${eventId}" is not the active event ("${activeEventItem.eventId}"). ` +
        'Re-read the session and submit against the current event.',
    );
  }

  const patientItem = (await getItemAt(
    patientKey(sessionId, session.patientId),
  )) as PatientItem | undefined;
  if (!patientItem) return notFound(`Patient state for session ${sessionId} not found`);

  const outcome = applyChoice({
    catalog: EVENT_CATALOG,
    event: activeEventItem,
    progress: session,
    health: patientItem.health,
    choiceId,
  });

  const now = nowIso();
  const expiresAt = ttlFromNow(SESSION_TTL_DAYS);
  const nextEvent = outcome.nextTemplate
    ? buildEventItem(outcome.nextTemplate, sessionId, newEventId(), now, expiresAt)
    : undefined;

  await submitChoiceTransaction({
    session,
    expectedSessionVersion: session.version,
    patientKey: patientKey(sessionId, session.patientId),
    expectedPatientVersion: patientItem.version,
    nextHealth: outcome.health,
    answeredEventKey: { PK: session.PK, SK: activeEventItem.SK },
    choiceId,
    impact: outcome.appliedImpact,
    rationale: outcome.rationale,
    scoreDelta: outcome.scoreDelta,
    nextStageEventIndex: outcome.stageEventIndex,
    awaitingAdvance: outcome.awaitingAdvance,
    ...(nextEvent ? { nextEvent } : {}),
    now,
  });

  // `omitUndefined` drops `activeEventSk` entirely when no event follows, which
  // is the correct state — a pointer left dangling at an answered event would
  // make the next `/choices` call target the wrong thing.
  const updatedSession = omitUndefined<SessionItem>({
    ...session,
    stageEventIndex: outcome.stageEventIndex,
    awaitingAdvance: outcome.awaitingAdvance,
    score: session.score + outcome.scoreDelta,
    qol: outcome.health.qualityOfLife,
    version: session.version + 1,
    updatedAt: now,
    activeEventSk: nextEvent?.SK,
  });

  const updatedPatient: PatientItem = {
    ...patientItem,
    health: outcome.health,
    version: patientItem.version + 1,
    updatedAt: now,
  };

  const response: SubmitChoiceResponse = {
    session: toSessionResponse(updatedSession, updatedPatient, nextEvent ?? null),
    appliedImpact: outcome.appliedImpact,
    health: outcome.health,
    score: updatedSession.score,
    rationale: outcome.rationale,
    nextEvent: nextEvent ? toEventResponse(nextEvent) : null,
    awaitingAdvance: outcome.awaitingAdvance,
    completed: false,
  };

  return ok(response);
}

export async function handleAdvance(event: HttpApiEvent) {
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) return badRequest('Missing path parameter "sessionId"');

  const session = await getSession(sessionId);
  if (!session) return notFound(`Session ${sessionId} not found`);
  if (session.status !== 'active') {
    return conflict(`Session ${sessionId} is already ${session.status}`);
  }
  if (!session.awaitingAdvance) {
    return conflict(
      `Stage "${session.currentStage}" still has unanswered events. ` +
        'Submit a choice against the active event first.',
    );
  }

  const patientItem = (await getItemAt(
    patientKey(sessionId, session.patientId),
  )) as PatientItem | undefined;
  if (!patientItem) return notFound(`Patient state for session ${sessionId} not found`);

  const outcome = advanceStage({
    catalog: EVENT_CATALOG,
    progress: session,
    awaitingAdvance: session.awaitingAdvance,
  });

  const now = nowIso();
  const expiresAt = ttlFromNow(SESSION_TTL_DAYS);
  const nextEvent = outcome.nextTemplate
    ? buildEventItem(outcome.nextTemplate, sessionId, newEventId(), now, expiresAt)
    : undefined;

  const nextTimeline = [
    ...patientItem.timeline,
    {
      stage: outcome.stage,
      enteredAt: now,
      note: outcome.completed ? '五阶段照护流程已完成' : undefined,
    },
  ];

  await advanceStageTransaction({
    session,
    expectedSessionVersion: session.version,
    // From the engine's outcome — never from `session`, which still holds the
    // stage being left.
    nextStage: outcome.stage,
    nextStageIndex: outcome.stageIndex,
    nextStageEventIndex: outcome.stageEventIndex,
    patientKey: patientKey(sessionId, session.patientId),
    expectedPatientVersion: patientItem.version,
    nextTimeline,
    awaitingAdvance: outcome.awaitingAdvance,
    completed: outcome.completed,
    ...(nextEvent ? { activeEventSk: nextEvent.SK } : {}),
    ...(nextEvent ? { nextEvent } : {}),
    now,
  });

  const updatedSession = omitUndefined<SessionItem>({
    ...session,
    currentStage: outcome.stage,
    stageIndex: outcome.stageIndex,
    stageEventIndex: outcome.stageEventIndex,
    awaitingAdvance: outcome.awaitingAdvance,
    status: outcome.completed ? 'completed' : 'active',
    version: session.version + 1,
    updatedAt: now,
    completedAt: outcome.completed ? now : undefined,
    activeEventSk: nextEvent?.SK,
  });

  const updatedPatient: PatientItem = {
    ...patientItem,
    timeline: nextTimeline,
    version: patientItem.version + 1,
    updatedAt: now,
  };

  const response: AdvanceResponse = {
    session: toSessionResponse(updatedSession, updatedPatient, nextEvent ?? null),
    nextEvent: nextEvent ? toEventResponse(nextEvent) : null,
    completed: outcome.completed,
  };

  return ok(response);
}

/* ------------------------------------------------------------------ *
 * Agent narration
 * ------------------------------------------------------------------ */

/** Trim an event down to what the model needs — no ids, no bookkeeping. */
function toNarrationEvent(item: EventItem) {
  const chosenText =
    item.choices.find((choice) => choice.id === item.chosenChoiceId)?.text ?? '(未记录)';
  return {
    stage: item.stage,
    title: item.title,
    chosenChoiceText: chosenText,
    impact: item.impact,
  };
}

/**
 * Generate (or return cached) agent narration for a session.
 *
 * Failure here is reported as 502 and **changes nothing about the game**. The
 * playable loop does not call this endpoint; a player can complete all five
 * stages with the agent permanently unavailable. That isolation is deliberate —
 * see docs/ARCHITECTURE.md §1.
 */
export async function handleNarration(event: HttpApiEvent) {
  const sessionId = event.pathParameters?.sessionId;
  if (!sessionId) return badRequest('Missing path parameter "sessionId"');

  const parsed = parseJsonBody<NarrationRequest>(event);
  if (!parsed.ok) return badRequest(parsed.error);

  const { kind } = parsed.value;
  if (kind !== 'choice' && kind !== 'summary') {
    return badRequest(`Field "kind" must be "choice" or "summary", got ${JSON.stringify(kind)}`);
  }

  const session = await getSession(sessionId);
  if (!session) return notFound(`Session ${sessionId} not found`);

  const cached = await getNarration(sessionId, kind);
  if (cached) {
    return ok({
      text: cached.text,
      kind,
      provider: cached.provider,
      modelId: cached.modelId,
      degraded: cached.degraded,
      generatedAt: cached.generatedAt,
      cached: true,
    });
  }

  const patientItem = (await getItemAt(
    patientKey(sessionId, session.patientId),
  )) as PatientItem | undefined;
  if (!patientItem) return notFound(`Patient state for session ${sessionId} not found`);

  const answered = (await listEvents(sessionId)).filter((item) => item.chosenChoiceId);
  if (kind === 'choice' && answered.length === 0) {
    return conflict('No choice has been made yet, so there is nothing to explain');
  }

  const request: NarrationRequest = {
    kind,
    playerId: session.playerId,
    sessionId,
    patient: patientItem.profile,
    session: {
      stage: session.currentStage,
      stageIndex: session.stageIndex,
      score: session.score,
      status: session.status,
      qualityOfLife: session.qol,
    },
    health: patientItem.health,
    events: answered.map(toNarrationEvent),
    ...(kind === 'choice' ? { focusEvent: toNarrationEvent(answered[answered.length - 1]) } : {}),
  };

  let result;
  try {
    result = await invokeGameMaster(request);
  } catch (err) {
    if (err instanceof AgentUnavailableError) {
      return badGateway(`Agent 不可用：${err.message}`);
    }
    throw err;
  }

  if (!result.ok || !result.text) {
    return badGateway(`Agent 生成失败：${result.error ?? 'unknown error'}`, {
      errorType: result.errorType,
    });
  }

  // Second line of defence: the agent guards its own output, but the backend
  // does not take that on trust.
  const { text, degraded } = sanitize(result.text);
  const generatedAt = result.generatedAt ?? nowIso();

  try {
    await putNarration({
      ...narrationKey(sessionId, kind),
      entityType: 'Narration',
      sessionId,
      kind,
      text,
      provider: result.provider ?? 'unknown',
      modelId: result.modelId ?? 'unknown',
      degraded,
      generatedAt,
      createdAt: generatedAt,
      updatedAt: generatedAt,
      expiresAt: ttlFromNow(SESSION_TTL_DAYS),
    });
  } catch (err) {
    // A cache write failing costs one regeneration and nothing else. Serving
    // the text we already have is strictly better than failing the request.
    console.warn('narration cache write failed', err);
  }

  return ok({
    text,
    kind,
    provider: result.provider,
    modelId: result.modelId,
    degraded,
    generatedAt,
    cached: false,
  });
}

/* ------------------------------------------------------------------ *
 * Health check
 * ------------------------------------------------------------------ */

export async function handleHealth() {
  return ok({
    status: 'ok',
    phase: 2,
    description: 'Phase 2 — 规则引擎驱动的五阶段照护模拟（无 LLM）',
    stage: process.env.STAGE ?? 'unknown',
    region: process.env.AWS_REGION ?? 'unknown',
    tableName: process.env.TABLE_NAME ?? 'unset',
    catalogEvents: EVENT_CATALOG.length,
    stages: STAGE_ORDER,
    disclaimer: DISCLAIMER,
    timestamp: nowIso(),
  });
}
