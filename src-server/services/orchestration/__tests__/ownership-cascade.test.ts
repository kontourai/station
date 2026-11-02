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

test('targeted cancellation leaves children alone for a stale turn and cascades for the active turn', async () => {
  const path = join(makeTempDir('cascade-cancel-target-'), 'events.sqlite');
  const store = new EventStore(path);
  const engine = new GateTestAdapter();
  const adapter: ProviderAdapterShape = engine;
  const running = new Set(['parent', 'child']);
  const actions: string[] = [];
  const warnings = vi.fn();
  adapter.hasSession = async (id) => running.has(id);
  adapter.stopSession = async (id) => {
    actions.push(`stop:${id}`);
    running.delete(id);
  };
  adapter.interruptTurn = async (_id, turnId) => {
    if (!turnId)
      throw new Error(
        'The cancellation adapter requires its named active turn',
      );
    actions.push(`interrupt:${turnId}`);
    return { outcome: 'cancelled', turnId };
  };
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug() {}, warn: warnings },
  });
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
                  parentSessionId: 'parent',
                  parentConversationId: 'parent',
                },
                stationDelegationProvenance: 'caller-derived',
              }
            : {},
      });
      service.seedSessionRecord({
        threadId: id,
        provider: 'claude',
        status: 'running',
      });
    }
    store.appendEvent({
      eventId: 'parent-turn',
      provider: 'claude',
      threadId: 'parent',
      method: 'turn.started',
      turnId: 'active-turn',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(
      await service.dispatch({
        type: 'interruptTurn',
        threadId: 'parent',
        turnId: 'stale-turn',
      }),
    ).toEqual({ outcome: 'no-active-turn', threadId: 'parent' });
    expect(actions).toEqual([]);
    expect(store.pendingCascadeStops()).toEqual([]);
    const cancel = {
      type: 'interruptTurn',
      threadId: 'parent',
      turnId: 'active-turn',
    } as const;
    const outcomes = await Promise.all([
      service.dispatch(cancel),
      service.dispatch(cancel),
    ]);
    expect(outcomes).toEqual([
      { outcome: 'cooperative', threadId: 'parent', turnId: 'active-turn' },
      { outcome: 'cooperative', threadId: 'parent', turnId: 'active-turn' },
    ]);
    expect(warnings).not.toHaveBeenCalled();
    expect(actions).toEqual(['stop:child', 'interrupt:active-turn']);
    expect(running.has('child')).toBe(false);
    const request = store.latestEventByMethod(
      'parent',
      'session.cancellation-requested',
    )?.payload;
    if (!request) throw new Error('Durable cancellation request is missing');
    expect(request.turnId).toBe('active-turn');
    const reopened = new EventStore(path);
    try {
      expect(reopened.pendingCascadeStops()).toEqual([]);
      expect(
        reopened.readCascadeInterruptResult('parent', request.eventId),
      ).toEqual(outcomes[0]);
    } finally {
      reopened.close();
    }
  } finally {
    await service.shutdown();
    store.close();
  }
});

test.each(['idle', 'completed'] as const)(
  'parent summaries remain running until the owned child stop settles (own %s)',
  async (ownState) => {
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
      return {
        lifecycle: [
          detail?.session.lifecycleState,
          listed?.lifecycleState,
          page?.session.lifecycleState,
        ],
        ownedState: detail?.session.ownedWork?.state,
      };
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
      expect(await readStates()).toEqual({
        lifecycle: ['running', 'running', 'running'],
        ownedState: 'running',
      });
      if (ownState === 'completed') {
        await service.sessionLifecycles.transition({
          threadId: 'parent',
          authority: INTERNAL_SESSION_READ_SCOPE,
          to: 'completed',
        });
        await expect(
          service.sessionLifecycles.transition({
            threadId: 'parent',
            authority: INTERNAL_SESSION_READ_SCOPE,
            to: 'completed',
          }),
        ).rejects.toThrow(/completed/);
        await expect(
          service.dispatch({
            type: 'sendTurn',
            input: {
              threadId: 'parent',
              input: 'must not invoke a completed parent',
              clientTurnId: 'completed-parent-guard',
            },
          }),
        ).rejects.toThrow(/complete|ended/i);
      }
      expect(
        (await service.readSession('parent', INTERNAL_SESSION_READ_SCOPE))
          ?.session.ownedWork?.ownLifecycleState,
      ).toBe(ownState);
      stop = service.dispatch({ type: 'stopSession', threadId: 'parent' });
      await stoppingChild;
      expect(running.has('child')).toBe(true);
      expect(await readStates()).toEqual({
        lifecycle: ['running', 'running', 'running'],
        ownedState: 'stopping',
      });
      release();
      await stop;
      expect(running.has('child')).toBe(false);
      expect(await readStates()).toEqual({
        lifecycle: [ownState, ownState, ownState],
        ownedState: undefined,
      });
    } finally {
      release();
      await stop;
      await service.shutdown();
      store.close();
    }
  },
);

test('Stop traverses verified descendants bottom-up and excludes claimed and background boundaries', async () => {
  const path = join(makeTempDir('cascade-tree-'), 'events.sqlite');
  const store = new EventStore(path);
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
    await service.dispatch({ type: 'stopSession', threadId: 'parent' });
    expect(order).toEqual(['grandchild', 'child', 'parent']);
    const reopened = new EventStore(path);
    try {
      const nextParentTurn = reopened
        .sessionTurnBoundaryAuthority()
        .claim('parent', '2026-01-01T00:00:02.000Z');
      expect(nextParentTurn.kind).toBe('owner');
      if (nextParentTurn.kind !== 'owner')
        throw new Error('Root admission remained fenced');
      nextParentTurn.claim.notInvoked();
      expect(
        reopened
          .sessionTurnBoundaryAuthority()
          .claim('child', '2026-01-01T00:00:02.000Z').kind,
      ).not.toBe('owner');
    } finally {
      reopened.close();
    }
    store.deleteThread('parent');
    expect(store.ownedDescendantsBottomUp('parent')).toEqual([]);
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
      expect(() => store.deleteThread('parent')).toThrow(
        'pending ownership cleanup',
      );
      expect(store.eventById('parent', 'terminal')?.payload.method).toBe(
        'session.exited',
      );
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
