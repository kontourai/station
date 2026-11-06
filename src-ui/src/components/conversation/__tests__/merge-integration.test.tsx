// @vitest-environment jsdom
import type { ChildWorkDelta } from '@kontourai/station-contracts/child-work';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { stationPartitionKey } from '../../../connections/station-state';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../../contexts/background-tasks-store';
import { childWorkGlobalStore } from '../../../contexts/child-work-global-store';
import { ManagedPolicyContext } from '../../../contexts/ManagedPolicyContext';
import { handleOrchestrationEvent } from '../../../hooks/orchestration/eventHandlers';
import { applyOrchestrationSnapshot } from '../../../hooks/orchestration/snapshotHandlers';
import {
  useChatBackgroundTasks,
  useChatStoreKey,
} from '../../../hooks/useBackgroundTasks';
import { ComposerModeSheet } from '../../badges/ComposerModeSheet';
import { DialogHistoryHostBoundary } from '../../DialogHistoryHost';
import { ConversationConnectionProvider } from '../ConversationConnectionContext';
import { conversationConnection } from './fixtures';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://wrong-host.test' }),
}));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  for (const key of ['merge-host', 'merge-peer'])
    activeChatsStore.removeChat(key);
  backgroundTasksStore.reset();
  childWorkGlobalStore.reset();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('peer snapshots and structured returns preserve colliding host child work and retention aliases', () => {
  const host = conversationConnection('host');
  const peer = conversationConnection('direct');
  const report = (station: typeof host, delta: ChildWorkDelta) =>
    handleOrchestrationEvent(
      station.targetApiBase,
      {
        method: 'child-work.updated',
        provider: 'claude',
        threadId: 'same-session',
        createdAt: '2026-11-05T12:00:00Z',
        delta,
      },
      undefined,
      undefined,
      undefined,
      station,
    );
  for (const [key, station] of [
    ['merge-host', host],
    ['merge-peer', peer],
  ] as const) {
    activeChatsStore.initChat(key, {
      agentSlug: 'claude',
      agentName: 'Claude',
      title: key,
      conversationId: 'same-conversation',
      currentSessionId: 'same-session',
      stationBinding: station.binding,
    });
    report(station, {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'same-session',
        childId: 'same-child',
        status: 'running',
        backgrounded: true,
        title: station.stationName,
      },
    });
    report(station, {
      kind: 'settle',
      producer: 'engine-subagent',
      reporterThreadId: 'same-session',
      childId: 'same-child',
      status: 'completed',
      result: { summary: station.stationName, source: 'provider-summary' },
    });
  }
  for (const station of [host, peer])
    report(station, {
      kind: 'upsert',
      item: {
        producer: 'engine-subagent',
        reporterThreadId: 'same-session',
        childId: 'same-running-child',
        status: 'running',
        title: station.stationName,
      },
    });
  const mounted = renderHook(
    () => ({
      key: useChatStoreKey('same-conversation'),
      tasks: useChatBackgroundTasks('merge-peer'),
    }),
    {
      wrapper: ({ children }) => (
        <ConversationConnectionProvider
          value={{ apiBase: peer.targetApiBase, station: peer }}
        >
          {children}
        </ConversationConnectionProvider>
      ),
    },
  );
  expect(mounted.result.current.key).toBe('merge-peer');
  expect(
    mounted.result.current.tasks.running.map((entry) => entry.title),
  ).toEqual(['Receiver']);
  mounted.unmount();
  const hostBefore = activeChatsStore.getSnapshot()['merge-host'];
  const hostTasksBefore = backgroundTasksStore.getSnapshot(host);
  report(peer, {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: 'same-session',
    childId: 'same-child',
    status: 'completed',
    result: { summary: 'Authoritative peer return', source: 'tool-return' },
  });
  const notices =
    activeChatsStore.getSnapshot()['merge-peer'].ephemeralMessages ?? [];
  expect(notices).toHaveLength(1);
  expect(notices[0].backgroundTaskNotice).toMatchObject({
    summary: 'Authoritative peer return',
    summarySource: 'tool-return',
    stationName: peer.stationName,
  });
  expect(activeChatsStore.getSnapshot()['merge-host']).toBe(hostBefore);
  applyOrchestrationSnapshot(
    {
      sessions: [
        {
          provider: 'claude',
          threadId: 'same-conversation',
          currentSessionId: 'new-peer-session',
          status: 'running',
          hasActiveTurn: true,
        },
        {
          provider: 'claude',
          threadId: 'new-peer-session',
          status: 'running',
          hasActiveTurn: true,
        },
      ],
    },
    { apiBase: peer.targetApiBase, station: peer },
  );
  expect(
    backgroundTasksStore.getSnapshot(peer).providerReporters?.[
      'new-peer-session'
    ],
  ).toBe('merge-peer');
  expect(activeChatsStore.getSnapshot()['merge-host']).toBe(hostBefore);
  applyOrchestrationSnapshot(
    { sessions: [] },
    { apiBase: peer.targetApiBase, station: peer },
  );
  expect(activeChatsStore.getSnapshot()['merge-host']).toBe(hostBefore);
  expect(backgroundTasksStore.getSnapshot(host)).toBe(hostTasksBefore);
  expect(
    childWorkGlobalStore.getPartition(stationPartitionKey(host)).registry.items,
  ).not.toEqual({});
  activeChatsStore.removeChat('merge-peer');
  expect(
    backgroundTasksStore.getSnapshot(host).openChatThreads?.[
      'same-conversation'
    ],
  ).toBe(true);
});

function Picker() {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} type="button">
        Approval
      </button>
      <ComposerModeSheet
        triggerRef={trigger}
        effectiveMode="ask"
        engineConnectionId="codex"
        sourceNote="Only this chat"
        onClose={() => {}}
        onSelect={() => {}}
      />
    </>
  );
}

test.each(['direct', 'relay'] as const)(
  '%s shared composer reads the owning policy without inheriting the host ceiling',
  async (route) => {
    const station = conversationConnection(route);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    setClientCredentialResolver((selector) => {
      expect(selector?.requestScope).toEqual(station.requestScope);
      return {
        origin: station.requestScope.apiBase,
        credential: 'fixture-token',
        requestAuthority: {
          ...station.requestScope,
          isCurrent: station.isCurrent,
        },
      };
    });
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        success: true,
        data: {
          state: 'loaded',
          digest: `sha256:${'a'.repeat(64)}`,
          source: { kind: 'test-override', location: 'fixture' },
          summary: {
            organization: 'Receiver Org',
            supportUrl: null,
            lockedSettings: [],
            limits: { maxApprovalMode: 'auto' },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', request);
    render(
      <QueryClientProvider client={client}>
        <DialogHistoryHostBoundary>
          <ManagedPolicyContext.Provider
            value={{
              organization: 'Host Org',
              supportUrl: null,
              lockedSettings: [],
              limits: { maxApprovalMode: 'ask' },
            }}
          >
            <ConversationConnectionProvider
              value={{
                apiBase: station.targetApiBase,
                station,
                requestScope: {
                  ...station.requestScope,
                  isCurrent: station.isCurrent,
                },
              }}
            >
              <Picker />
            </ConversationConnectionProvider>
          </ManagedPolicyContext.Provider>
        </DialogHistoryHostBoundary>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Receiver Org's policy/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Host Org's policy/)).toBeNull();
    const auto = screen
      .getAllByRole('radio')
      .find(
        (input) => (input as HTMLInputElement).value === 'auto',
      ) as HTMLInputElement;
    expect(auto.disabled).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0][0])).toBe(
      `${station.targetApiBase}/api/settings/managed-policy`,
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .some(
          (query) =>
            JSON.stringify(query.queryKey) ===
            JSON.stringify([
              'managed-policy',
              station.targetApiBase,
              station.requestScope.authorityKey,
              station.runtimeKey,
            ]),
        ),
    ).toBe(true);
  },
);
