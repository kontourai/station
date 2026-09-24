// @vitest-environment jsdom

/**
 * #2459 L1: the Agents pane must see a delegate that starts AFTER it
 * mounted, with no Chat dock mounted anywhere.
 *
 * The stream refreshes the session read model through the QueryClient
 * REGISTERED for its apiBase (#2307). Only `ChatDock` registered one, so with
 * Agents as a tab beside an unselected Chat the pane's sessions query was
 * fetched once and never again, and a CLI delegate never appeared.
 *
 * Real here: the stream module, its fact → invalidation path, React Query,
 * and the pane. Stood in: the SSE transport (`fetchSSE`), the Station behind
 * the sessions query (a mutable list), navigation and `useApiBase`. No
 * ChatDock is rendered.
 */

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type StreamOptions = {
  onMessage: (raw: { event: string; data: string; id?: string }) => void;
};

const { streams, server, current } = vi.hoisted(() => ({
  streams: new Map<string, StreamOptions>(),
  /** What the Station's session read model returns right now. */
  server: { sessions: [] as unknown[] },
  current: { apiBase: 'http://station-2459.test' },
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchSSE: (url: string, options: StreamOptions) => {
    streams.set(url, options);
    return {
      close: vi.fn(),
      retry: vi.fn(),
      signal: new AbortController().signal,
      completed: new Promise<void>(() => undefined),
    };
  },
  // The real hook's key and staleTime (`orchestrationQueries.sessions()`);
  // the read goes to the stand-in Station.
  useOrchestrationSessionsQuery: () =>
    useQuery({
      queryKey: ['orchestration-sessions'],
      queryFn: async () => structuredClone(server.sessions),
      staleTime: 10_000,
    }),
}));
vi.mock('../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useApiBase: () => ({ apiBase: current.apiBase }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: (selector: (state: { activeChat: null }) => unknown) =>
    selector({ activeChat: null }),
}));
vi.mock('../../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
}));

import { resetSessionReadModelRefreshForTests } from '../../hooks/orchestration/ensureOrchestrationEventStream';
import { AgentsWorkspacePane } from '../AgentsWorkspacePane';

let apiBaseSequence = 0;
beforeEach(() => {
  // The stream is module-scoped per apiBase: each test gets its own Station.
  apiBaseSequence += 1;
  current.apiBase = `http://station-2459-${apiBaseSequence}.test`;
  server.sessions = [];
  resetSessionReadModelRefreshForTests();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

function cliDelegate(threadId: string) {
  return {
    threadId,
    provider: 'codex',
    childWork: {
      asChild: {
        producer: 'station-delegate',
        reporterThreadId: threadId,
        childId: threadId,
        status: 'running',
        title: 'Arrived after mount',
        result: { handle: { kind: 'session', threadId } },
        controls: { stop: 'delegate-interrupt' },
      },
    },
  };
}

test('a delegate that starts after the pane mounted appears, with no Chat dock mounted', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentsWorkspacePane />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('No agent work yet')).toBeTruthy();

  const stream = streams.get(`${current.apiBase}/api/orchestration/events`);
  // The pane itself ensures the stream (and registers its client with it).
  expect(stream).toBeDefined();

  // The delegate now exists on the Station, and its first turn is a fact.
  server.sessions = [cliDelegate('delegate-late')];
  act(() => {
    stream?.onMessage({
      event: SERVER_EVENTS.ORCHESTRATION_EVENT,
      id: '1',
      data: JSON.stringify({
        event: {
          eventId: 'evt-1',
          threadId: 'delegate-late',
          provider: 'codex',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'Arrived after mount',
          createdAt: '2026-09-24T00:00:00.000Z',
        },
      }),
    });
  });

  expect(await screen.findByText('Arrived after mount')).toBeTruthy();
  expect(screen.getByText('Running (1)')).toBeTruthy();
});

test('work that started while the pane was closed appears when it mounts over a fresh cached list', async () => {
  // A cached, still-fresh session list (another surface read it moments
  // ago), and a client that does not refetch on mount.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  client.setQueryData(['orchestration-sessions'], []);
  // The delegate started while no Agents pane was mounted.
  server.sessions = [cliDelegate('delegate-before-mount')];
  render(
    <QueryClientProvider client={client}>
      <AgentsWorkspacePane />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Arrived after mount')).toBeTruthy();
});
