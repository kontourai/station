import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { awaitSessionRecoveryCompleted } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

test('parent summaries remain running until the owned child stop settles', async () => {
  const store = new EventStore(
    join(makeTempDir('cascade-idle-'), 'events.sqlite'),
  );
  const engine = new GateTestAdapter();
  const adapter: ProviderAdapterShape = engine;
  const running = new Set(['parent', 'child']);
  let entered!: () => void;
  const stoppingChild = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  adapter.hasSession = async (id) => running.has(id);
  adapter.listSessions = async () =>
    store.readSessions().filter((row) => running.has(row.threadId));
  adapter.stopSession = async (id) => {
    if (id === 'child') {
      entered();
      await gate;
    }
    running.delete(id);
  };
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug() {}, warn() {} },
  });
  let stop: ReturnType<OrchestrationService['dispatch']> | undefined;
  const readStates = async () => {
    const detail = await service.readSession(
      'parent',
      INTERNAL_SESSION_READ_SCOPE,
    );
    const listed = (
      await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE)
    ).find((row) => row.threadId === 'parent');
    const page = await service.readSessionEventPage('parent', {
      afterSequence: 0,
      limit: 5,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });
    return [
      detail?.session.lifecycleState,
      listed?.lifecycleState,
      page?.session.lifecycleState,
    ];
  };
  try {
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
    for (const id of ['parent', 'child']) {
      store.appendEvent({
        eventId: `${id}-started`,
        threadId: id,
        sessionId: id,
        provider: 'claude',
        method: 'session.started',
        createdAt: '2026-01-01T00:00:00.000Z',
        metadata:
          id === 'child'
            ? {
                delegation: {
                  parentConversationId: 'parent',
                  parentSessionId: 'parent',
                },
                stationDelegationProvenance: 'caller-derived',
              }
            : {},
      });
      service.seedSessionRecord({
        threadId: id,
        provider: 'claude',
        status: id === 'parent' ? 'ready' : 'running',
      });
    }
    store.appendEvent({
      eventId: 'parent-turn',
      provider: 'claude',
      threadId: 'parent',
      method: 'turn.started',
      turnId: 'turn',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.appendEvent({
      eventId: 'parent-done',
      provider: 'claude',
      threadId: 'parent',
      method: 'turn.completed',
      turnId: 'turn',
      finishReason: 'stop',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(await readStates()).toEqual(['running', 'running', 'running']);
    stop = service.dispatch({ type: 'stopSession', threadId: 'parent' });
    await stoppingChild;
    expect(running.has('child')).toBe(true);
    expect(await readStates()).toEqual(['running', 'running', 'running']);
    release();
    await stop;
    expect(running.has('child')).toBe(false);
    expect(await readStates()).toEqual(['idle', 'idle', 'idle']);
  } finally {
    release();
    await stop;
    await service.shutdown();
    store.close();
  }
});

test('Stop traverses verified descendants bottom-up and excludes claimed and background boundaries', async () => {
  const store = new EventStore(
    join(makeTempDir('cascade-tree-'), 'events.sqlite'),
  );
  const engine = new GateTestAdapter();
  const adapter: ProviderAdapterShape = engine;
  const running = new Set([
    'parent',
    'child',
    'grandchild',
    'claimed',
    'background',
  ]);
  const order: string[] = [];
  vi.spyOn(adapter, 'stopSession').mockImplementation(async (id) => {
    order.push(id);
    running.delete(id);
  });
  vi.spyOn(adapter, 'hasSession').mockImplementation(async (id) =>
    running.has(id),
  );
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug() {}, warn() {} },
  });
  try {
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
    for (const [id, parent, binding, background] of [
      ['parent', undefined, undefined, false],
      ['child', 'parent', 'caller-derived', false],
      ['grandchild', 'child', 'caller-derived', false],
      ['claimed', 'parent', 'direct-claim', false],
      ['background', 'parent', 'caller-derived', true],
    ] as const) {
      store.appendEvent({
        eventId: `${id}-started`,
        provider: 'claude',
        threadId: id,
        sessionId: id,
        method: 'session.started',
        createdAt: '2026-01-01T00:00:00.000Z',
        metadata: parent
          ? {
              delegation: {
                parentConversationId: parent,
                parentSessionId: parent,
              },
              stationDelegationProvenance: binding,
              backgroundBoundary: background,
            }
          : {},
      });
      service.seedSessionRecord({
        threadId: id,
        provider: 'claude',
        status: 'running',
      });
    }
    await service.dispatch({ type: 'stopSession', threadId: 'parent' });
    expect(order).toEqual(['grandchild', 'child', 'parent']);
    expect([...running]).toEqual(['claimed', 'background']);
    expect(store.pendingCascadeStops()).toEqual([]);
  } finally {
    await service.shutdown();
    store.close();
  }
});

test.each(['missing', 'dead', 'unavailable', 'reused'] as const)(
  'cascade retains unknown custody for a %s owner without using the dormant stop path',
  async (condition) => {
    const path = join(makeTempDir('cascade-unknown-'), 'events.sqlite');
    const store = new EventStore(path, undefined, {
      exact: () => ({ pid: process.pid, start: 'current-boot' }),
      probe: () =>
        condition === 'dead'
          ? { state: 'dead' }
          : condition === 'unavailable'
            ? { state: 'unavailable' }
            : {
                state: 'exact',
                identity: { pid: process.pid, start: 'reused-boot' },
              },
    });
    const adapter = new GateTestAdapter();
    const stop = vi.spyOn(adapter, 'stopSession');
    const warn = vi.fn();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventStore: store,
      eventBus: new EventBus(),
      logger: { debug() {}, warn },
    });
    const db = new DatabaseSync(path);
    try {
      service.initialize();
      await awaitSessionRecoveryCompleted(service);
      store.upsertSession({
        threadId: 'child',
        provider: 'claude',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      if (condition !== 'missing') {
        const admission = store
          .sessionTurnBoundaryAuthority()
          .claim('child', '2026-01-01T00:00:00.000Z');
        expect(admission.kind).toBe('owner');
        db.prepare(
          "UPDATE orchestration_turn_boundaries SET owner_id = 'foreign', owner_birth = 'old-boot', owner_identity_kind = 'exact' WHERE thread_id = 'child'",
        ).run();
      }
      store.appendEvent({
        eventId: 'terminal',
        threadId: 'parent',
        sessionId: 'parent',
        provider: 'claude',
        method: 'session.exited',
        reason: 'stopped',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      store.recordCascadeStopIntent('parent', 'child', 'terminal');
      await service.sweepIdleSessions();
      expect(stop).not.toHaveBeenCalled();
      expect(store.readSessionByThread('child')?.status).toBe('running');
      expect(store.pendingCascadeStops()).toHaveLength(1);
      expect(
        db
          .prepare('SELECT custody FROM orchestration_cascade_stop_custody')
          .get(),
      ).toEqual({ custody: 'unknown' });
      expect(warn).toHaveBeenCalledWith(
        'Cascade stop custody is unknown; retaining pending intent',
        expect.objectContaining({ childId: 'child' }),
      );
    } finally {
      await service.shutdown();
      db.close();
      store.close();
    }
  },
);

test('cascade stops a child whose turn admission committed before the fence', async () => {
  const store = new EventStore(
    join(makeTempDir('cascade-admitted-'), 'events.sqlite'),
  );
  const adapter = new GateTestAdapter();
  let running = true;
  const stop = vi.spyOn(adapter, 'stopSession').mockImplementation(async () => {
    running = false;
  });
  vi.spyOn(adapter, 'hasSession').mockImplementation(async () => running);
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug() {}, warn() {} },
  });
  try {
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
    service.seedSessionRecord({
      threadId: 'child',
      provider: 'claude',
      status: 'running',
    });
    const admission = store
      .sessionTurnBoundaryAuthority()
      .claim('child', '2026-01-01T00:00:00.000Z');
    expect(admission.kind).toBe('owner');
    if (admission.kind !== 'owner') throw new Error('Child admission failed');
    expect(
      admission.claim.beginInvocation('2026-01-01T00:00:00.000Z').kind,
    ).toBe('applied');
    expect(
      admission.claim.accepted('child-turn', '2026-01-01T00:00:00.000Z').kind,
    ).toBe('applied');
    store.appendEvent({
      eventId: 'terminal',
      threadId: 'parent',
      sessionId: 'parent',
      provider: 'claude',
      method: 'session.exited',
      reason: 'stopped',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    store.recordCascadeStopIntent('parent', 'child', 'terminal');
    await service.sweepIdleSessions();
    expect(stop).toHaveBeenCalledWith('child');
    expect(running).toBe(false);
  } finally {
    await service.shutdown();
    store.close();
  }
});
