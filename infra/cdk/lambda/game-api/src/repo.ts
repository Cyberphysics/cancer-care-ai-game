import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tableName } from './lib/ddb';
import { omitUndefined, playerKey, sessionKey, type PrimaryKey } from './lib/keys';
import type {
  EventItem,
  Health,
  HealthDelta,
  PatientItem,
  PlayerItem,
  SessionItem,
} from './types';

type TransactWriteItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/**
 * The only module that talks to DynamoDB.
 *
 * Everything above it (`domain/`) is pure; everything below it is I/O. Keeping
 * the boundary sharp is what makes the rule engine testable without mocks.
 */

/** Raised when a conditional write lost a race or hit an idempotency guard. */
export class TransactionConflictError extends Error {
  constructor(
    message: string,
    readonly reasons: readonly string[],
  ) {
    super(message);
    this.name = 'TransactionConflictError';
  }
}

/** Raised when a conditional update fails, e.g. a stale `version`. */
export class ConditionalCheckError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'ConditionalCheckError';
  }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getPlayer(playerId: string): Promise<PlayerItem | undefined> {
  const result = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: playerKey(playerId) }),
  );
  return result.Item as PlayerItem | undefined;
}

export async function getSession(sessionId: string): Promise<SessionItem | undefined> {
  const result = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: sessionKey(sessionId) }),
  );
  return result.Item as SessionItem | undefined;
}

export async function getItemAt(key: PrimaryKey): Promise<Record<string, unknown> | undefined> {
  const result = await docClient.send(new GetCommand({ TableName: tableName(), Key: key }));
  return result.Item;
}

/** Everything in a session partition, in sort-key order (event keys sort chronologically). */
export async function querySessionPartition(
  sessionId: string,
  options: { readonly ascending?: boolean } = {},
): Promise<readonly Record<string, unknown>[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'PK' },
      ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}` },
      ScanIndexForward: options.ascending ?? true,
    }),
  );
  return (result.Items ?? []) as readonly Record<string, unknown>[];
}

/** All events of a session, oldest first. */
export async function listEvents(sessionId: string): Promise<readonly EventItem[]> {
  const items = await querySessionPartition(sessionId, { ascending: true });
  return items.filter((item) => String(item.SK).startsWith('EVENT#')) as unknown as EventItem[];
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export async function putPlayer(item: PlayerItem): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: tableName(),
      Item: omitUndefined(item),
      // Player ids are generated, so a collision means something is very wrong.
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

/**
 * Create a session, its patient, and the opening event in one atomic write.
 *
 * Three items that are meaningless apart: a session with no patient, or a
 * patient with no opening scene, would both be broken states that the API would
 * then have to defend against.
 */
export async function createSessionTransaction(params: {
  readonly session: SessionItem;
  readonly patient: PatientItem;
  readonly firstEvent: EventItem;
}): Promise<void> {
  const table = tableName();

  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table,
            Item: omitUndefined(params.session),
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: table,
            Item: omitUndefined(params.patient),
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: table,
            Item: omitUndefined(params.firstEvent),
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }),
  );
}

export interface SubmitChoiceTransactionParams {
  readonly session: SessionItem;
  readonly expectedSessionVersion: number;
  readonly patientKey: PrimaryKey;
  readonly expectedPatientVersion: number;
  readonly nextHealth: Health;
  readonly answeredEventKey: PrimaryKey;
  readonly choiceId: string;
  readonly impact: HealthDelta;
  readonly rationale: string;
  readonly scoreDelta: number;
  readonly nextStageEventIndex: number;
  readonly awaitingAdvance: boolean;
  /** Present only when the stage still has events left. */
  readonly nextEvent?: EventItem;
  readonly now: string;
}

/**
 * Commit a resolved choice.
 *
 * Four items, one transaction, four conditions:
 *
 *  - the patient update is guarded by `version = :expected`  → optimistic lock
 *  - the session update is guarded by `version = :expected`  → optimistic lock
 *  - the answered event is guarded by `attribute_not_exists(chosenChoiceId)`
 *    → double-submit protection
 *  - the next event is guarded by `attribute_not_exists(PK)`
 *    → the same next event cannot be inserted twice
 *
 * Two optimistic locks rather than one because the session and the patient are
 * independently mutable; checking only one would let a concurrent writer slip
 * past on the other. This is the concrete implementation of GDD §17 principle 5
 * — see docs/DATA-MODEL.md §9.
 */
export async function submitChoiceTransaction(
  params: SubmitChoiceTransactionParams,
): Promise<void> {
  const table = tableName();
  const { session, nextEvent } = params;

  // DynamoDB reserved words (`status`, `timestamp`, `type`, …) are a runtime-only
  // failure, so every attribute name in an expression is aliased rather than
  // trusted. Cheap insurance against a class of bug that never shows up in tests
  // that don't hit the real service.
  const sessionNames: Record<string, string> = {
    '#version': 'version',
    '#score': 'score',
    '#qol': 'qol',
    '#sei': 'stageEventIndex',
    '#aw': 'awaitingAdvance',
    '#updatedAt': 'updatedAt',
  };
  const sessionValues: Record<string, unknown> = {
    ':qol': params.nextHealth.qualityOfLife,
    ':sd': params.scoreDelta,
    ':sei': params.nextStageEventIndex,
    ':aw': params.awaitingAdvance,
    ':one': 1,
    ':sv': params.expectedSessionVersion,
    ':now': params.now,
  };

  let sessionExpression =
    'SET #qol = :qol, #score = #score + :sd, #sei = :sei, #aw = :aw, ' +
    '#version = #version + :one, #updatedAt = :now';

  if (nextEvent) {
    sessionNames['#activeEventSk'] = 'activeEventSk';
    sessionValues[':aes'] = nextEvent.SK;
    sessionExpression += ', #activeEventSk = :aes';
  } else {
    // No event is pending, so the pointer must go away entirely rather than
    // linger and point at an answered event.
    sessionExpression += ' REMOVE activeEventSk';
  }

  const transactItems: TransactWriteItem[] = [
    {
      Update: {
        TableName: table,
        Key: params.patientKey,
        UpdateExpression: 'SET #health = :health, #version = #version + :one, #updatedAt = :now',
        ConditionExpression: '#version = :pv',
        ExpressionAttributeNames: {
          '#health': 'health',
          '#version': 'version',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':health': params.nextHealth,
          ':pv': params.expectedPatientVersion,
          ':one': 1,
          ':now': params.now,
        },
      },
    },
    {
      Update: {
        TableName: table,
        Key: params.answeredEventKey,
        UpdateExpression:
          'SET chosenChoiceId = :cid, #impact = :impact, #score = :score, ' +
          '#rationale = :rationale, #updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(chosenChoiceId)',
        ExpressionAttributeNames: {
          '#impact': 'impact',
          '#score': 'score',
          '#rationale': 'agentRationale',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':cid': params.choiceId,
          ':impact': params.impact,
          ':score': params.scoreDelta,
          ':rationale': params.rationale,
          ':now': params.now,
        },
      },
    },
    {
      Update: {
        TableName: table,
        Key: sessionKey(session.sessionId),
        UpdateExpression: sessionExpression,
        ConditionExpression: '#version = :sv',
        ExpressionAttributeNames: sessionNames,
        ExpressionAttributeValues: sessionValues,
      },
    },
  ];

  if (nextEvent) {
    transactItems.push({
      Put: {
        TableName: table,
        Item: omitUndefined(nextEvent),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    } as TransactWriteItem);
  }

  await sendTransaction(transactItems);
}

export interface AdvanceUpdateParams {
  readonly expectedSessionVersion: number;
  /** The stage the session is moving *to*, not the one it is leaving. */
  readonly nextStage: string;
  readonly nextStageIndex: number;
  readonly nextStageEventIndex: number;
  readonly awaitingAdvance: boolean;
  readonly completed: boolean;
  readonly activeEventSk?: string;
  readonly now: string;
}

export interface UpdateExpression {
  readonly expression: string;
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
}

/**
 * Build the stage-advance update expression.
 *
 * Pure and exported so it can be tested without DynamoDB. The distinction it
 * encodes is easy to get wrong and impossible to see in an integration test:
 * the written values must come from the *destination* stage, not the session
 * being left behind. Writing the source stage back leaves the session pinned to
 * its old stage forever, which presents as an endless loop between two stages.
 */
export function buildAdvanceUpdate(params: AdvanceUpdateParams): UpdateExpression {
  const names: Record<string, string> = {
    '#version': 'version',
    '#currentStage': 'currentStage',
    '#stageIndex': 'stageIndex',
    '#sei': 'stageEventIndex',
    '#aw': 'awaitingAdvance',
    '#status': 'status',
    '#updatedAt': 'updatedAt',
  };
  const values: Record<string, unknown> = {
    ':stage': params.nextStage,
    ':si': params.nextStageIndex,
    ':sei': params.nextStageEventIndex,
    ':aw': params.awaitingAdvance,
    ':status': params.completed ? 'completed' : 'active',
    ':one': 1,
    ':sv': params.expectedSessionVersion,
    ':now': params.now,
  };

  let expression =
    'SET #currentStage = :stage, #stageIndex = :si, #sei = :sei, #aw = :aw, ' +
    '#status = :status, #version = #version + :one, #updatedAt = :now';

  if (params.completed) {
    names['#completedAt'] = 'completedAt';
    values[':completedAt'] = params.now;
    expression += ', #completedAt = :completedAt';
  }

  if (params.activeEventSk) {
    names['#activeEventSk'] = 'activeEventSk';
    values[':aes'] = params.activeEventSk;
    expression += ', #activeEventSk = :aes';
  } else {
    expression += ' REMOVE activeEventSk';
  }

  return { expression, names, values };
}

/** Advance a session to its next stage, appending a timeline entry to the patient. */
export async function advanceStageTransaction(params: {
  readonly session: SessionItem;
  readonly expectedSessionVersion: number;
  /**
   * Destination stage, supplied explicitly rather than read off `session`.
   * `session` is the state being *replaced*; deriving the written values from it
   * silently pins the session to its old stage.
   */
  readonly nextStage: SessionItem['currentStage'];
  readonly nextStageIndex: number;
  readonly nextStageEventIndex: number;
  readonly patientKey: PrimaryKey;
  readonly expectedPatientVersion: number;
  readonly nextTimeline: readonly { stage: string; enteredAt: string; note?: string }[];
  readonly awaitingAdvance: boolean;
  readonly completed: boolean;
  readonly activeEventSk?: string;
  readonly nextEvent?: EventItem;
  readonly now: string;
}): Promise<void> {
  const table = tableName();

  const update = buildAdvanceUpdate({
    expectedSessionVersion: params.expectedSessionVersion,
    nextStage: params.nextStage,
    nextStageIndex: params.nextStageIndex,
    nextStageEventIndex: params.nextStageEventIndex,
    awaitingAdvance: params.awaitingAdvance,
    completed: params.completed,
    ...(params.activeEventSk ? { activeEventSk: params.activeEventSk } : {}),
    now: params.now,
  });

  const transactItems: TransactWriteItem[] = [
    {
      Update: {
        TableName: table,
        Key: sessionKey(params.session.sessionId),
        UpdateExpression: update.expression,
        ConditionExpression: '#version = :sv',
        ExpressionAttributeNames: update.names,
        ExpressionAttributeValues: update.values,
      },
    },
    {
      Update: {
        TableName: table,
        Key: params.patientKey,
        UpdateExpression: 'SET #timeline = :timeline, #version = #version + :one, #updatedAt = :now',
        ConditionExpression: '#version = :pv',
        ExpressionAttributeNames: {
          '#timeline': 'timeline',
          '#version': 'version',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':timeline': params.nextTimeline,
          ':pv': params.expectedPatientVersion,
          ':one': 1,
          ':now': params.now,
        },
      },
    },
  ];

  if (params.nextEvent) {
    transactItems.push({
      Put: {
        TableName: table,
        Item: omitUndefined(params.nextEvent),
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    } as TransactWriteItem);
  }

  await sendTransaction(transactItems);
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/**
 * Execute a transaction, translating its failures into something the HTTP layer
 * can map to a status code.
 *
 * `CancellationReasons` is positional — index N describes `TransactItems[N]` —
 * so the reasons are reported together rather than assuming a single culprit.
 * A transaction can fail several conditions at once.
 */
async function sendTransaction(transactItems: readonly TransactWriteItem[]): Promise<void> {
  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: [...transactItems] }));
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;

    if (name === 'TransactionCanceledException') {
      const rawReasons = (err as { CancellationReasons?: { Code?: string }[] })
        .CancellationReasons;
      const reasons = (rawReasons ?? []).map(
        (reason, index) => `[${index}] ${reason?.Code ?? 'Unknown'}`,
      );
      throw new TransactionConflictError(
        `Transaction cancelled: ${reasons.join(', ') || 'no reasons reported'}`,
        reasons,
      );
    }

    if (name === 'ConditionalCheckFailedException') {
      throw new ConditionalCheckError('Conditional write failed', String(name));
    }

    throw err;
  }
}
