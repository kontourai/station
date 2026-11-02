import { join } from 'node:path';
import { STEERING_ENGINE_DURABILITY } from '@kontourai/station-contracts/engine-capability-matrix';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
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

async function fixture(
  mode: 'unknown' | 'finished' | 'held' = 'unknown',
  bind = true,
) {
  const path = join(makeTempDir('cascade-control-gaps-'), 'events.sqlite');
  const store = new EventStore(path, undefined, {
    exact: () => ({ pid: process.pid, start: 'control-gap-owner' }),
    probe: () => ({ state: 'unavailable' }),
  });
  const adapter: ProviderAdapterShape = new GateTestAdapter();
  adapter.metadata.durability = STEERING_ENGINE_DURABILITY;
  const running = new Set(mode === 'held' ? ['parent', 'child'] : ['parent']);
  vi.spyOn(adapter, 'hasSession').mockImplementation(async (id) =>
    running.has(id),
  );
  vi.spyOn(adapter, 'listSessions').mockImplementation(async () =>
    store.readSessions().filter((row) => running.has(row.threadId)),
  );
  const stop = vi
    .spyOn(adapter, 'stopSession')
    .mockImplementation(async (id) => {
      running.delete(id);
    });
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: new EventBus(),
    idleSessionParkAfterMs: 0,
    logger: { debug() {}, warn() {} },
  });
  if (bind)
    store.bindSessionActivity((id) => service.hasLocalSessionBinding(id));
  service.initialize();
  await awaitSessionRecoveryCompleted(service);
  for (const id of ['parent', 'child']) {
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
          : { userId: 'owner', agentSlug: 'claude', conversationId: 'parent' },
    });
    if (id === 'parent' || mode === 'held')
      service.seedSessionRecord({
        threadId: id,
        provider: 'claude',
        status: 'running',
      });
  }
  if (mode === 'finished')
    store.appendEvent({
      eventId: 'child-exit',
      threadId: 'child',
      sessionId: 'child',
      provider: 'claude',
      method: 'session.exited',
      reason: 'completed',
      createdAt: '2026-01-01T00:00:04.000Z',
    });
  return {
    path,
    store,
    service,
    running,
    stop,
    close: async () => {
      await service.shutdown();
      store.close();
    },
  };
}
test('an unbound store cannot assume a terminal child has no local binding', async () => {
  const f = await fixture('finished');
  const reader = new EventStore(f.path);
  try {
    expect(() => reader.deleteThread('parent')).toThrow();
    expect(reader.readSessionByThread('parent')).toBeDefined();
    reader.bindSessionActivity(() => false);
    expect(() => reader.deleteThread('parent')).not.toThrow();
  } finally {
    reader.close();
    await f.close();
  }
});

test('service refuses release without explicit confirmation before changing cleanup', async () => {
  const f = await fixture('unknown');
  try {
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    await expect(
      Reflect.apply(f.service.dispatch, f.service, [
        {
          type: 'releaseUnknownOwnedWork',
          threadId: 'parent',
        },
      ]),
    ).rejects.toThrow('Confirm that child processes may still be running');
    expect(f.store.pendingCascadeStops()).toHaveLength(1);
    expect(f.store.readSessionByThread('parent')).toBeDefined();
  } finally {
    await f.close();
  }
});

test('release refuses stale unknown custody when the recheck budget cannot reach it', async () => {
  const f = await fixture('unknown');
  try {
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    for (let i = 0; i < 129; i++) {
      const id = `backlog-${i}`;
      f.store.appendEvent({
        eventId: `${id}-start`,
        threadId: id,
        sessionId: id,
        provider: 'claude',
        method: 'session.started',
        createdAt: '2026-01-01T00:00:00Z',
      });
      f.store['db']
        .prepare(`INSERT INTO orchestration_cascade_stop_intents
        VALUES ('backlog', ?, ?, 'pending')`)
        .run(id, `${id}-stop`);
      f.store.recordCascadeStopCustody(
        id,
        `${id}-stop`,
        'unknown',
        'no-session-owner',
      );
      f.store['db']
        .prepare(
          "UPDATE orchestration_cascade_stop_custody SET evidence_json = json_set(evidence_json, '$.probedAt', 1) WHERE child_session_id = ?",
        )
        .run(id);
    }
    await expect(
      f.service.dispatch({
        type: 'releaseUnknownOwnedWork',
        threadId: 'parent',
        confirmation: 'child-process-may-still-be-running',
      }),
    ).rejects.toThrow('Station is still checking child cleanup');
    expect(f.store.pendingCascadeStops({ childId: 'child' })).toHaveLength(1);
    expect(f.store.readSessionByThread('parent')).toBeDefined();
  } finally {
    await f.close();
  }
});

test('an unbound service probes and stops a locally held terminal child', async () => {
  const f = await fixture('held', false);
  try {
    f.store.appendEvent({
      eventId: 'child-exit',
      threadId: 'child',
      sessionId: 'child',
      provider: 'claude',
      method: 'session.exited',
      reason: 'completed',
      createdAt: '2026-01-01T00:00:04.000Z',
    });
    await f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
    expect(f.stop).toHaveBeenCalledWith('child');
    expect(f.running.has('child')).toBe(false);
    expect(f.store.pendingCascadeStops()).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(['idle', 'completed'] as const)(
  'event-window and history preserve owned activity until cleanup settles (own %s)',
  async (ownState) => {
    const f = await fixture('held');
    f.service.seedSessionRecord({
      threadId: 'parent',
      provider: 'claude',
      status: 'ready',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const stopping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.stop.mockImplementation(async (id) => {
      if (id === 'child') {
        entered();
        await gate;
      }
      f.running.delete(id);
    });
    let stop: ReturnType<OrchestrationService['dispatch']> | undefined;
    const read = async () => {
      const window = await f.service.readSessionEventWindow('parent', {
        turnLimit: 2,
        authority: INTERNAL_SESSION_READ_SCOPE,
      });
      const history = await f.service.listConversationHistoryPage(
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
        { limit: 20 },
      );
      expect(window?.session.durability).toEqual(STEERING_ENGINE_DURABILITY);
      return {
        window: window?.session.lifecycleState,
        owned: window?.session.ownedWork?.state,
        history: history.items.find((item) => item.id === 'parent')
          ?.lifecycleState,
      };
    };
    try {
      f.store.appendEvent({
        eventId: 'parent-turn',
        threadId: 'parent',
        provider: 'claude',
        method: 'turn.started',
        turnId: 'turn',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      f.store.appendEvent({
        eventId: 'parent-done',
        threadId: 'parent',
        provider: 'claude',
        method: 'turn.completed',
        turnId: 'turn',
        finishReason: 'stop',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      if (ownState === 'completed')
        await f.service.sessionLifecycles.transition({
          threadId: 'parent',
          authority: INTERNAL_SESSION_READ_SCOPE,
          to: 'completed',
        });
      expect(await read()).toEqual({
        window: 'running',
        owned: 'running',
        history: 'running',
      });
      stop = f.service.dispatch({ type: 'stopSession', threadId: 'parent' });
      await stopping;
      expect(await read()).toEqual({
        window: 'running',
        owned: 'stopping',
        history: 'running',
      });
      release();
      await stop;
      expect(await read()).toEqual({
        window: ownState,
        owned: undefined,
        history: ownState,
      });
    } finally {
      release();
      await stop;
      await f.close();
    }
  },
);
