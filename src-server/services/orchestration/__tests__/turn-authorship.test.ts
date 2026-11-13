import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { DELEGATION_RESULT_CLIENT_ORIGIN } from '../delegation-result-delivery.js';
import { EventStore } from '../event-store.js';
import {
  isCurrentTurnPersonAuthored,
  isInvocationTurnPersonAuthored,
  isPersonAuthoredTurn,
} from '../turn-authorship.js';

/**
 * #4827: the shared answer to "did a person type this turn". The guardian
 * reads it, and so must any guard that lets only a person-started turn act
 * (#4850's agent-proposed automations).
 */
const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function openStore() {
  const store = new EventStore(
    join(makeTempDir('station-turn-authorship-'), 'events.sqlite'),
  );
  stores.push(store);
  return store;
}

const person: ClientOrigin = {
  version: 1,
  actor: { kind: 'operator' },
  reported: { version: 1, surface: 'web', build: null },
};
const peerDevice: ClientOrigin = {
  ...person,
  actor: { kind: 'device', deviceId: 'peer-grant' },
};
const childResult: ClientOrigin = {
  ...DELEGATION_RESULT_CLIENT_ORIGIN,
  sender: { kind: 'delegation-result', sessionId: 'child' },
};

type Shape = Partial<
  Extract<CanonicalRuntimeEvent, { method: 'turn.started' }>
>;
/** Each shape as Station's writers stamp it, and whether it is the person. */
const SHAPES: Array<[string, Shape, boolean]> = [
  [
    'a composer send',
    {
      clientOrigin: person,
      dispatchOrigin: 'interactive',
      authoredBy: 'person',
    },
    true,
  ],
  [
    'a composer steer',
    { clientOrigin: person, inputKind: 'steer', authoredBy: 'person' },
    true,
  ],
  [
    "a child's result continuing in the person's chat",
    { clientOrigin: childResult, dispatchOrigin: 'interactive' },
    false,
  ],
  [
    "a peer Station's delegation (device actor, no sender)",
    { clientOrigin: peerDevice, dispatchOrigin: 'unknown' },
    false,
  ],
  [
    'an operator send the composer did not mark (CLI, background)',
    { clientOrigin: person, dispatchOrigin: 'interactive' },
    false,
  ],
  [
    'an MCP prompt expansion',
    {
      clientOrigin: person,
      dispatchOrigin: 'interactive',
      promptSource: 'mcp-prompt',
      authoredBy: 'person',
    },
    false,
  ],
  [
    'a marked turn that also names a sender',
    { clientOrigin: childResult, authoredBy: 'person' },
    false,
  ],
  ['a turn recorded before the mark', {}, false],
];

function started(
  threadId: string,
  turnId: string,
  shape: Shape,
  createdAt: string,
): CanonicalRuntimeEvent {
  return {
    eventId: `${threadId}:${turnId}:${shape.inputKind ?? 'start'}`,
    provider: 'claude',
    threadId,
    turnId,
    createdAt,
    method: 'turn.started',
    prompt: `prompt of ${threadId}`,
    ...shape,
  } as CanonicalRuntimeEvent;
}

describe('isPersonAuthoredTurn', () => {
  test.each(SHAPES)('%s → %s', (_label, shape, expected) => {
    expect(
      isPersonAuthoredTurn(started('t', 'turn', shape, '2026-11-12T00:00:00Z')),
    ).toBe(expected);
  });

  test('a non-start event is never a person turn', () => {
    expect(
      isPersonAuthoredTurn({
        method: 'turn.completed',
        authoredBy: 'person',
      } as never),
    ).toBe(false);
  });

  test('the store selects exactly what the predicate accepts', () => {
    const store = openStore();
    for (const [index, [, shape, expected]] of SHAPES.entries()) {
      const threadId = `shape-${index}`;
      store.appendEvent(
        started(threadId, 'turn', shape, `2026-11-12T00:00:0${index}Z`),
      );
      expect(store.personAuthoredTurnPrompts([threadId], 1).length > 0).toBe(
        expected,
      );
    }
  });
});

describe('isCurrentTurnPersonAuthored', () => {
  const at = (n: number) => `2026-11-12T00:00:${String(n).padStart(2, '0')}Z`;

  test("a child's result continuing in the person's chat is not person-started (#4850's case)", () => {
    const store = openStore();
    store.appendEvent(started('chat', 'turn-1', SHAPES[0]![1], at(1)));
    expect(isCurrentTurnPersonAuthored(store, 'chat')).toBe(true);
    store.appendEvent(started('chat', 'turn-2', SHAPES[2]![1], at(2)));
    expect(isCurrentTurnPersonAuthored(store, 'chat')).toBe(false);
  });

  test("the turn's own start decides, not a steer into it", () => {
    const store = openStore();
    store.appendEvent(started('agent-run', 'turn-1', SHAPES[3]![1], at(1)));
    store.appendEvent(started('agent-run', 'turn-1', SHAPES[1]![1], at(2)));
    expect(isCurrentTurnPersonAuthored(store, 'agent-run')).toBe(false);

    store.appendEvent(started('person-run', 'turn-1', SHAPES[0]![1], at(3)));
    store.appendEvent(
      started('person-run', 'turn-1', { inputKind: 'steer' }, at(4)),
    );
    expect(isCurrentTurnPersonAuthored(store, 'person-run')).toBe(true);
  });

  test('no turn, or no orchestration thread, is not person-started', () => {
    const store = openStore();
    expect(isCurrentTurnPersonAuthored(store, 'empty')).toBe(false);
    expect(isInvocationTurnPersonAuthored(store, {})).toBe(false);
    store.appendEvent(started('thread', 'turn-1', SHAPES[0]![1], at(1)));
    expect(
      isInvocationTurnPersonAuthored(store, { conversationId: 'thread' }),
    ).toBe(true);
  });
});
