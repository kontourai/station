/**
 * @vitest-environment jsdom
 *
 * #2307: the orchestration event stream writes into the `QueryClient` of the
 * authority it belongs to, and that client reaches it through the REAL
 * `ChatWorkspacePane` mount — nothing below hands the stream a client.
 *
 * Only the SSE transport (`fetchSSE`), data sources and display-only children
 * are stood in for. The stream module, snapshot handling, the reconnect
 * refetch (`rehydrateChatSession` → `conversationsStore.refreshMessages`) and
 * the chat store are real. `AuthorityQueryProvider` is modelled by what it
 * does to this subtree: a `QueryClientProvider` keyed per namespace, with
 * nothing rendered while a switch is being verified.
 */
import {
  ORCHESTRATION_STREAM_CAUGHT_UP_EVENT,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { ActiveChatsProvider } from '../../../contexts/ActiveChatsContext';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { ConversationsProvider } from '../../../contexts/ConversationsContext';
import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { RegionModelProvider } from '../../../contexts/RegionModelContext';
import { ToastProvider } from '../../../contexts/ToastContext';
import { resetSessionReadModelRefreshForTests } from '../../../hooks/orchestration/ensureOrchestrationEventStream';

type StreamOptions = {
  onMessage: (raw: { event: string; data: string; id?: string }) => void;
};

const { streams, current } = vi.hoisted(() => ({
  /** The orchestration stream's options, per events URL. */
  streams: new Map<string, StreamOptions>(),
  current: { apiBase: 'http://station-2307.test' },
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
}));
vi.mock('../../modals/NewChatModal', () => ({ NewChatModal: () => null }));
vi.mock('../../../hooks/useActiveChatSessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRehydrateSessions: () => vi.fn(),
  useOpenConversation: () => vi.fn(),
}));
vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useApiBase: () => ({ apiBase: current.apiBase }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../../../contexts/ProjectsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjects: () => ({
    projects: [{ slug: 'pulse', name: 'Pulse' }],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: () => ({ project: undefined, isLoading: false }),
}));
vi.mock('../../../contexts/AgentsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgents: () => [{ slug: 'assistant', name: 'Assistant' }],
  useAgentsLoaded: () => true,
}));
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConnections: () => ({ captureCredentialEvidence: () => null }),
}));

const { ChatWorkspacePane } = await import('../ChatDock');

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, data: [] })),
  );
});

let apiBaseSequence = 0;
beforeEach(() => {
  // Each test gets its own Station: the stream is module-scoped per apiBase.
  apiBaseSequence += 1;
  current.apiBase = `http://station-2307-${apiBaseSequence}.test`;
  resetSessionReadModelRefreshForTests();
});

afterEach(() => {
  cleanup();
  for (const sessionId of Object.keys(activeChatsStore.getSnapshot()))
    activeChatsStore.removeChat(sessionId);
});

function authorityClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** One authority's protected subtree; `null` is the verification gap. */
function tree(authority: { namespace: string; client: QueryClient } | null) {
  if (!authority) return <div />;
  return (
    <QueryClientProvider key={authority.namespace} client={authority.client}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <ToastProvider>
            <ConversationsProvider>
              <ActiveChatsProvider>
                <RegionModelProvider>
                  <ChatWorkspacePane
                    placement="fullscreen"
                    projectSlug="pulse"
                    layoutSlug="coding"
                  />
                </RegionModelProvider>
              </ActiveChatsProvider>
            </ConversationsProvider>
          </ToastProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>
  );
}

function stream(): StreamOptions {
  const options = streams.get(`${current.apiBase}/api/orchestration/events`);
  if (!options) throw new Error('the pane opened no orchestration stream');
  return options;
}

let frameId = 0;
function deliverFact(method: string) {
  frameId += 1;
  act(() => {
    stream().onMessage({
      event: SERVER_EVENTS.ORCHESTRATION_EVENT,
      id: String(frameId),
      data: JSON.stringify({
        event: {
          eventId: `evt-${frameId}`,
          threadId: 'claude:untracked-2307',
          method,
          createdAt: '2026-09-23T00:00:00.000Z',
          message: 'Claude Code process terminated by signal SIGKILL',
        },
      }),
    });
  });
}

function deliverSnapshot(sessions: unknown[]) {
  frameId += 1;
  act(() => {
    stream().onMessage({
      event: 'orchestration:snapshot',
      id: String(frameId),
      data: JSON.stringify({ sessions }),
    });
    stream().onMessage({
      event: ORCHESTRATION_STREAM_CAUGHT_UP_EVENT,
      data: '',
    });
  });
}

const SESSIONS_KEY = { queryKey: ['orchestration-sessions'] };

function sessionReadModelInvalidations(
  spy: ReturnType<typeof vi.spyOn>,
): number {
  return spy.mock.calls.filter(
    ([filters]: unknown[]) =>
      JSON.stringify((filters as { queryKey?: unknown })?.queryKey) ===
      JSON.stringify(SESSIONS_KEY.queryKey),
  ).length;
}

const pastTheThrottleWindow = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 1100)));

test('a session-ending event invalidates the session read-model on the client the mounted pane registered', async () => {
  const client = authorityClient();
  render(tree({ namespace: 'authority-a', client }));
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  invalidate.mockClear();

  deliverFact('runtime.error');

  expect(sessionReadModelInvalidations(invalidate)).toBe(1);
  expect(invalidate).toHaveBeenCalledWith(SESSIONS_KEY);
});

test('an authority switch routes later invalidations to the new client and never to the retired one', async () => {
  const clientA = authorityClient();
  const clientB = authorityClient();
  const { rerender } = render(
    tree({ namespace: 'authority-a', client: clientA }),
  );
  const invalidateA = vi.spyOn(clientA, 'invalidateQueries');
  const invalidateB = vi.spyOn(clientB, 'invalidateQueries');
  invalidateA.mockClear();

  deliverFact('session.exited');
  expect(sessionReadModelInvalidations(invalidateA)).toBe(1);
  // Inside the throttle window: deferred, and scheduled while A is current.
  deliverFact('turn.completed');
  expect(sessionReadModelInvalidations(invalidateA)).toBe(1);

  // The switch starts: `AuthorityQueryProvider` drops A's subtree while it
  // verifies the next authority. The deferred refresh fires in that gap, and
  // so does a fresh fact; A is retired, so neither may reach it.
  rerender(tree(null));
  await pastTheThrottleWindow();
  deliverFact('runtime.error');
  await pastTheThrottleWindow();
  expect(sessionReadModelInvalidations(invalidateA)).toBe(1);

  rerender(tree({ namespace: 'authority-b', client: clientB }));
  invalidateB.mockClear();
  deliverFact('session.exited');

  expect(sessionReadModelInvalidations(invalidateB)).toBe(1);
  expect(sessionReadModelInvalidations(invalidateA)).toBe(1);
});

test("the reconnect-fallback refetch reads tool names from the current authority's client, not the one the stream was opened under", async () => {
  const clientA = authorityClient();
  const clientB = authorityClient();
  const { rerender } = render(
    tree({ namespace: 'authority-a', client: clientA }),
  );
  // The connect-time snapshot: the stream now belongs to this document.
  deliverSnapshot([]);

  rerender(tree(null));
  rerender(tree({ namespace: 'authority-b', client: clientB }));
  // A tracked chat this client did not yet know had an orchestration session
  // — the one case `applyOrchestrationSnapshot`'s refetch still serves.
  act(() => {
    activeChatsStore.initChat('thread-2307', {
      agentSlug: 'agent-2307',
      agentName: 'Agent 2307',
      title: 'Session',
      conversationId: 'thread-2307',
    });
    activeChatsStore.updateChat('thread-2307', { provider: 'claude' });
  });
  const toolsA = vi.spyOn(clientA, 'getQueryData');
  const toolsB = vi.spyOn(clientB, 'getQueryData');

  // A second snapshot on the same stream is the server's reconnect fallback.
  deliverSnapshot([
    { provider: 'claude', threadId: 'thread-2307', status: 'idle' },
  ]);

  expect(toolsB).toHaveBeenCalledWith(['agentTools', 'agent-2307']);
  expect(toolsA).not.toHaveBeenCalledWith(['agentTools', 'agent-2307']);
});
