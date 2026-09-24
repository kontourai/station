import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../../src-server/constants.js', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD: 5,
}));

const apiBase = 'http://sync-property.test';
const userId = 'sync-property-user';
const roots: string[] = [];
const services: Array<{ shutdown(): Promise<unknown> }> = [];
const stores: Array<{ close(): void }> = [];
const requests: Array<{ url: string; headers: Headers }> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const service of services.splice(0)) await service.shutdown();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function setup() {
  // Vitest loads the real server modules at runtime. This cross-runtime
  // harness lives in the UI test lane, whose TypeScript project does not
  // compile server internals or provide their Node-only ambient types.
  const [storeModule, busModule, serviceModule, routeModule] =
    await Promise.all([
      vi.importActual<any>(
        '../../../src-server/services/orchestration/event-store.js',
      ),
      vi.importActual<any>(
        '../../../src-server/services/orchestration/event-bus.js',
      ),
      vi.importActual<any>(
        '../../../src-server/services/orchestration/orchestration-service.js',
      ),
      vi.importActual<any>(
        '../../../src-server/routes/orchestration/orchestration.js',
      ),
    ]);
  const { EventStore } = storeModule;
  const { EventBus } = busModule;
  const { OrchestrationService } = serviceModule;
  const { createOrchestrationRoutes } = routeModule;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  const root = mkdtempSync(join(tmpdir(), 'station-sync-property-'));
  roots.push(root);
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  stores.push(store);
  const eventBus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get() {
        return undefined;
      },
      list() {
        return [];
      },
    } as any,
    eventBus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() } as any,
  });
  services.push(service);
  const app = new Hono();
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => userId,
    }),
  );
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(
      String(input instanceof Request ? input.url : input),
      init,
    );
    requests.push({ url: request.url, headers: request.headers });
    return app.fetch(request);
  });
  const publish = (event: CanonicalRuntimeEvent) => {
    store.appendEvent(event);
    eventBus.emit('orchestration:event', { event });
  };
  const publishViaService = (event: CanonicalRuntimeEvent) => {
    (service as any).publishCanonicalEvent(event);
  };
  return { store, service, app, publish, publishViaService };
}

async function clientGraph(conversationId: string) {
  vi.resetModules();
  const page = Object.assign(new EventTarget(), {
    location: { pathname: '/', search: '', origin: apiBase, href: apiBase },
    history: { state: null, replaceState() {}, pushState() {} },
  });
  vi.stubGlobal('window', page);
  const sdk = await import('@kontourai/station-sdk');
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  const { ensureOrchestrationEventStream } = await import(
    '../hooks/orchestration/ensureOrchestrationEventStream'
  );
  const { childWorkRegistrySnapshot } = await import(
    '../hooks/orchestration/childWorkHandlers'
  );
  const { childWorkGlobalStore } = await import(
    '../contexts/child-work-global-store'
  );
  sdk.setClientCredentialResolver(() => ({
    origin: apiBase,
    credential: 'test-credential',
  }));
  activeChatsStore.initChat(conversationId, {
    agentSlug: 'claude',
    agentName: 'Claude',
    title: 'Property test',
    conversationId,
    currentSessionId: conversationId,
    provider: 'claude',
    orchestrationSessionStarted: true,
  });
  const close = ensureOrchestrationEventStream(apiBase);
  return {
    activeChatsStore,
    childWorkRegistrySnapshot,
    childWorkGlobalStore,
    close,
    ensure: () => ensureOrchestrationEventStream(apiBase),
    disconnect: () => page.dispatchEvent(new Event('pagehide')),
  };
}

async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000 });
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

test('seeded clients converge through live, replay, and snapshot reconnects', async () => {
  const { store, publish, publishViaService } = await setup();
  const conversationId = 'sync-root';
  const createdAt = '2026-09-24T00:00:00.000Z';
  store.upsertSession({
    provider: 'claude',
    threadId: conversationId,
    status: 'ready',
    createdAt,
    updatedAt: createdAt,
  });
  publish({
    eventId: 'configured',
    provider: 'claude',
    threadId: conversationId,
    createdAt,
    method: 'session.configured',
    sessionId: conversationId,
    metadata: { agentSlug: 'claude', userId },
  } as CanonicalRuntimeEvent);
  const a = await clientGraph(conversationId);
  await until(() =>
    Boolean(
      a.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
    ),
  );
  const b = await clientGraph(conversationId);
  await until(() =>
    Boolean(
      b.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
    ),
  );
  expect(
    b.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
  ).toEqual(
    a.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
  );
  const selectedSeed = process.env.SYNC_FUZZ_SEED;
  const seeds = [
    // Pinned regressions: 0 deleted-tail/replacement/snapshot approvals and
    // settled child; 12 runtime.error; 16 turn.aborted.
    ...Array.from({ length: 200 }, (_, seed) => seed),
    ...(selectedSeed && Number.isSafeInteger(Number(selectedSeed))
      ? [Number(selectedSeed)]
      : []),
  ];
  for (const seed of seeds) {
    const random = mulberry32(seed);
    const trace: string[] = [];
    const before = requests.length;
    const cursor = store.headGlobalSequence();
    b.disconnect();
    const draft = `draft-${seed}`;
    store.appendEvent({
      eventId: `${draft}-event`,
      provider: 'claude',
      threadId: draft,
      createdAt,
      method: 'content.text-delta',
      itemId: draft,
      delta: 'discard',
    } as CanonicalRuntimeEvent);
    const deletedTailCursor = store.headGlobalSequence();
    store.deleteThread(draft);
    trace.push('draft.discard');
    const turnId = `turn-${seed}`;
    publish({
      eventId: `${turnId}-start`,
      provider: 'claude',
      threadId: conversationId,
      turnId,
      createdAt,
      method: 'turn.started',
      prompt: `seed ${seed}`,
      ...(seed % 9 === 0 ? { metadata: { trigger: 'provider' } } : {}),
    } as CanonicalRuntimeEvent);
    trace.push('turn.started');
    expect(
      store.headGlobalSequence(),
      `deleted-tail cursor seed=${seed} trace=${trace.join(',')}`,
    ).toBeGreaterThan(deletedTailCursor);
    const deltaCount = seed % 3 === 0 ? 6 : 1;
    for (let index = 0; index < deltaCount; index++) {
      publish({
        eventId: `${turnId}-delta-${index}`,
        provider: 'claude',
        threadId: conversationId,
        turnId,
        createdAt,
        method: 'content.text-delta',
        itemId: `answer-${seed}`,
        delta: String(random()),
      } as CanonicalRuntimeEvent);
      trace.push('content.text-delta');
    }
    if (random() > 0.5) {
      publish({
        eventId: `${turnId}-tool-start`,
        provider: 'claude',
        threadId: conversationId,
        turnId,
        createdAt,
        method: 'tool.started',
        itemId: `tool-${seed}`,
        toolCallId: `tool-${seed}`,
        toolName: 'Read',
      } as CanonicalRuntimeEvent);
      publish({
        eventId: `${turnId}-tool-done`,
        provider: 'claude',
        threadId: conversationId,
        turnId,
        createdAt,
        method: 'tool.completed',
        itemId: `tool-${seed}`,
        toolCallId: `tool-${seed}`,
        toolName: 'Read',
        status: 'success',
      } as CanonicalRuntimeEvent);
      trace.push('tool.started', 'tool.completed');
    }
    if (seed % 7 === 0) {
      publish({
        eventId: `${turnId}-request`,
        provider: 'claude',
        threadId: conversationId,
        turnId,
        createdAt,
        method: 'request.opened',
        requestId: `request-${seed}`,
        requestType: 'approval',
        title: 'Allow Read',
      } as CanonicalRuntimeEvent);
      trace.push('request.opened');
    }
    if (seed > 0 && seed % 7 === 1) {
      publish({
        eventId: `${turnId}-request-resolved`,
        provider: 'claude',
        threadId: conversationId,
        turnId,
        createdAt,
        method: 'request.resolved',
        requestId: `request-${seed - 1}`,
        status: 'approved',
      } as CanonicalRuntimeEvent);
      trace.push('request.resolved');
    }
    if (seed === 0) {
      const child = {
        producer: 'engine-subagent',
        reporterThreadId: conversationId,
        childId: 'seed-child',
        status: 'running',
        title: 'Explore',
        backgrounded: true,
      };
      publishViaService({
        eventId: 'child-upsert',
        provider: 'claude',
        threadId: conversationId,
        createdAt,
        method: 'child-work.updated',
        delta: { kind: 'upsert', item: child },
      } as CanonicalRuntimeEvent);
      publishViaService({
        eventId: 'child-settle',
        provider: 'claude',
        threadId: conversationId,
        createdAt,
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: conversationId,
          childId: 'seed-child',
          status: 'completed',
          result: { summary: 'Explored.' },
        },
      } as CanonicalRuntimeEvent);
      trace.push('child.upsert', 'child.settle');
    }
    if (seed === 1) {
      publishViaService({
        eventId: 'late-child-upsert',
        provider: 'claude',
        threadId: conversationId,
        createdAt,
        method: 'child-work.updated',
        delta: {
          kind: 'upsert',
          item: {
            producer: 'engine-subagent',
            reporterThreadId: conversationId,
            childId: 'late-child',
            status: 'running',
            title: 'Build',
          },
        },
      } as CanonicalRuntimeEvent);
      trace.push('child.upsert');
    }
    if (seed === 2) {
      publishViaService({
        eventId: 'late-child-settle',
        provider: 'claude',
        threadId: conversationId,
        createdAt,
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: conversationId,
          childId: 'late-child',
          status: 'completed',
        },
      } as CanonicalRuntimeEvent);
      trace.push('child.settle');
    }
    const terminal =
      seed % 17 === 16
        ? 'turn.aborted'
        : seed % 13 === 12
          ? 'runtime.error'
          : 'turn.completed';
    publish({
      eventId: `${turnId}-terminal`,
      provider: 'claude',
      threadId: conversationId,
      turnId,
      createdAt,
      method: terminal,
      ...(terminal === 'turn.aborted' ? { reason: 'interrupted' } : {}),
      ...(terminal === 'runtime.error'
        ? { severity: 'error', message: 'provider failed' }
        : {}),
    } as CanonicalRuntimeEvent);
    trace.push(terminal);
    const head = store.headGlobalSequence();
    expect(head, `seed=${seed} trace=${trace.join(',')}`).toBeGreaterThan(
      deletedTailCursor,
    );
    await vi.waitFor(
      () =>
        expect(
          a.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity
            ?.asOfSequence,
          `A seed=${seed} trace=${trace.join(',')}`,
        ).toBe(head),
      { timeout: 5_000 },
    );
    b.ensure();
    await until(() => requests.length > before);
    expect(
      requests.at(-1)?.headers.get('Last-Event-ID'),
      `seed=${seed} trace=${trace.join(',')}`,
    ).toBe(String(cursor));
    await vi.waitFor(
      () =>
        expect(
          b.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity
            ?.asOfSequence,
          `B seed=${seed} trace=${trace.join(',')}`,
        ).toBe(head),
      { timeout: 5_000 },
    );
    expect(
      b.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
      `seed=${seed} trace=${trace.join(',')}`,
    ).toEqual(
      a.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
    );
    const select = (
      chat: ReturnType<typeof a.activeChatsStore.getSnapshot>[string],
    ) => ({
      orchestrationTurnOpen: chat.orchestrationTurnOpen,
      orchestrationStatus: chat.orchestrationStatus,
      pendingApprovals: chat.pendingApprovals ?? [],
      queuedMessages: chat.queuedMessages,
      backgroundTasks: chat.backgroundTasks ?? [],
      currentSessionId: chat.currentSessionId,
    });
    expect(
      select(b.activeChatsStore.getSnapshot()[conversationId]!),
      `seed=${seed} trace=${trace.join(',')}`,
    ).toEqual(select(a.activeChatsStore.getSnapshot()[conversationId]!));
    expect(
      b.childWorkRegistrySnapshot().items,
      `seed=${seed} trace=${trace.join(',')} child registry`,
    ).toEqual(a.childWorkRegistrySnapshot().items);
    expect(
      b.childWorkGlobalStore.getPartition(apiBase).registry.items,
      `seed=${seed} trace=${trace.join(',')} global child work`,
    ).toEqual(a.childWorkGlobalStore.getPartition(apiBase).registry.items);
  }
  // A restored database can have the same numeric sequence as an older one.
  // The old cursor is then valid by number but foreign by durable identity.
  const oldEpoch = store.streamEpoch();
  const replacement = await setup();
  replacement.publish({
    eventId: 'replacement-configured',
    provider: 'claude',
    threadId: conversationId,
    createdAt,
    method: 'session.configured',
    sessionId: conversationId,
    metadata: { agentSlug: 'claude', userId },
  } as CanonicalRuntimeEvent);
  expect(replacement.store.headGlobalSequence()).toBe(1);
  expect(replacement.store.streamEpoch()).not.toBe(oldEpoch);
  const response = await replacement.app.fetch(
    new Request(`${apiBase}/api/orchestration/events`, {
      headers: { 'Last-Event-ID': '1', 'X-Station-Stream-Epoch': oldEpoch },
    }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let wire = '';
  while (!wire.includes('event: orchestration:caughtUp')) {
    const next = await reader.read();
    if (next.done) throw new Error(`replacement stream ended: ${wire}`);
    wire += decoder.decode(next.value);
  }
  await reader.cancel();
  expect(wire).toContain('event: orchestration:snapshot');
  expect(wire).toContain(`"epoch":"${replacement.store.streamEpoch()}"`);
}, 60_000);
