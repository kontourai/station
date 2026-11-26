/** @vitest-environment jsdom */

import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../../../../../packages/sdk/src/client/http';

vi.mock(
  '../../../../../packages/sdk/src/client/project-room-live',
  async (original) => ({
    ...(await original<
      typeof import('../../../../../packages/sdk/src/client/project-room-live')
    >()),
    readProjectRoomLiveCapability: async () => true,
  }),
);
const { ProjectConversationList } = await import('../ProjectConversationList');

const API = 'https://live-list.example';
const general = '11111111-1111-4111-8111-111111111111';
const design = '22222222-2222-4222-8222-222222222222';
let streams: ReadableStreamDefaultController<Uint8Array>[];
let liveRequests: string[][];
let summaries: number;
let mentioned: boolean;
let memberSummaryTargets: string[];
let ownerInventoryReads: string[];
const readableTask = 'task-room-readable';
const refusedTask = 'task-room-refused';

function push(key: string, event: string, data: Record<string, unknown>) {
  for (const stream of streams)
    stream.enqueue(
      new TextEncoder().encode(
        `event: ${event}\ndata: ${JSON.stringify({ key, ...data })}\n\n`,
      ),
    );
}
beforeEach(() => {
  streams = [];
  liveRequests = [];
  summaries = 0;
  mentioned = false;
  memberSummaryTargets = [];
  ownerInventoryReads = [];
  _setApiBase(API);
  setClientCredentialResolver(() => ({
    origin: API,
    requestAuthority: {
      apiBase: API,
      authorityKey: 'one',
      isCurrent: () => true,
    },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const ok = (data: unknown) => Response.json({ success: true, data });
      if (url.pathname === '/api/projects/team/channels')
        return ok({
          channels: [
            { channelId: general, name: 'general', isDefault: true },
            { channelId: design, name: 'design', isDefault: false },
          ],
        });
      if (url.pathname === '/api/projects/team/rooms/live') {
        liveRequests.push(url.searchParams.getAll('channel'));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (
        url.pathname === '/api/tasks' ||
        url.pathname === '/api/orchestration/sessions/read-model'
      ) {
        ownerInventoryReads.push(url.pathname);
        return ok([]);
      }
      if (url.pathname === '/api/agents') return ok([]);
      if (url.pathname === '/api/read-markers/summary') {
        summaries += 1;
        const { targets } = JSON.parse(String(init?.body)) as {
          targets: Array<{ roomId?: string; taskId?: string }>;
        };
        memberSummaryTargets = targets.flatMap((target) =>
          target.taskId === undefined ? [] : [target.taskId],
        );
        return ok({
          items: targets.map((target) =>
            target.taskId === refusedTask
              ? { target, unavailable: true }
              : {
                  target,
                  latestVersion: 3,
                  seenVersion:
                    target.roomId === general || target.taskId === readableTask
                      ? 1
                      : 3,
                  unread:
                    target.roomId === general || target.taskId === readableTask,
                  unreadCount:
                    target.roomId === general || target.taskId === readableTask
                      ? 2
                      : 0,
                  ...(target.roomId === general && mentioned
                    ? { mentioned: true }
                    : {}),
                },
          ),
        });
      }
      return new Response('Not Found', { status: 404 });
    }),
  );
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 80));
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  _setApiBase('');
});

test('every channel rides one connection; a working Agent and a mention of the reader mark their rows', async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProjectConversationList
        project={{ slug: 'team', id: 'project-team', name: 'Team' }}
        requestScope={{ apiBase: API, authorityKey: 'one' }}
        variant="sidebar"
        onOpenChannel={() => {}}
        onOpenTask={() => {}}
        onMoreTasks={() => {}}
        onNewChannel={() => {}}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'general, 2 unread' });
  await waitFor(() => expect(liveRequests).toHaveLength(1));
  expect([...liveRequests[0]!].sort()).toEqual([general, design].sort());
  push(design, 'subscribed', { roomId: design, lastSeq: 3, activity: 0 });
  push(design, 'agents', {
    requests: [
      {
        requestId: '33333333-3333-4333-8333-333333333333',
        agentId: 'writer',
        actor: { id: 'human:x:lin', displayName: 'Lin', kind: 'person' },
        state: 'started',
        createdAt: '2026-11-15T12:00:00.000Z',
        updatedAt: '2026-11-15T12:00:00.000Z',
      },
    ],
  });
  await screen.findByRole('button', { name: 'design, agent working' });
  // The request settles (its answer posted): the mark goes with it, though
  // the record is still listed.
  push(design, 'agents', {
    requests: [
      {
        requestId: '33333333-3333-4333-8333-333333333333',
        agentId: 'writer',
        actor: { id: 'human:x:lin', displayName: 'Lin', kind: 'person' },
        state: 'published',
        createdAt: '2026-11-15T12:00:00.000Z',
        updatedAt: '2026-11-15T12:01:00.000Z',
      },
    ],
  });
  await screen.findByRole('button', { name: 'design' });
  // A new message in #general re-reads the summary, which now says the
  // reader is mentioned.
  mentioned = true;
  const before = summaries;
  push(general, 'subscribed', { roomId: general, lastSeq: 3, activity: 0 });
  push(general, 'resync', { lastSeq: 4, activity: 0 });
  await waitFor(() => expect(summaries).toBeGreaterThan(before));
  await screen.findByRole('button', {
    name: 'general, 2 unread, mentions you',
  });
  expect(liveRequests).toHaveLength(1);
});

test('a message that lands while the stream is connecting still marks its row', async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProjectConversationList
        project={{ slug: 'team', id: 'project-team', name: 'Team' }}
        requestScope={{ apiBase: API, authorityKey: 'one' }}
        variant="sidebar"
        onOpenChannel={() => {}}
        onOpenTask={() => {}}
        onMoreTasks={() => {}}
        onNewChannel={() => {}}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'general, 2 unread' });
  await waitFor(() => expect(liveRequests).toHaveLength(1));
  const before = summaries;
  // The message committed after the summary was read and before the
  // server announced the room: it is in `subscribed`, never an `append`.
  mentioned = true;
  push(general, 'subscribed', { roomId: general, lastSeq: 4, activity: 0 });
  await waitFor(() => expect(summaries).toBeGreaterThan(before), {
    timeout: 3000,
  });
  await screen.findByRole('button', {
    name: 'general, 2 unread, mentions you',
  });
});

test('a member lists only shared Tasks whose room the member can read', async () => {
  _setApiBase('https://operator-inventory.example');
  const sharedAt = '2026-11-15T12:00:00Z';
  const publications: ProjectSharedTaskSummary[] = [
    [readableTask, 'Shared work room', '11111111-1111-4111-8111-111111111112'],
    [
      refusedTask,
      'Unavailable work room',
      '11111111-1111-4111-8111-111111111113',
    ],
  ].map(([id, title, shareId]) => ({
    version: 'station.shared-project-task/v1',
    project: {
      stationId: 'station',
      localProjectId: 'project-team',
      localProjectSlug: 'team',
      portableProjectId: 'portable-team',
    },
    task: { id, title, status: 'todo', createdAt: sharedAt },
    sharedAt,
    shareId,
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectConversationList
        project={{ slug: 'team', id: 'project-team', name: 'Team' }}
        requestScope={{ apiBase: API, authorityKey: 'one' }}
        member={{
          tasks: {
            data: publications,
            isPending: false,
            isError: false,
            refetch: vi.fn(),
          },
          isCurrent: () => true,
        }}
        variant="page"
        onOpenChannel={() => {}}
        onOpenTask={() => {}}
        onMoreTasks={() => {}}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', {
    name: 'Shared work room, Task room, 2 unread',
  });
  expect(
    screen.queryByRole('button', { name: /Unavailable work room/ }),
  ).toBeNull();
  expect(memberSummaryTargets).toEqual([readableTask, refusedTask]);
  expect(ownerInventoryReads).toEqual([]);
});
