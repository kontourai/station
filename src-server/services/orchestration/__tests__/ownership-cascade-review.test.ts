import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { awaitSessionRecoveryCompleted } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

async function fixture(
  mode: 'finished' | 'unknown' | 'self' | 'self-finished' | 'held',
) {
  const store = new EventStore(
    join(makeTempDir('cascade-review-'), 'events.sqlite'),
    undefined,
    {
      exact: () => ({ pid: process.pid, start: 'self-birth' }),
      probe: () => ({
        state: 'exact',
        identity: { pid: process.pid, start: 'self-birth' },
      }),
    },
  );
  const adapter: ProviderAdapterShape = new GateTestAdapter();
  const running = new Set(mode === 'held' ? ['parent', 'child'] : ['parent']);
  const stop = vi
    .spyOn(adapter, 'stopSession')
    .mockImplementation(async (id) => {
      running.delete(id);
    });
  vi.spyOn(adapter, 'hasSession').mockImplementation(async (id) =>
    running.has(id),
  );
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    idleSessionParkAfterMs: 0,
    logger: { debug() {}, warn() {} },
  });
  service.initialize();
  await awaitSessionRecoveryCompleted(service);
  for (const id of ['parent', 'child'])
    store.appendEvent({
      eventId: `${id}-start`,
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
          : { userId: 'owner' },
    });
  service.seedSessionRecord({
    threadId: 'parent',
    provider: 'claude',
    status: 'running',
  });
  if (mode === 'held')
    service.seedSessionRecord({
      threadId: 'child',
      provider: 'claude',
      status: 'running',
    });
  if (mode.startsWith('self')) {
    const admission = store
      .sessionTurnBoundaryAuthority()
      .claim('child', '2026-01-01T00:00:01.000Z');
    if (admission.kind !== 'owner') throw new Error('Child preparation failed');
    expect(
      admission.claim.beginInvocation('2026-01-01T00:00:02.000Z').kind,
    ).toBe('applied');
    expect(
      admission.claim.accepted('child-turn', '2026-01-01T00:00:03.000Z').kind,
    ).toBe('applied');
  }
  if (mode === 'finished' || mode === 'self-finished')
    store.appendEvent({
      eventId: 'child-exit',
      threadId: 'child',
      sessionId: 'child',
      provider: 'claude',
      method: 'session.exited',
      reason: 'completed',
      createdAt: '2026-01-01T00:00:04.000Z',
    });
  const app = new Hono().route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus: new EventBus(),
      logger: { debug() {} },
      getUserId: () => 'owner',
    }),
  );
  return {
    app,
    adapter,
    store,
    service,
    stop,
    running,
    close: async () => {
      await service.shutdown();
      store.close();
    },
  };
}

test.each(['finished', 'self-finished'] as const)(
  'a parent Stop completes for a terminal unbound child: %s',
  async (mode) => {
    const f = await fixture(mode);
    try {
      await expect(
        f.service.dispatch({ type: 'stopSession', threadId: 'parent' }),
      ).resolves.toBeUndefined();
      expect(f.stop).toHaveBeenCalledExactlyOnceWith('parent');
      expect(f.store.pendingCascadeStops()).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  'a terminal unbound child permits parent deletion, including pending cleanup: %s',
  async (pending) => {
    const f = await fixture(pending ? 'unknown' : 'finished');
    try {
      if (pending) {
        await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
        expect(f.store.pendingCascadeStops()).toHaveLength(1);
        f.store.appendEvent({
          eventId: 'child-exit',
          threadId: 'child',
          sessionId: 'child',
          provider: 'claude',
          method: 'session.exited',
          reason: 'completed',
          createdAt: '2026-01-01T00:00:04.000Z',
        });
      }
      expect(() => f.store.deleteThread('parent')).not.toThrow();
      expect(f.store.readSessionByThread('parent')).toBeUndefined();
      expect(f.store.eventById('child', 'child-exit')?.payload.method).toBe(
        'session.exited',
      );
    } finally {
      await f.close();
    }
  },
);

test.each(['unknown', 'self'] as const)(
  'unknown cleanup stays visible while the parent stops itself: %s',
  async (mode) => {
    const f = await fixture(mode);
    try {
      if (mode === 'self')
        expect(f.store.cascadeStopOwner('child', false).custody).toBe('local');
      await expect(
        f.service.dispatch({ type: 'stopSession', threadId: 'parent' }),
      ).resolves.toBeUndefined();
      expect(f.stop).toHaveBeenCalledExactlyOnceWith('parent');
      expect(f.store.pendingCascadeStops()).toEqual([
        expect.objectContaining({ childId: 'child' }),
      ]);
      const response = await f.app.request(
        '/api/orchestration/sessions/parent',
      );
      expect(response.status).toBe(200);
      const summary = await response.json();
      expect(summary).toMatchObject({
        data: {
          session: {
            ownedWork: {
              pendingStopCount: 1,
              pendingStops: [
                expect.objectContaining({ custody: 'unknown', count: 1 }),
              ],
              state: 'unknown',
            },
          },
        },
      });
      expect(() => f.store.deleteThread('parent')).toThrow(
        'pending ownership cleanup',
      );
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  'shutdown drains a pending cascade before adapter teardown, including retirement: %s',
  async (retiring) => {
    const f = await fixture('held');
    let entered!: () => void;
    const stopping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.stop.mockImplementation(async (id) => {
      if (id === 'child') {
        entered();
        await gate;
      }
      f.running.delete(id);
    });
    let finishRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    const stopAll = vi.spyOn(f.adapter, 'stopAll');
    if (retiring) stopAll.mockImplementationOnce(() => retirement);
    const stop = f.service.dispatch({
      type: 'stopSession',
      threadId: 'parent',
    });
    let shutdown: Promise<void> | undefined;
    try {
      await stopping;
      if (retiring) {
        f.service['adapterRetirement'].retire(f.adapter);
        await vi.waitFor(() => expect(stopAll).toHaveBeenCalledOnce());
      }
      shutdown = f.service.shutdown();
      finishRetirement();
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopAll).toHaveBeenCalledTimes(retiring ? 1 : 0);
      release();
      await stop;
      await shutdown;
      expect(stopAll).toHaveBeenCalledOnce();
    } finally {
      release();
      finishRetirement();
      await stop;
      await shutdown;
      f.store.close();
    }
  },
);
