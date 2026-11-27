import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import type { ThreadInboxPayload } from '../../../services/orchestration/thread-inbox.js';
import {
  delegationResultStartPort,
  inboxPlacementStartPort,
  type RecordedActorContinuation,
  readSessionDispatchFacts,
  scheduledDedicatedStartPort,
} from '../conversation-start-ports.js';

/**
 * #4512: the inbox start port runtime routes compose (`start:` of the
 * conversation inbox) classifies the turn it places from the Session that
 * takes it, over a real EventStore's room execution binding. The binding
 * names the Session, not the conversation, so the two ids differ here.
 */
const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const CONVERSATION = 'conversation-root';
const BOUND_SESSION = 'session-successor';

function origin(
  actor: ClientOrigin['actor'],
  sender?: ClientOrigin['sender'],
): ClientOrigin {
  return {
    version: 1,
    actor,
    reported: { version: 1, surface: 'unknown', build: null },
    ...(sender ? { sender } : {}),
  };
}

async function port() {
  const store = new EventStore(
    join(makeTempDir('station-start-ports-'), 'orchestration.sqlite'),
  );
  stores.push(store);
  expect(
    await store.bindProjectTaskRoomExecution({
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: BOUND_SESSION,
    }),
  ).toEqual({ kind: 'bound' });
  const continued: Array<{
    input: RecordedActorContinuation;
    threadId: string;
  }> = [];
  const start = inboxPlacementStartPort({
    readProjectTaskRoomExecutionBinding: (sessionId) =>
      store.readProjectTaskRoomExecutionBinding(sessionId),
    continueAsRecordedActor: async (input, threadId) => {
      continued.push({ input, threadId });
      return {
        outcome: 'started',
        conversationId: input.conversationId,
        sessionId: threadId,
        turnId: 'turn-1',
      };
    },
  });
  const place = async (threadId: string, payload: ThreadInboxPayload) => {
    await start({
      conversationId: CONVERSATION,
      threadId,
      payload,
      clientTurnId: 'key-1',
    });
    return continued.at(-1)!;
  };
  return { place };
}

const actor = { userId: 'owner' };

describe('conversation inbox start port (#4512)', () => {
  test("Station's own entry into the Task-bound Session it places on is task-dispatch", async () => {
    const { place } = await port();
    const placed = await place(BOUND_SESSION, {
      message: 'wake',
      actor,
      clientOrigin: origin({ kind: 'internal' }),
    });
    expect(placed.threadId).toBe(BOUND_SESSION);
    expect(placed.input).toMatchObject({
      conversationId: CONVERSATION,
      inboxPlacement: true,
      dispatchOrigin: 'task-dispatch',
    });
  });

  test('the same entry placed on a Session with no Task binding is unknown', async () => {
    const { place } = await port();
    const placed = await place('session-unbound', {
      message: 'wake',
      actor,
      clientOrigin: origin({ kind: 'internal' }),
    });
    expect(placed.input.dispatchOrigin).toBe('unknown');
  });

  test("a person's queued follow-up is interactive even on a Task-bound Session", async () => {
    const { place } = await port();
    const placed = await place(BOUND_SESSION, {
      message: 'next',
      actor,
      clientOrigin: origin({ kind: 'operator' }),
    });
    expect(placed.input.dispatchOrigin).toBe('interactive');
  });
});

describe('scheduled Automation dedicated start port (#4512)', () => {
  test("the first run's foreground send is classified automation, with Station's framed origin", async () => {
    const calls: Array<{ input: Record<string, unknown>; context: unknown }> =
      [];
    const start = scheduledDedicatedStartPort({
      execute: async (input, context) => {
        calls.push({ input: input as never, context });
        return {
          conversationId: 'dedicated-1',
          sessionId: 'dedicated-1',
          providerTurnId: 'turn-1',
        } as never;
      },
      readAuthorityForExecution: (userId) => ({ userId }) as never,
    });
    await expect(
      start({
        conversationId: 'dedicated-1',
        agent: 'ops-bot',
        message: 'run',
        clientTurnId: 'scheduler:run-1',
        actor: { userId: 'owner' },
      }),
    ).resolves.toEqual({
      conversationId: 'dedicated-1',
      sessionId: 'dedicated-1',
      turnId: 'turn-1',
    });
    expect(calls[0]!.context).toEqual({ dispatchOrigin: 'automation' });
    expect(calls[0]!.input).toMatchObject({
      clientOrigin: { actor: { kind: 'internal' } },
      fullAccessGrant: null,
    });
  });
});

describe('delegated result start port (#4512)', () => {
  test("a child's result delivered into a Task-bound parent Session is delegation, not task-dispatch", async () => {
    const store = new EventStore(
      join(makeTempDir('station-start-ports-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    expect(
      await store.bindProjectTaskRoomExecution({
        projectId: 'project-1',
        taskId: 'task-1',
        sessionId: BOUND_SESSION,
      }),
    ).toEqual({ kind: 'bound' });
    const continued: RecordedActorContinuation[] = [];
    const deliver = delegationResultStartPort({
      origin: origin({ kind: 'internal' }),
      readProjectTaskRoomExecutionBinding: (sessionId) =>
        store.readProjectTaskRoomExecutionBinding(sessionId),
      continueAsRecordedActor: async (input, threadId) => {
        continued.push(input);
        return {
          outcome: 'started',
          conversationId: input.conversationId,
          sessionId: threadId,
          turnId: 'turn-1',
        };
      },
    });
    await deliver({
      parentConversationId: CONVERSATION,
      threadId: BOUND_SESSION,
      actor: { userId: 'owner', attribution: 'verified-bound' },
      sender: { kind: 'delegation-result', sessionId: 'child-1' },
      text: 'The child finished.',
      clientTurnId: 'delegation-result:child-1',
    });
    expect(continued[0]).toMatchObject({
      conversationId: CONVERSATION,
      clientOrigin: {
        actor: { kind: 'internal' },
        sender: { kind: 'delegation-result', sessionId: 'child-1' },
      },
      dispatchOrigin: 'delegation',
    });
  });
});

describe("a delegated result into a parent that is not a Task's (#4512 review)", () => {
  async function deliverInto(
    metadata: Record<string, unknown>,
    priorTurn: Record<string, unknown> | undefined,
  ) {
    const store = new EventStore(
      join(makeTempDir('station-start-ports-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    store.appendEvent({
      eventId: 'started',
      provider: 'claude',
      threadId: 'parent',
      sessionId: 'parent',
      createdAt: '2026-11-04T00:00:00.000Z',
      method: 'session.started',
      metadata,
    } as never);
    if (priorTurn)
      store.appendEvent({
        eventId: 'prior',
        provider: 'claude',
        threadId: 'parent',
        createdAt: '2026-11-04T00:00:01.000Z',
        method: 'turn.started',
        turnId: 'turn-prior',
        ...priorTurn,
      } as never);
    const continued: RecordedActorContinuation[] = [];
    await delegationResultStartPort({
      origin: origin({ kind: 'internal' }),
      readProjectTaskRoomExecutionBinding: (sessionId) =>
        store.readProjectTaskRoomExecutionBinding(sessionId),
      sessionFacts: (sessionId) => readSessionDispatchFacts(store, sessionId),
      continueAsRecordedActor: async (input, threadId) => {
        continued.push(input);
        return {
          outcome: 'started',
          conversationId: input.conversationId,
          sessionId: threadId,
          turnId: 'turn-1',
        };
      },
    })({
      parentConversationId: 'parent',
      threadId: 'parent',
      actor: { userId: 'owner', attribution: 'verified-bound' },
      sender: { kind: 'delegation-result', sessionId: 'child-1' },
      text: 'The child finished.',
      clientTurnId: 'delegation-result:child-1',
    });
    return continued[0]!.dispatchOrigin;
  }

  test("into a person's own chat it inherits the person's turn, interactive", async () => {
    expect(
      await deliverInto(
        { userId: 'owner' },
        {
          dispatchOrigin: 'interactive',
          clientOrigin: origin({ kind: 'operator' }),
        },
      ),
    ).toBe('interactive');
  });

  test('into a delegated child Station derived it is delegation', async () => {
    expect(
      await deliverInto(
        {
          userId: 'owner',
          delegation: { mode: 'isolated-child', depth: 1, maxDepth: 2 },
          stationDelegationProvenance: 'caller-derived',
        },
        { dispatchOrigin: 'delegation' },
      ),
    ).toBe('delegation');
  });

  test("a requester's own delegation claim does not make the chat unattended", async () => {
    expect(
      await deliverInto(
        {
          userId: 'owner',
          delegation: { mode: 'isolated-child', depth: 1, maxDepth: 2 },
          stationDelegationProvenance: 'direct-claim',
        },
        {
          dispatchOrigin: 'interactive',
          clientOrigin: origin({ kind: 'operator' }),
        },
      ),
    ).toBe('interactive');
  });
});

/**
 * #4827 fix round 2: a message a person typed and queued keeps its mark
 * through the inbox, so placement stamps the turn as theirs; nothing else
 * placed from the inbox is marked.
 */
describe('a queued message keeps whether a person typed it (#4827)', () => {
  const person = origin({ kind: 'operator' });

  test('placement forwards the mark of an entry a person typed', async () => {
    const { place } = await port();
    const placed = await place('session-unbound', {
      message: 'Then force-push it.',
      actor,
      clientOrigin: person,
      authoredBy: 'person',
    });
    expect(placed.input.personAuthored).toBe(true);
  });

  test.each([
    ['an unmarked entry from a person credential', { clientOrigin: person }],
    [
      "a child's result",
      {
        clientOrigin: origin(
          { kind: 'internal' },
          { kind: 'delegation-result', sessionId: 'child' },
        ),
      },
    ],
  ])('placement does not mark %s', async (_label, extra) => {
    const { place } = await port();
    const placed = await place('session-unbound', {
      message: 'm',
      actor,
      ...extra,
    });
    expect(placed.input.personAuthored).toBeUndefined();
  });

  test('a stored entry keeps the mark and reads back nothing else as one', async () => {
    const { decodePayload } = await import(
      '../../../services/orchestration/thread-inbox.js'
    );
    const store = new EventStore(
      join(makeTempDir('station-start-ports-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    const inbox = store.threadInboxStore();
    for (const [key, authoredBy] of [
      ['marked', 'person'],
      ['forged', 'agent'],
    ] as const)
      inbox.submit({
        conversationId: 'c',
        clientTurnId: key,
        payload: {
          message: 'm',
          actor,
          clientOrigin: person,
          authoredBy: authoredBy as 'person',
        },
        now: Date.now(),
      });
    const read = (key: string) =>
      decodePayload(inbox.read('c', key)!.payload)?.authoredBy;
    expect(read('marked')).toBe('person');
    expect(read('forged')).toBeUndefined();
  });
});
