/** @vitest-environment jsdom */

import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../../../../../packages/sdk/src/client/http';

vi.mock('../../../../../packages/sdk/src/client/project-room-live', async (original) => ({
  ...(await original<
    typeof import('../../../../../packages/sdk/src/client/project-room-live')
  >()),
  readProjectRoomLiveCapability: async () => true,
}));
const { ProjectConversationList } = await import('../ProjectConversationList');

const API = 'https://live-list.example';
const general = '11111111-1111-4111-8111-111111111111';
const design = '22222222-2222-4222-8222-222222222222';
let streams: ReadableStreamDefaultController<Uint8Array>[];
let liveRequests: string[][];
let summaries: number;
let mentioned: boolean;

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
  _setApiBase(API);
  setClientCredentialResolver(() => ({
    origin: API,
    requestAuthority: { apiBase: API, authorityKey: 'one', isCurrent: () => true },
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
      if (url.pathname === '/api/tasks') return ok([]);
      if (url.pathname === '/api/agents') return ok([]);
      if (url.pathname === '/api/orchestration/sessions/read-model') return ok([]);
      if (url.pathname === '/api/read-markers/summary') {
        summaries += 1;
        const { targets } = JSON.parse(String(init?.body)) as {
          targets: Array<{ roomId: string }>;
        };
        return ok({
          items: targets.map((target) => ({
            target,
            latestVersion: 3,
            seenVersion: target.roomId === general ? 1 : 3,
            unread: target.roomId === general,
            unreadCount: target.roomId === general ? 2 : 0,
            ...(target.roomId === general && mentioned ? { mentioned: true } : {}),
          })),
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
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
  // The request settles: the mark goes with it.
  push(design, 'agents', { requests: [] });
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
