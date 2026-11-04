import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import type { ThreadInboxPayload } from '../../../services/orchestration/thread-inbox.js';
import {
  inboxPlacementStartPort,
  type RecordedActorContinuation,
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
