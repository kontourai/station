// @vitest-environment jsdom

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { AUTHORITY_OBSERVATION_SCHEMA_VERSION } from '@kontourai/station-contracts/authority-observation';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import type {
  FetchSseConnection,
  FetchSseOptions,
} from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openConversationForDock } from '../../components/chat-dock/conversationOpenController';
import {
  ActiveChatsStore,
  activeChatsStore,
} from '../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
import { workObservation } from '../../contexts/work-observation';
import {
  ensureOrchestrationEventStream,
  resetSessionReadModelRefreshForTests,
} from '../../hooks/orchestration/ensureOrchestrationEventStream';
import { SemanticDeliveryBuffer } from '../../hooks/orchestration/semanticDeliveryBuffer';
import { applyOrchestrationSnapshot } from '../../hooks/orchestration/snapshotHandlers';
import { handleTextDeltaEvent } from '../../hooks/orchestration/streamHandlers';
import {
  conversationCapabilitiesFromAuthority,
  type StationConnection,
} from '../station-connection';
import {
  registerStationConnectionRegistry,
  type StationConnectionLease,
  StationConnectionRegistry,
} from '../station-connection-registry';
import { useChatStationConnection } from '../use-chat-station-connection';

const wire = vi.hoisted(() => ({
  streams: new Map<
    string,
    { options: FetchSseOptions; close: ReturnType<typeof vi.fn> }
  >(),
  open: vi.fn<(...args: unknown[]) => Promise<ConversationOpenResolution>>(),
  connections: undefined as
    | {
        resolve(options: {
          binding?: StationConnection['binding'];
        }): Promise<StationConnectionLease>;
      }
    | undefined,
}));
vi.mock('../StationConnectionsContext', () => ({
  useStationConnectionsOptional: () => wire.connections ?? null,
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<object>()),
  fetchSSE: (url: string, options: FetchSseOptions): FetchSseConnection => {
    const controller = new AbortController();
    let finish = () => {};
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const close = vi.fn(() => {
      controller.abort();
      finish();
    });
    wire.streams.set(url, { options, close });
    return {
      close,
      completed,
      signal: controller.signal,
      retry: vi.fn(),
      restart: vi.fn(),
    };
  },
}));
vi.mock('@kontourai/station-sdk/conversation-open', () => ({
  resolveConversationOpen: (...args: unknown[]) => wire.open(...args),
}));

const releases: (() => void)[] = [];
const clients: QueryClient[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const client of clients.splice(0)) client.clear();
  for (const key of Object.keys(activeChatsStore.getSnapshot()))
    activeChatsStore.removeChat(key);
  backgroundTasksStore.reset();
  resetSessionReadModelRefreshForTests();
  wire.streams.clear();
  wire.open.mockReset();
  wire.connections = undefined;
  vi.useRealTimers();
});

async function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const registry = new StationConnectionRegistry(() => true);
  const leases = new Map<string, StationConnectionLease & { stop(): void }>();
  const retire = registerStationConnectionRegistry(client, registry);
  releases.push(retire);
  const connect = async (environmentId: string) => {
    const targetApiBase = `https://source.test/api/environments/peers/${environmentId}/chat-api`;
    const lease = await registry.acquire(environmentId, async () => ({
      environmentId,
      stationName: environmentId,
      stationKey: environmentId,
      targetApiBase,
      routeKind: 'relay',
      authorityNamespace: 'owner',
      requestScope: {
        apiBase: 'https://source.test',
        authorityKey: 'source-owner',
      },
      binding: {
        version: 1,
        environmentId,
        stationName: environmentId,
        affinity: {
          kind: 'peer',
          sourceEnvironmentId: 'source',
          sourceConnectionId: 'source-device',
          principalNamespace: 'delegation',
        },
      },
      capabilities: conversationCapabilitiesFromAuthority(
        {
          schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
          environmentId,
          principal: { kind: 'human', id: 'human:test' },
          grant: {
            kind: 'device',
            deviceId: 'device',
            grantedScopes: ['orchestration:read', 'orchestration:operate'],
          },
        },
        { remote: true, mutationAllowed: true },
      ),
      isCurrent: () => true,
      dispose: () => {},
    }));
    releases.push(lease.release);
    const stop = ensureOrchestrationEventStream(
      targetApiBase,
      client,
      undefined,
      true,
      true,
      lease.connection,
    );
    leases.set(environmentId, { ...lease, stop });
    releases.push(stop);
    activeChatsStore.initChat(`${environmentId}-tab`, {
      stationBinding: lease.connection.binding,
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Test',
      conversationId: 'same',
      currentSessionId: 'same-session',
      orchestrationSessionStarted: true,
    });
    return lease.connection;
  };
  return {
    client,
    a: await connect('a'),
    b: await connect('b'),
    retire,
    registry,
    leases,
  };
}

function frame(
  station: StationConnection,
  event: string,
  data: object,
  id?: string,
) {
  const stream = wire.streams.get(
    `${station.targetApiBase}/api/orchestration/events`,
  );
  if (!stream) throw new Error('Missing owned stream');
  stream.options.onMessage?.({ event, data: JSON.stringify(data), id });
}

function resolved(): ConversationOpenResolution {
  return {
    status: 'resolved',
    conversation: {
      id: 'same',
      source: 'runtime',
      agentSlug: agentId('assistant'),
      title: 'A conversation',
      createdAt: '2026-11-04T00:00:00Z',
      updatedAt: '2026-11-04T00:00:00Z',
      messageCount: 1,
      mutable: false,
      answerability: { answerable: true },
    },
    currentSessionId: 'same-session',
    activity: { conversationId: 'same', asOfSequence: 21 },
    transcript: { available: true, owner: 'runtime', messageCount: 1 },
    canContinue: true,
    answerability: { answerable: true },
    recoveryActions: [],
  };
}

describe('Station state partitions', () => {
  it('coalesced deltas carry their Station through event cloning instead of reaching a colliding host tab', async () => {
    const { a, b } = await setup();
    activeChatsStore.initChat('same-session');
    const buffer = new SemanticDeliveryBuffer(
      (event, _base, _provenance, station) => {
        if (event.method !== 'content.text-delta')
          throw new Error('Unexpected buffered event');
        handleTextDeltaEvent(event, station);
      },
      () => true,
      (threadId, station) =>
        activeChatsStore.getChatKeyForExecutionSession(threadId, station) ?? '',
    );
    for (const station of [a, b, a]) {
      buffer.offer(
        {
          method: 'content.text-delta',
          provider: 'claude',
          threadId: 'same-session',
          turnId: 'same-turn',
          itemId: 'same-item',
          delta: station.environmentId,
          createdAt: '2026-11-04T00:00:00Z',
        },
        station.targetApiBase,
        undefined,
        station,
      );
    }
    buffer.flushAll();
    expect(
      activeChatsStore.getSnapshot()['a-tab'].streamingMessage?.content,
    ).toBe('aa');
    expect(
      activeChatsStore.getSnapshot()['b-tab'].streamingMessage?.content,
    ).toBe('b');
    expect(
      activeChatsStore.getSnapshot()['same-session'].streamingMessage,
    ).toBeUndefined();
  });

  it('a shared stream survives release of the reader whose lease first opened it', async () => {
    const { a, client, registry, leases } = await setup();
    const second = await registry.acquire('a', async () => {
      throw new Error('Existing lease must be reused');
    });
    const stop = ensureOrchestrationEventStream(
      a.targetApiBase,
      client,
      undefined,
      false,
      false,
      second.connection,
    );
    releases.push(stop, second.release);
    leases.get('a')!.stop();
    leases.get('a')!.release();
    expect(a.isCurrent()).toBe(false);
    expect(second.connection.isCurrent()).toBe(true);
    frame(
      second.connection,
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      {
        event: {
          method: 'turn.started',
          provider: 'claude',
          threadId: 'same-session',
          turnId: 'same-turn',
          createdAt: '2026-11-04T00:00:00Z',
        },
      },
      '1',
    );
    frame(
      second.connection,
      SERVER_EVENTS.ORCHESTRATION_EVENT,
      {
        event: {
          method: 'content.text-delta',
          provider: 'claude',
          threadId: 'same-session',
          turnId: 'same-turn',
          delta: 'still live',
          createdAt: '2026-11-04T00:00:01Z',
        },
      },
      '2',
    );
    expect(
      activeChatsStore.getSnapshot()['a-tab'].streamingMessage?.content,
    ).toBe('still live');
    expect(
      wire.streams.get(`${a.targetApiBase}/api/orchestration/events`)?.close,
    ).not.toHaveBeenCalled();
  });

  it('a restored reader releases a late original lease instead of publishing it into the replacement tab', async () => {
    const { client, a, b } = await setup();
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    let finishA = (_lease: StationConnectionLease) => {};
    const pendingA = new Promise<StationConnectionLease>((resolve) => {
      finishA = resolve;
    });
    const resolve = vi.fn(
      (options: { binding?: StationConnection['binding'] }) =>
        options.binding?.environmentId === 'a'
          ? pendingA
          : Promise.resolve({ connection: b, release: releaseB }),
    );
    const owner = { resolve };
    wire.connections = owner;
    // The optional provider value must be stable like the real provider.
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const hook = renderHook(
      ({ binding }) => useChatStationConnection({ stationBinding: binding }),
      { wrapper, initialProps: { binding: a.binding } },
    );
    await waitFor(() =>
      expect(owner.resolve).toHaveBeenCalledWith({ binding: a.binding }),
    );
    hook.rerender({ binding: b.binding });
    await waitFor(() =>
      expect(hook.result.current.connection?.environmentId).toBe('b'),
    );
    finishA({ connection: a, release: releaseA });
    await waitFor(() => expect(releaseA).toHaveBeenCalledOnce());
    expect(hook.result.current.connection?.environmentId).toBe('b');
    hook.unmount();
    expect(releaseB).toHaveBeenCalledOnce();
  });

  it('keeps legacy host dead-session exits while ignoring malformed remote markers', async () => {
    const { a, b } = await setup();
    activeChatsStore.initChat('legacy');
    activeChatsStore.updateChat('legacy', {
      orchestrationSessionStarted: true,
      conversationId: 'same',
    });
    activeChatsStore.initChat('invalid-peer');
    activeChatsStore.updateChat('invalid-peer', {
      orchestrationSessionStarted: true,
      peerChatInvalid: true,
    });
    frame(b, 'orchestration:snapshot', { sessions: [] }, '1');
    expect(
      activeChatsStore.getSnapshot().legacy.orchestrationSessionStarted,
    ).toBe(true);
    expect(
      activeChatsStore.getSnapshot()['a-tab'].orchestrationSessionStarted,
    ).toBe(true);
    applyOrchestrationSnapshot({ sessions: [] });
    expect(activeChatsStore.getSnapshot().legacy.orchestrationStatus).toBe(
      'exited',
    );
    expect(
      activeChatsStore.getSnapshot()['a-tab'].orchestrationSessionStarted,
    ).toBe(true);
    expect(
      activeChatsStore.getSnapshot()['invalid-peer']
        .orchestrationSessionStarted,
    ).toBe(true);
    expect(activeChatsStore.getChatForExecutionSession('same', a)).toBe(
      activeChatsStore.getSnapshot()['a-tab'],
    );
  });

  it('B snapshots, epoch replacement and failed reads preserve A cache, pending open and failure fences', async () => {
    const { client, a, b } = await setup();
    const prefix = (station: StationConnection) => [
      'orchestration-sessions',
      station.targetApiBase,
      station.requestScope.authorityKey,
      station.runtimeKey,
    ];
    client.setQueryData(prefix(a), [{ threadId: 'same-session', title: 'A' }]);
    client.setQueryData(prefix(b), [{ threadId: 'same-session', title: 'B' }]);
    const aObservation = workObservation(client, a);
    const bObservation = workObservation(client, b);
    aObservation.observed('same', 20);
    aObservation.read('same', 'history')?.failed();
    let finishOpen = (_result: ConversationOpenResolution) => {};
    wire.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    );
    const patch = vi.fn(
      (
        id: string,
        updates: Parameters<typeof activeChatsStore.updateChat>[1],
      ) => activeChatsStore.updateChat(id, updates),
    );
    const waiting = openConversationForDock('same', {
      apiBase: 'https://source.test',
      connection: a,
      observation: aObservation,
      open: vi.fn().mockResolvedValue(true),
      projectName: () => undefined,
      findTab: () => 'a-tab',
      readChat: (id) => activeChatsStore.getSnapshot()[id],
      updateChat: patch,
      setRecovery: vi.fn(),
    });
    await vi.waitFor(() => expect(wire.open).toHaveBeenCalledOnce());
    const aEpoch = aObservation.streamEpochGeneration();
    const before = activeChatsStore.getSnapshot()['a-tab'];
    frame(b, 'orchestration:snapshot', { epoch: 'b-1', sessions: [] }, '1');
    await expect(
      client.fetchQuery({
        queryKey: [
          'conversation-inventory',
          b.targetApiBase,
          b.requestScope.authorityKey,
          b.runtimeKey,
        ],
        queryFn: async () => {
          throw new Error('B inventory unavailable');
        },
        retry: false,
      }),
    ).rejects.toThrow('B inventory unavailable');
    bObservation.read('same', 'history')?.failed();
    frame(b, 'orchestration:snapshot', { epoch: 'b-2', sessions: [] }, '2');
    expect(aObservation.streamEpochGeneration()).toBe(aEpoch);
    expect(activeChatsStore.getSnapshot()['a-tab']).toBe(before);
    expect(activeChatsStore.getSnapshot()['b-tab'].orchestrationStatus).toBe(
      'exited',
    );
    expect(client.getQueryData(prefix(a))).toEqual([
      { threadId: 'same-session', title: 'A' },
    ]);
    expect(client.getQueryState(prefix(a))?.isInvalidated).toBe(false);
    expect(aObservation.unavailable('same')).toBe(true);
    finishOpen(resolved());
    await expect(waiting).resolves.toBe(true);
    expect(patch).toHaveBeenCalledOnce();
    expect(wire.open).toHaveBeenCalledWith('same', a.targetApiBase, {
      requestScope: a.requestScope,
    });
    expect(aObservation.unavailable('same')).toBe(true);
    aObservation.streamObserved({ conversationId: 'same', asOfSequence: 20 });
    expect(aObservation.unavailable('same')).toBe(true);
    aObservation.streamObserved({ conversationId: 'same', asOfSequence: 22 });
    expect(aObservation.unavailable('same')).toBe(false);
  });

  it('colliding live turns and child reporters remain owned; host authority retirement closes both streams', async () => {
    const { a, b, retire } = await setup();
    for (const station of [a, b]) {
      frame(
        station,
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        {
          event: {
            method: 'turn.started',
            provider: 'claude',
            threadId: 'same-session',
            turnId: 'same-turn',
            clientTurnId: 'same-client-turn',
            createdAt: '2026-11-04T00:00:00Z',
          },
        },
        '1',
      );
      frame(
        station,
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        {
          event: {
            method: 'content.text-delta',
            provider: 'claude',
            threadId: 'same-session',
            turnId: 'same-turn',
            delta: station.environmentId,
            createdAt: '2026-11-04T00:00:01Z',
          },
        },
        '2',
      );
      frame(
        station,
        SERVER_EVENTS.ORCHESTRATION_EVENT,
        {
          event: {
            method: 'child-work.updated',
            provider: 'claude',
            threadId: 'same-session',
            createdAt: '2026-11-04T00:00:02Z',
            delta: {
              kind: 'upsert',
              item: {
                producer: 'engine-subagent',
                reporterThreadId: 'same-session',
                childId: 'same-child',
                title: station.environmentId,
                status: 'running',
              },
            },
          },
        },
        '3',
      );
    }
    expect(
      activeChatsStore.getSnapshot()['a-tab'].streamingMessage?.content,
    ).toBe('a');
    expect(
      activeChatsStore.getSnapshot()['b-tab'].streamingMessage?.content,
    ).toBe('b');
    frame(b, 'orchestration:snapshot', { epoch: 'b', sessions: [] }, '4');
    expect(
      activeChatsStore.getSnapshot()['a-tab'].backgroundTasks?.[0].description,
    ).toBe('a');
    expect(activeChatsStore.getSnapshot()['b-tab'].backgroundTasks).toEqual([]);
    for (const station of [a, b]) {
      const stream = wire.streams.get(
        `${station.targetApiBase}/api/orchestration/events`,
      )!;
      expect(stream.options.requestScope).toEqual(station.requestScope);
    }
    retire();
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(false);
    for (const stream of wire.streams.values())
      expect(stream.close).toHaveBeenCalledOnce();
    const before = activeChatsStore.getSnapshot();
    frame(a, 'orchestration:snapshot', { sessions: [] }, '5');
    expect(activeChatsStore.getSnapshot()).toBe(before);
  });

  it('keeps legacy unbound host state distinct from invalid peer markers and persists validated bindings', async () => {
    const { a } = await setup();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const store = new ActiveChatsStore({ storage });
    store.initChat('same', {
      conversationId: 'same',
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Test',
    });
    store.initChat('remote', {
      conversationId: 'same',
      stationBinding: a.binding,
      agentSlug: 'assistant',
      agentName: 'Assistant',
      title: 'Test',
    });
    store.initChat('invalid');
    store.updateChat('invalid', {
      conversationId: 'same',
      peerChatInvalid: true,
    });
    store.applyConversationActivity({
      conversationId: 'same',
      asOfSequence: 100,
    });
    store.applyConversationActivity(
      { conversationId: 'same', asOfSequence: 1 },
      a,
    );
    expect(store.getChatKeyForExecutionSession('same', a)).toBe('remote');
    expect(store.getChatKeyForExecutionSession('same')).toBe('same');
    expect(store.getSnapshot().same.conversationActivity?.asOfSequence).toBe(
      100,
    );
    expect(store.getSnapshot().remote.conversationActivity?.asOfSequence).toBe(
      1,
    );
    expect(store.getSnapshot().invalid.conversationActivity).toBeUndefined();
    store.flushPendingSave();
    const restored = new ActiveChatsStore({ storage });
    expect(restored.getSnapshot().remote.stationBinding).toEqual(a.binding);
    store.clearConversationActivity(a);
    expect(store.getSnapshot().remote.conversationActivity).toBeUndefined();
    expect(store.getSnapshot().same.conversationActivity?.asOfSequence).toBe(
      100,
    );
    values.set(
      'activeChats',
      JSON.stringify([
        {
          sessionId: 'bad',
          agentSlug: 'assistant',
          agentName: 'Assistant',
          title: 'Test',
          conversationId: 'same',
          stationBinding: { version: 9 },
        },
      ]),
    );
    const invalid = new ActiveChatsStore({ storage });
    expect(invalid.getSnapshot().bad.stationBindingInvalid).toBe(true);
    expect(invalid.getChatForExecutionSession('same')).toBeUndefined();
  });
});
