// @vitest-environment jsdom

import type { CoordinationChild } from '@kontourai/station-contracts/orchestration';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  sessionInventoryLiveItems,
  useSessionInventoryLive,
} from '../useSessionInventoryLive';

const readModel = vi.hoisted(() => ({
  sessions: undefined as readonly OrchestrationSessionSummary[] | undefined,
}));
// The Session read model is the hook's only remote input.
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({ data: readModel.sessions }),
}));

const ORIGIN = '0f0e0d0c-0000-4000-8000-000000000001';
const OTHER = '0f0e0d0c-0000-4000-8000-000000000002';
const STARTED_CHAT = '01a21af3-40b5-7513-83d5-0950bb1a123e';
const UNLISTED_CHAT = 'a1b2c3d4-0000-4000-8000-000000000009';

function session(
  threadId: string,
  over: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    threadId,
    provider: 'claude',
    status: 'ready',
    createdAt: '2026-11-26T17:00:00.000Z',
    updatedAt: '2026-11-26T17:05:00.000Z',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    ...over,
  };
}

function waitingOn(
  threadId: string,
  children: readonly CoordinationChild[],
): OrchestrationSessionSummary {
  return session(threadId, {
    coordination: {
      waiting: children.filter((child) => child.waiting).length,
      children,
    },
  });
}

/** What the open Chat inventory of `sessionId` lists under Live now. */
function liveItems(sessionId: string) {
  const { result } = renderHook(() =>
    useSessionInventoryLive(
      {
        apiBase: 'http://station.test',
        authorityKey: 'test',
        isCurrent: () => true,
      },
      sessionId,
    ),
  );
  return sessionInventoryLiveItems(result.current);
}

const STARTED_CHAT_TITLE = 'Check the Inbox row';
const STARTED: CoordinationChild = {
  id: 'watch-chat',
  waiting: true,
  kind: 'session',
  sessionId: STARTED_CHAT,
};

test.each([
  [
    'a chat in the read model by its title',
    STARTED,
    `Waiting on ${STARTED_CHAT_TITLE}`,
  ],
  [
    'a chat the caller cannot list by a short id',
    { ...STARTED, sessionId: UNLISTED_CHAT },
    `Waiting on Session ${UNLISTED_CHAT.slice(0, 8)}`,
  ],
  [
    'a pull request by number',
    {
      id: 'watch-pr',
      waiting: true,
      kind: 'pull-request',
      identity: {
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        ref: '72',
      },
    },
    'Waiting on kontourai/station #72',
  ],
] as const)('Live now names %s', (_, child, label) => {
  readModel.sessions = [
    waitingOn(ORIGIN, [child]),
    session(STARTED_CHAT, { displayTitle: STARTED_CHAT_TITLE }),
  ];
  expect(liveItems(ORIGIN).map((item) => item.label)).toEqual([label]);
});

test('Live now leaves out a delegated task and work no longer waited on', () => {
  readModel.sessions = [
    waitingOn(ORIGIN, [
      { ...STARTED, id: 'delegate', kind: 'delegation' },
      { ...STARTED, waiting: false },
    ]),
    session(STARTED_CHAT, { displayTitle: STARTED_CHAT_TITLE }),
  ];
  expect(liveItems(ORIGIN)).toEqual([]);
});

test('Live now does not list what another Session is waiting on', () => {
  readModel.sessions = [
    waitingOn(OTHER, [STARTED]),
    session(ORIGIN),
    session(STARTED_CHAT, { displayTitle: STARTED_CHAT_TITLE }),
  ];
  expect(liveItems(ORIGIN)).toEqual([]);
});
